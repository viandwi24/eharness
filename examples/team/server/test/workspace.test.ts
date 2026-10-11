/** M6 routes through `app.request()`: library, memory, settings and the task / context extras. */
import { afterEach, describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

function boot(models?: ModelConfig): Server {
  server = compose({
    dbFile: ':memory:',
    models:
      models ??
      ({
        provider: 'scripted',
        defaultModel: 'none',
        resolve: () => scriptedModel([{ text: 'hello from the task agent' }]) as never,
      } satisfies ModelConfig),
    tuning: { inbox: { pollMs: 30 }, abortPollMs: 40 },
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  return server
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const q = (params: Record<string, string>): string => new URLSearchParams(params).toString()
type Err = { error: { code: string; details?: { currentVersion?: string } } }

interface FileEntry {
  path: string
  version: string
  size: number
  mediaType: string | null
  binary: boolean
  createdBy: { slug: string } | null
}

describe('library', () => {
  test('write with ifVersion, conflicts, list with creator, read, versions, move, delete, events', async () => {
    const s = boot()
    const { app } = s
    const path = '/library/notes/todo.md'

    const created = await app.request(
      '/library/file',
      send('PUT', { path, content: 'one\n', ifVersion: null }),
    )
    expect(created.status).toBe(200)
    const v1 = ((await created.json()) as { version: string }).version
    const exists = await app.request(
      '/library/file',
      send('PUT', { path, content: 'x', ifVersion: null }),
    )
    expect(exists.status).toBe(409)
    expect(((await exists.json()) as Err).error.code).toBe('FILE_EXISTS')

    // an agent writes in between: the stale edit of the person loses and learns the current version
    const researcher = s.deps.agents.getBySlug('researcher')
    await libraryFs(s.conn.sqlite, { agentId: researcher?.id as string }).write(
      path,
      'agent edit\n',
    )
    const stale = await app.request(
      '/library/file',
      send('PUT', { path, content: 'two\n', ifVersion: v1 }),
    )
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as Err
    expect(body.error.code).toBe('VERSION_CONFLICT')
    const current = body.error.details?.currentVersion as string
    expect(current).not.toBe(v1)
    const ok = await app.request(
      '/library/file',
      send('PUT', { path, content: 'two\n', ifVersion: current }),
    )
    expect(ok.status).toBe(200)

    const list = (await (await app.request(`/library?${q({ prefix: '/library' })}`)).json()) as {
      files: FileEntry[]
    }
    expect(list.files.map((f) => f.path)).toEqual([path])
    expect(list.files[0]?.createdBy).toBeNull() // the first writer was a person
    await libraryFs(s.conn.sqlite, { agentId: researcher?.id as string }).write(
      '/library/a.md',
      'a',
    )
    const again = (await (await app.request('/library')).json()) as { files: FileEntry[] }
    expect(again.files.find((f) => f.path === '/library/a.md')?.createdBy?.slug).toBe('researcher')

    // a person saving over an agent's file becomes its author (it must not keep showing the agent)
    const agentPath = '/library/by-agent.md'
    const wrote = await libraryFs(s.conn.sqlite, { agentId: researcher?.id as string }).write(
      agentPath,
      'agent\n',
    )
    expect(wrote.ok).toBe(true)
    const agentVersion = wrote.ok ? wrote.version : ''
    const mine = await app.request(
      '/library/file',
      send('PUT', { path: agentPath, content: 'person\n', ifVersion: agentVersion }),
    )
    expect(mine.status).toBe(200)
    const after = (await (await app.request('/library')).json()) as { files: FileEntry[] }
    expect(after.files.find((f) => f.path === agentPath)?.createdBy).toBeNull()

    const read = (await (await app.request(`/library/file?${q({ path })}`)).json()) as {
      file: FileEntry
      content: string
    }
    expect(read.content).toBe('two\n')
    const raw = await app.request(`/library/file?${q({ path, raw: 'true' })}`)
    expect(raw.headers.get('content-disposition')).toStartWith('attachment')
    expect(await raw.text()).toBe('two\n')

    const versions = (await (await app.request(`/library/versions?${q({ path })}`)).json()) as {
      versions: Array<{ action: string; by: { slug: string } | null }>
    }
    expect(versions.versions.map((v) => v.by?.slug ?? 'user')).toEqual([
      'user',
      'researcher',
      'user',
    ])

    const moved = await app.request(
      '/library/move',
      send('POST', { from: path, to: '/library/notes/done.md' }),
    )
    expect(moved.status).toBe(200)
    expect((await app.request(`/library/file?${q({ path })}`)).status).toBe(404)
    const clash = await app.request(
      '/library/move',
      send('POST', { from: '/library/a.md', to: '/library/notes/done.md' }),
    )
    expect(clash.status).toBe(409)
    const del = await app.request(
      `/library/file?${q({ path: '/library/notes/done.md', ifVersion: 'nope' })}`,
      { method: 'DELETE' },
    )
    expect(del.status).toBe(409)
    expect(
      (
        await app.request(`/library/file?${q({ path: '/library/notes/done.md' })}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`/library/file?${q({ path: '/library/notes/done.md' })}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404)

    const feed = (await (await app.request('/activity?limit=200')).json()) as {
      events: Array<{
        type: string
        agentId: string | null
        payload: { action: string; path: string; area: string }
      }>
    }
    const changes = feed.events.filter((e) => e.type === 'file-changed')
    expect(changes.map((e) => e.payload.action)).toContain('move')
    expect(changes.some((e) => e.agentId === null && e.payload.path === path)).toBe(true) // a person's write
    expect(changes.every((e) => e.payload.area === 'library')).toBe(true)
  })

  test('binary files download, paths are checked, memory is not reachable here', async () => {
    const s = boot()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    await libraryFs(s.conn.sqlite).writeBytes?.('/library/pic.png', png)
    const res = await s.app.request(`/library/file?${q({ path: '/library/pic.png' })}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toStartWith('attachment')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png)
    const inline = await s.app.request(
      `/library/file?${q({ path: '/library/pic.png', inline: 'true' })}`,
    )
    expect(inline.headers.get('content-disposition')).toStartWith('inline')

    for (const path of [
      '/library/../etc',
      'relative.md',
      '/library/a//b.md',
      '/memories/workspace/profile.md',
    ]) {
      const bad = await s.app.request('/library/file', send('PUT', { path, content: 'x' }))
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as Err).error.code).toBe('INVALID_PATH')
    }
    expect((await s.app.request(`/library?${q({ prefix: '/memories' })}`)).status).toBe(400)
    const big = await s.app.request(
      '/library/file',
      send('PUT', { path: '/library/big.txt', content: 'a'.repeat(1_000_001) }),
    )
    expect(big.status).toBe(400)
    expect(((await big.json()) as Err).error.code).toBe('FILE_TOO_LARGE')
    expect((await s.app.request(`/library?${q({ prefix: '/' })}`)).status).toBe(200)
  })
})

describe('memory', () => {
  test('workspace and agent memory files: list, read, write with ifVersion, delete', async () => {
    const s = boot()
    const { app } = s
    const lead = s.deps.agents.getBySlug('lead')

    const put = await app.request(
      `/memory/file?${q({ scope: 'workspace', path: 'profile.md' })}`,
      send('PUT', { content: '# Team\n', ifVersion: null }),
    )
    expect(put.status).toBe(200)
    const v1 = ((await put.json()) as { version: string }).version
    const mine = await app.request(
      `/memory/file?${q({ scope: 'agent', agentId: 'lead', path: 'notes/a.md' })}`,
      send('PUT', { content: 'agent note' }),
    )
    expect(mine.status).toBe(200)

    const ws = (await (await app.request(`/memory?${q({ scope: 'workspace' })}`)).json()) as {
      root: string
      files: Array<{ path: string }>
    }
    expect(ws.root).toBe('/memories/workspace')
    expect(ws.files.map((f) => f.path)).toEqual(['profile.md'])
    const ag = (await (
      await app.request(`/memory?${q({ scope: 'agent', agentId: 'lead' })}`)
    ).json()) as { agentId: string; files: Array<{ path: string }> }
    expect(ag.agentId).toBe(lead?.id as string)
    expect(ag.files.map((f) => f.path)).toEqual(['notes/a.md'])
    // other agents' memory is a different root
    const other = (await (
      await app.request(`/memory?${q({ scope: 'agent', agentId: 'writer' })}`)
    ).json()) as { files: unknown[] }
    expect(other.files).toEqual([])

    // an agent edits through the same files: the person's stale edit conflicts
    await libraryFs(s.conn.sqlite, { agentId: lead?.id as string }).write(
      '/memories/workspace/profile.md',
      '# Team (agent)\n',
    )
    const stale = await app.request(
      `/memory/file?${q({ scope: 'workspace', path: 'profile.md' })}`,
      send('PUT', { content: 'mine', ifVersion: v1 }),
    )
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as Err).error.code).toBe('VERSION_CONFLICT')
    const got = (await (
      await app.request(`/memory/file?${q({ scope: 'workspace', path: 'profile.md' })}`)
    ).json()) as { content: string }
    expect(got.content).toBe('# Team (agent)\n')

    expect(
      (await app.request(`/memory/file?${q({ scope: 'workspace', path: '../x.md' })}`)).status,
    ).toBe(400)
    expect((await app.request(`/memory/file?${q({ scope: 'agent', path: 'x.md' })}`)).status).toBe(
      400,
    )
    expect(
      (await app.request(`/memory/file?${q({ scope: 'agent', agentId: 'nope', path: 'x.md' })}`))
        .status,
    ).toBe(404)
    expect(
      (await app.request(`/memory/file?${q({ scope: 'workspace', path: 'missing.md' })}`)).status,
    ).toBe(404)
    expect(
      (
        await app.request(`/memory/file?${q({ scope: 'workspace', path: 'profile.md' })}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`/memory/file?${q({ scope: 'workspace', path: 'profile.md' })}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404)
  })
})

describe('settings', () => {
  test('patch is stored, validated, applied to the ledger and read by the factory', async () => {
    const asked: Array<string | null> = []
    const s = boot({
      provider: 'scripted',
      defaultModel: 'none',
      resolve: (id) => {
        asked.push(id)
        return scriptedModel([{ text: 'x' }]) as never
      },
    })
    const { app } = s
    const initial = (await (await app.request('/settings')).json()) as Record<string, unknown>
    expect(initial).toMatchObject({
      defaultPermissionMode: 'default',
      budgetUsd: null,
      spawnCap: 4,
      defaultModel: null,
      updatedAt: 0,
    })

    const writer = s.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    await s.factory.prepare(writer)
    s.factory.agentFor(writer)
    expect(asked.at(-1)).toBeNull() // no model of its own, no workspace default

    const patched = await app.request(
      '/settings',
      send('PATCH', {
        budgetUsd: 12.5,
        spawnCap: 2,
        defaultModel: 'acme/m-1',
        defaultPermissionMode: 'bypassPermissions',
      }),
    )
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({
      budgetUsd: 12.5,
      spawnCap: 2,
      defaultModel: 'acme/m-1',
      defaultPermissionMode: 'bypassPermissions',
    })
    expect(
      ((await (await app.request('/settings')).json()) as { updatedAt: number }).updatedAt,
    ).toBeGreaterThan(0)

    const limit = s.conn.sqlite
      .query<{ limit_usd: string | null }, [string]>(
        'SELECT limit_usd FROM eh_budget_scope WHERE scope = ?',
      )
      .get('workspace:default')
    expect(Number(limit?.limit_usd)).toBe(12.5)
    s.factory.agentFor(writer) // the settings revision is part of the cache key: rebuilt
    expect(asked.at(-1)).toBe('acme/m-1')

    expect((await app.request('/settings', send('PATCH', { spawnCap: 0 }))).status).toBe(400)
    expect(
      (await app.request('/settings', send('PATCH', { defaultPermissionMode: 'root' }))).status,
    ).toBe(400)
    const cleared = await app.request(
      '/settings',
      send('PATCH', { budgetUsd: null, defaultModel: null }),
    )
    expect(await cleared.json()).toMatchObject({ budgetUsd: null, defaultModel: null, spawnCap: 2 })
    const feed = (await (await app.request('/activity?limit=50')).json()) as {
      events: Array<{ type: string }>
    }
    expect(feed.events.filter((e) => e.type === 'settings-changed')).toHaveLength(2)
  })
})

describe('tasks: abort, messages, agent context', () => {
  function task(s: Server, agentSlug: string, sessionId: string) {
    const agent = s.deps.agents.getBySlug(agentSlug)
    const store = s.deps.tasks as unknown as { ensure(t: unknown): { id: string } }
    return store.ensure({
      agentId: agent?.id,
      sessionId,
      parentSessionId: null,
      origin: 'routine',
      title: 'A task',
      startedAt: Date.now(),
    })
  }

  test('a message goes into the task session through the inbox; abort of an idle task is idle', async () => {
    const s = boot()
    const t = task(s, 'researcher', 'routine:r:1')
    const abort = await s.app.request(
      '/sessions/routine:r:1/interrupt',
      send('POST', { reason: 'enough' }),
    )
    expect(abort.status).toBe(200)
    expect(await abort.json()).toEqual({ target: 'idle' })

    const sent = await s.app.request(
      `/tasks/${t.id}/messages`,
      send('POST', { text: 'Please continue', mode: 'queue' }),
    )
    expect(sent.status).toBe(202)
    expect(await sent.json()).toMatchObject({ taskId: t.id, mode: 'queue', target: 'local' })
    const start = Date.now()
    for (;;) {
      const messages = await s.factory.peek('routine:r:1').messages()
      if (messages.some((m) => m.role === 'assistant')) {
        expect(JSON.stringify(messages)).toContain('Please continue')
        break
      }
      if (Date.now() - start > 4000) throw new Error('the task agent never answered')
      await new Promise((r) => setTimeout(r, 20))
    }
    const detail = (await (await s.app.request(`/tasks/${t.id}`)).json()) as { messages: unknown[] }
    expect(detail.messages.length).toBe(2)

    expect((await s.app.request('/sessions/nope/interrupt', { method: 'POST' })).status).toBe(404)
    expect(
      (await s.app.request(`/tasks/${t.id}/messages`, send('POST', { text: '   ' }))).status,
    ).toBe(400)
  })

  test('GET /agents/{id}/context bundles stats, tools, memory, routines, tasks and files', async () => {
    const s = boot()
    const researcher = s.deps.agents.getBySlug('researcher')
    await libraryFs(s.conn.sqlite, { agentId: researcher?.id as string }).write(
      '/library/r.md',
      'r',
    )
    await libraryFs(s.conn.sqlite).write('/memories/workspace/profile.md', 'p')
    await s.app.request(
      '/routines',
      send('POST', {
        agentId: 'researcher',
        name: 'R',
        prompt: 'p',
        schedule: { kind: 'every', everyMs: 60_000 },
      }),
    )
    task(s, 'researcher', 'routine:r:2')

    const res = await s.app.request('/agents/researcher/context')
    expect(res.status).toBe(200)
    const ctx = (await res.json()) as {
      agent: { slug: string }
      stats: { usage: { turns: number }; context: { window: number } }
      tools: Array<{ name: string; source: string }>
      memory: { workspace: Array<{ path: string }>; agent: unknown[] }
      routines: unknown[]
      tasks: { owned: unknown[] }
      files: Array<{ path: string }>
    }
    expect(ctx.agent.slug).toBe('researcher')
    expect(ctx.stats.usage.turns).toBe(0)
    expect(ctx.stats.context.window).toBeGreaterThan(0)
    expect(ctx.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['read_file', 'write_file']),
    )
    expect(ctx.memory.workspace.map((f) => f.path)).toEqual(['profile.md'])
    expect(ctx.routines).toHaveLength(1)
    expect(ctx.tasks.owned).toHaveLength(1)
    expect(ctx.files.map((f) => f.path)).toEqual(['/library/r.md'])
    expect((await s.app.request('/agents/nope/context')).status).toBe(404)
  })

  test('the new routes are in the OpenAPI document', async () => {
    const s = boot()
    const doc = (await (await s.app.request('/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/library',
        '/library/file',
        '/library/versions',
        '/library/move',
        '/memory',
        '/memory/file',
        '/settings',
        '/sessions/{id}/interrupt',
        '/tasks/{id}/messages',
        '/agents/{id}/context',
        '/routines',
        '/routines/{id}',
        '/routines/{id}/pause',
        '/routines/{id}/resume',
        '/routines/{id}/run',
        '/routines/{id}/runs',
      ]),
    )
  })
})
