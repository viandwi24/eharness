/**
 * Tracker (demo): Hono server with an MCP endpoint (Streamable HTTP, JSON responses) at /mcp, a
 * plain JSON state for assertions at GET /state, and POST /reset. TEST FIXTURE of the team e2e plan.
 *
 *   PORT (default 4991)   TRACKER_TZ (default Asia/Jakarta)   TRACKER_TODAY (YYYY-MM-DD override)
 *
 * The MCP side is a minimal hand-written JSON-RPC handler (initialize, ping, tools/list,
 * tools/call): it needs no SDK and works with `@ai-sdk/mcp`'s HTTP transport.
 * Negative scenarios (Tracker down) simply stop the process.
 */
import { Hono } from 'hono'
import { PRIORITIES, STATUSES, Store } from './store.ts'

export const store = new Store()

interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: Record<string, boolean | string>
  run: (
    args: Record<string, unknown>,
  ) => { ok: true; value: unknown } | { ok: false; error: string }
}

const str = (d: string): Record<string, unknown> => ({ type: 'string', description: d })
const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}
const ACTOR = 'agent'
const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    title: 'List projects',
    description:
      'List all projects with id, name, description and the number of open (not done) tasks.',
    inputSchema: obj({}),
    annotations: { title: 'List projects', ...READ },
    run: () => ({
      ok: true,
      value: store.projects.map((p) => ({
        ...p,
        openTasks: store.tasks.filter((t) => t.projectId === p.id && t.status !== 'done').length,
      })),
    }),
  },
  {
    name: 'list_people',
    title: 'List people',
    description:
      'List the people of the team with id, name, role and e-mail. Use the id as assignee.',
    inputSchema: obj({}),
    annotations: { title: 'List people', ...READ },
    run: () => ({ ok: true, value: store.people }),
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description:
      'List tasks, optionally filtered. All filters combine with AND. Returns id, title, project, assignee, status, priority, due date and labels (no comments; use get_task for those).',
    inputSchema: obj({
      project: str('Project id (see list_projects).'),
      assignee: str('Person id or name (see list_people).'),
      status: { type: 'string', enum: [...STATUSES], description: 'Only tasks in this status.' },
      due_before: str('YYYY-MM-DD. Only tasks with a due date strictly before this day.'),
      label: str('Only tasks carrying this label.'),
    }),
    annotations: { title: 'List tasks', ...READ },
    run: (a) => {
      const status = s(a.status)
      if (status !== undefined && !(STATUSES as readonly string[]).includes(status))
        return {
          ok: false,
          error: `Invalid status "${status}". Use one of: ${STATUSES.join(', ')}.`,
        }
      const dueBefore = s(a.due_before)
      if (dueBefore !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dueBefore))
        return { ok: false, error: `Invalid due_before "${dueBefore}". Use YYYY-MM-DD.` }
      const tasks = store.listTasks({
        ...(s(a.project) === undefined ? {} : { project: s(a.project) as string }),
        ...(s(a.assignee) === undefined ? {} : { assignee: s(a.assignee) as string }),
        ...(status === undefined ? {} : { status: status as (typeof STATUSES)[number] }),
        ...(dueBefore === undefined ? {} : { dueBefore }),
        ...(s(a.label) === undefined ? {} : { label: s(a.label) as string }),
      })
      return {
        ok: true,
        value: { today: store.today, count: tasks.length, tasks },
      }
    },
  },
  {
    name: 'get_task',
    title: 'Get task',
    description: 'Get one task with its full description and all its comments.',
    inputSchema: obj({ id: str('Task id, for example T-05.') }, ['id']),
    annotations: { title: 'Get task', ...READ },
    run: (a) => {
      const t = store.task(String(a.id ?? ''))
      if (t === undefined) return { ok: false, error: `Task ${String(a.id)} not found.` }
      return { ok: true, value: { ...t, comments: store.commentsOf(t.id) } }
    },
  },
  {
    name: 'overdue_report',
    title: 'Overdue report',
    description:
      'Report of all open (not done) tasks whose due date is before today, most overdue first, with the assignee and the number of days overdue.',
    inputSchema: obj({}),
    annotations: { title: 'Overdue report', ...READ },
    run: () => {
      const rows = store.overdue()
      return { ok: true, value: { today: store.today, count: rows.length, overdue: rows } }
    },
  },
  {
    name: 'create_task',
    title: 'Create task',
    description:
      'Create a task in a project. Status starts as todo. Returns the new task with its id. Visible to the whole team.',
    inputSchema: obj(
      {
        project: str('Project id (see list_projects).'),
        title: str('Short task title.'),
        description: str('What needs to be done.'),
        assignee: str('Person id (see list_people). Omit to leave unassigned.'),
        priority: { type: 'string', enum: [...PRIORITIES], description: 'Default medium.' },
        due: str('Due date, YYYY-MM-DD.'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels.' },
      },
      ['project', 'title'],
    ),
    annotations: { title: 'Create task', ...WRITE },
    run: (a) =>
      store.createTask(ACTOR, {
        project: String(a.project ?? ''),
        title: String(a.title ?? ''),
        ...(s(a.description) === undefined ? {} : { description: s(a.description) as string }),
        ...(s(a.assignee) === undefined ? {} : { assignee: s(a.assignee) as string }),
        ...(s(a.priority) === undefined ? {} : { priority: s(a.priority) as string }),
        ...(s(a.due) === undefined ? {} : { due: s(a.due) as string }),
        ...(Array.isArray(a.labels) ? { labels: a.labels.map(String) } : {}),
      }),
  },
  {
    name: 'update_task',
    title: 'Update task',
    description:
      'Update a task: status, assignee, priority, due date, title, description or labels. Only the given fields change. Use unassign=true to clear the assignee and clear_due=true to clear the due date.',
    inputSchema: obj(
      {
        id: str('Task id, for example T-05.'),
        status: { type: 'string', enum: [...STATUSES], description: 'New status.' },
        assignee: str('New assignee (person id).'),
        unassign: { type: 'boolean', description: 'Remove the assignee.' },
        priority: { type: 'string', enum: [...PRIORITIES], description: 'New priority.' },
        due: str('New due date, YYYY-MM-DD.'),
        clear_due: { type: 'boolean', description: 'Remove the due date.' },
        title: str('New title.'),
        description: str('New description.'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Replace all labels.' },
      },
      ['id'],
    ),
    annotations: { title: 'Update task', ...WRITE, idempotentHint: true },
    run: (a) =>
      store.updateTask(ACTOR, String(a.id ?? ''), {
        ...(s(a.status) === undefined ? {} : { status: s(a.status) as string }),
        ...(a.unassign === true
          ? { assignee: null }
          : s(a.assignee) === undefined
            ? {}
            : { assignee: s(a.assignee) as string }),
        ...(s(a.priority) === undefined ? {} : { priority: s(a.priority) as string }),
        ...(a.clear_due === true
          ? { due: null }
          : s(a.due) === undefined
            ? {}
            : { due: s(a.due) as string }),
        ...(s(a.title) === undefined ? {} : { title: s(a.title) as string }),
        ...(s(a.description) === undefined ? {} : { description: s(a.description) as string }),
        ...(Array.isArray(a.labels) ? { labels: a.labels.map(String) } : {}),
      }),
  },
  {
    name: 'add_comment',
    title: 'Add comment',
    description:
      'Add a comment to a task. People are notified by the Tracker, so keep it short and specific (reminders, feedback, questions).',
    inputSchema: obj({ id: str('Task id.'), text: str('The comment text.') }, ['id', 'text']),
    annotations: { title: 'Add comment', ...WRITE },
    run: (a) => store.addComment(ACTOR, String(a.id ?? ''), String(a.text ?? '')),
  },
  {
    name: 'delete_task',
    title: 'Delete task',
    description: 'Permanently delete a task and its comments. Cannot be undone.',
    inputSchema: obj({ id: str('Task id.') }, ['id']),
    annotations: {
      title: 'Delete task',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (a) => store.deleteTask(ACTOR, String(a.id ?? '')),
  },
]

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function handle(req: RpcRequest): Record<string, unknown> | undefined {
  const id = req.id
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result })
  const err = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
  if (id === undefined || id === null) return undefined // notification
  switch (req.method) {
    case 'initialize':
      return ok({
        protocolVersion:
          typeof req.params?.protocolVersion === 'string'
            ? req.params.protocolVersion
            : '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tracker-demo', version: '1.0.0' },
        instructions:
          'Tracker (demo): a task tracker with projects, tasks, people and comments. Use list_* tools to read, create_task/update_task/add_comment to write.',
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations,
        })),
      })
    case 'tools/call': {
      const name = String(req.params?.name ?? '')
      const tool = TOOLS.find((t) => t.name === name)
      if (tool === undefined) return err(-32602, `Unknown tool: ${name}`)
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>
      const r = tool.run(args)
      return ok(
        r.ok
          ? { content: [{ type: 'text', text: JSON.stringify(r.value, null, 2) }] }
          : { isError: true, content: [{ type: 'text', text: `Error: ${r.error}` }] },
      )
    }
    default:
      return err(-32601, `Method not found: ${String(req.method)}`)
  }
}

export function createTrackerApp(): Hono {
  const app = new Hono()
  app.get('/', (c) =>
    c.json({
      name: 'Tracker (demo)',
      mcp: '/mcp',
      state: '/state',
      reset: 'POST /reset',
      note: 'test fixture',
    }),
  )
  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/state', (c) => c.json(store.snapshot()))
  app.post('/reset', (c) => {
    store.reset()
    return c.json({ ok: true, today: store.today })
  })
  // Streamable HTTP: POST carries JSON-RPC; no server-initiated stream (GET answers 405)
  app.get('/mcp', (c) => c.text('Method Not Allowed', 405))
  app.delete('/mcp', (c) => c.body(null, 200))
  app.post('/mcp', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        400,
      )
    }
    const items = Array.isArray(body) ? (body as RpcRequest[]) : [body as RpcRequest]
    const out = items.map(handle).filter((x): x is Record<string, unknown> => x !== undefined)
    if (out.length === 0) return c.body(null, 202)
    return c.json(Array.isArray(body) ? out : out[0])
  })
  return app
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4991)
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: createTrackerApp().fetch })
  console.log(
    `Tracker (demo) on http://127.0.0.1:${server.port}  (MCP: /mcp, state: /state, reset: POST /reset)`,
  )
}
