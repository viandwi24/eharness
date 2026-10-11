# Integrate the team example into your own system

How to take the agent team of [`examples/team`](../../examples/team) (agents, programs, decision
center, chunked big-data work) and connect it to an existing company system that already has its
own users, roles, permissions and business logic — without writing that logic a second time.

Status: design guide for a small-scale trial before production. It builds on
[P40](../plans/P40-team-autonomous-operations.md) (decision D11) and uses only public eharness APIs.

## 1. The idea in one paragraph

Each agent becomes a **virtual user** (a bot account) of your system. It has a role, permissions
and a token like any employee, and it works through **the same API your web app uses**. Your
backend stays the only place where business rules, validation and access control live; eharness
turns your OpenAPI spec into tools (`openApiSource`), and the agent sees and calls only what its
role allows. Change the bot's role in your admin page and the agent's abilities change on its next
request.

```
                ┌──────────────────────── your system ────────────────────────┐
  employees ──▶ │  web app ──▶  API (Hono / Express)  ──▶ services ──▶ database │
                │                 ▲  auth · RBAC · validation · audit          │
                │                 │  (single gate, single source of truth)     │
                └─────────────────┼──────────────────────────────────────────────┘
                                  │ same endpoints, bot token
                ┌─────────────────┴──────── eharness team ─────────────────────┐
                │  agent (bot user)  ◀── tools from your OpenAPI spec          │
                │  programs · decision center · chunked work · run_code         │
                └──────────────────────────────────────────────────────────────┘
```

## 2. Identity: agents are bot users

| In your system | What to do |
|---|---|
| User record | One account per agent, marked `kind: 'bot'` (shown as a bot in your UI and audit log). |
| Role / department | Assign like an employee, least privilege first (start read-only). |
| Credential | A token per bot, revocable at any time (your kill switch). Prefer short-lived access tokens minted from a long-lived secret that only the eharness server holds; the model never sees either. |
| RBAC admin endpoints | Never granted to bots — an agent must not be able to change its own role. |

Roles and permissions are set **only in your system** (its user and department pages). eharness
keeps no copy, so there is nothing to sync and no drift.

## 3. What your backend should expose

Three small additions make the agent aware of its own permissions:

1. **`GET /me`** — the caller's roles, departments and permissions, e.g.
   `{ "id": "u_bot_clipper", "kind": "bot", "roles": ["clipper"], "permissions": ["clipper.video.read", "clipper.link.create"] }`.
   (If you want a standard shape, the OpenID AuthZEN Authorization API 1.0 search endpoints answer
   "what may this subject do".)
2. **`x-permission` on every operation** in your OpenAPI spec — the permission it requires:
   ```yaml
   /clipper/videos/{id}/links:
     post:
       operationId: createSocialLink
       summary: Record the social media link of a published clip
       x-permission: clipper.link.create
   ```
3. **A structured 403** — say what is missing so the agent can act on it:
   `403 { "error": { "code": "forbidden", "requiredPermission": "clipper.link.create", "message": "…" } }`.

Also recommended: rate limits per bot, idempotency keys on writes (agent retries must not create
duplicates), soft delete, and logging of the request headers `X-Agent-Id` / `X-Agent-Run` that
eharness sends (section 5.3), so every row in your audit log traces back to an agent run.

`summary` and `description` in the spec are the agent's manual — write them for a new colleague.

## 4. Two layers of authority

| Layer | Owner | Decides | Where |
|---|---|---|---|
| 1. Company RBAC | your admin | what this bot may ever do | your user / department pages |
| 2. Program authority | the client, once, in the decision center | what one program run may do | eharness programs (P40) |

The effective authority is the **intersection**: a program cannot grant what the bot's role does
not allow, and a broad role does not let a narrow program do more than it was approved for. Both
layers are enforced by code (your backend, the eharness permission engine), never by prompt text.

## 5. Calling your API from the agent

The tools come from your OpenAPI document through `openApiSource` (`eharness/openapi`). How the
request travels depends on where the agent runs.

### 5.1 Separate deployment (plain HTTP)

The eharness server calls your API over the network like any client. Use a staging URL first.

### 5.2 Same process, no network (Hono)

If eharness runs inside the same app, you do not need a real HTTP request. A Hono app is a
`fetch(Request) → Response` function, and `openApiSource` accepts a custom `fetch`: route the tool
calls straight into the app. The request still goes through **all** your middleware — auth, RBAC,
validation, logging — so nothing is bypassed and nothing is duplicated.

```ts
import { OpenAPIHono } from '@hono/zod-openapi' // yours: the app your web already uses
import { openApiSource } from 'eharness/openapi'

declare const app: OpenAPIHono // yours

// The spec comes from the same app (no hand-written copy that could drift).
const spec = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'Company', version: '1' } })

const companyApi = (token: () => Promise<string>, agentId: string) =>
  openApiSource({
    name: 'company',
    spec,
    // any absolute URL: it only builds the Request; `fetch` below never leaves the process
    baseUrl: 'http://company.internal',
    fetch: (input, init) => app.fetch(new Request(input, init)),
    headers: async (ctx) => ({
      authorization: `Bearer ${await token()}`,
      'x-agent-id': agentId,
      'x-agent-run': ctx.session.id,
    }),
  })
```

Call through the HTTP layer, not through your service functions directly: calling services would
skip the gate and you would end up re-implementing auth and validation for the agent.

### 5.3 Same process (Express)

Express has no `fetch` handler. Either listen on a private loopback port or a Unix socket and point
`baseUrl` there (with undici you can send `fetch` over a Unix socket), or put a small fetch-style
adapter in front of the router. Option 5.1 with `baseUrl: 'http://127.0.0.1:<port>'` is the
simplest and keeps every middleware in the path.

### 5.4 Only the tools the bot may use, refreshed every turn

Filter the operations by the bot's current permissions and rebuild the list every turn, so a role
change applies to the very next turn and the model never sees tools it cannot use:

```ts
import { defineToolSource, type HarnessContext } from 'eharness'
import { openApiSource } from 'eharness/openapi'

declare const spec: { paths: Record<string, Record<string, { 'x-permission'?: string }>> } // yours
declare function permissionsOf(agentId: string): Promise<Set<string>> // yours: GET /me, cached ~60 s, invalidated by a "role changed" webhook
declare function tokenFor(agentId: string): Promise<string> // yours: from the server's secret vault

export const companyTools = (agentId: string) =>
  defineToolSource({
    id: `company:${agentId}`,
    refresh: 'turn',
    list: async (ctx: HarnessContext) => {
      const allowed = await permissionsOf(agentId)
      const source = openApiSource({
        name: 'company',
        spec,
        baseUrl: 'https://company.staging.example', // yours
        include: (op) => {
          const needed = spec.paths[op.path]?.[op.method]?.['x-permission']
          return needed === undefined || allowed.has(needed)
        },
        headers: async () => ({ authorization: `Bearer ${await tokenFor(agentId)}` }),
      })
      return source.list(ctx)
    },
  })
```

Add a small `my_permissions` tool (it calls `GET /me`) so the agent can re-check what it may do
after a refusal. Write operations get `write` / `destructive` risk from their HTTP method, which the
program authority and approvals use.

### 5.5 When a call is refused

1. Your API answers the structured 403; the agent reads it as a tool result (no crash).
2. It re-checks with `my_permissions` and adapts its plan, or
3. it asks for the missing permission in the decision center (`escalate` / `request_authority`).
   An admin changes the bot's role in your system; the run resumes in the same session.

## 6. Serving the agents from the same app

`eharness/http` is a `fetch` handler too, so the agent endpoints (chat, sessions, approvals,
activity) can live in the same Hono app behind the same auth:

```ts
import { createHarnessHttp } from 'eharness/http'
import type { Hono } from 'hono'

declare const app: Hono // yours
declare const agent: Parameters<typeof createHarnessHttp>[0] // yours: defineHarnessAgent(...)
declare function currentUser(req: Request): Promise<{ id: string } | undefined> // yours

const harness = createHarnessHttp(agent, {
  basePath: '/agents',
  authorize: async ({ request }) => (await currentUser(request)) ?? { deny: 401 },
})
app.all('/agents/*', (c) => harness.fetch(c.req.raw))
```

## 7. Mapping the team example to your departments

| Your system | Team example |
|---|---|
| Department (Clipper, Video production) | an agent per repetitive function, with a role in your system |
| Manager / leader views (all tasks, analytics) | the manager agent: reads all tasks, proposes plans, creates tasks |
| Routine work ("submit links of new clips", "draft scripts for new ideas") | a **program** with a schedule and an authority |
| Decisions ("publish this?", "ban this member?") | the **decision center** |
| Large data (community chats, analytics exports) | **chunked work**: collector → manifest → `run_code` pre-filter → findings per chunk → merged report |

Example: a *Clipper* agent (bot role `clipper`) runs a daily program "record the links of clips
published yesterday": authority = `listVideos`, `createSocialLink`; forbidden = delete; budget
$1/day; report = digest. A *Production* agent (role `production`) moves items from *idea* to
*draft* by writing script drafts, but publishing to YouTube stays a gate (a decision).

## 8. Rollout plan

1. **Staging copy** of your system and **read-only bot roles**: reports and analytics only.
2. One program at a time, with a small budget and `report: 'task'` so every run is reviewed.
3. Open write permissions per program (layer 2) after a week of clean runs; keep destructive
   actions as gates.
4. Watch the audit log (`X-Agent-Id` / `X-Agent-Run`), `config.observe` metrics and the decision
   center. Revoke a bot token to stop an agent immediately.
5. Move to production with the same roles; the agents need no code change, only the base URL.

## 9. Checklist for your backend team

- [ ] Bot accounts (`kind: 'bot'`), one per agent, least-privilege roles, revocable tokens
- [ ] `GET /me` with roles and permissions
- [ ] `x-permission` on every operation; good `summary` / `description`
- [ ] Structured 403 with `requiredPermission`
- [ ] Rate limits for bots; idempotency keys on writes; soft delete
- [ ] Audit log records `X-Agent-Id` / `X-Agent-Run`
- [ ] No RBAC admin endpoints for bots
- [ ] Optional: a "role changed" webhook (cache invalidation) and domain events (program triggers)
