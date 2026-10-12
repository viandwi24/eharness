/**
 * Tracker (demo): in-memory task store with a deterministic seed. TEST FIXTURE of the team e2e
 * plan (examples/team/e2e/SCENARIOS.md); not a product and not part of the library.
 *
 * Dates are offsets from "today" (day of the last reset, in the Tracker's timezone), so the seed
 * always has the same shape: T-01 and T-05 overdue, T-08 due today, the rest in the future.
 */

export const STATUSES = ['todo', 'in_progress', 'review', 'done', 'blocked'] as const
export type Status = (typeof STATUSES)[number]
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type Priority = (typeof PRIORITIES)[number]

export interface Person {
  id: string
  name: string
  role: string
  email: string
}
export interface Project {
  id: string
  name: string
  description: string
}
export interface Comment {
  id: string
  taskId: string
  author: string
  text: string
  at: string
}
export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  assignee: string | null
  status: Status
  priority: Priority
  due: string | null
  labels: string[]
  createdAt: string
  updatedAt: string
}
export interface Activity {
  seq: number
  at: string
  actor: string
  action: string
  taskId: string | null
  detail: string
}

export interface TaskFilter {
  project?: string
  assignee?: string
  status?: Status
  dueBefore?: string
  label?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const TZ = process.env.TRACKER_TZ ?? 'Asia/Jakarta'

/** YYYY-MM-DD of a date in the Tracker timezone. */
export function dayOf(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

export interface Snapshot {
  today: string
  people: Person[]
  projects: Project[]
  tasks: Task[]
  comments: Comment[]
  activity: Activity[]
}

export class Store {
  people: Person[] = []
  projects: Project[] = []
  tasks: Task[] = []
  comments: Comment[] = []
  activity: Activity[] = []
  today = ''
  private seq = 0
  private nextTask = 0
  private nextComment = 0

  constructor() {
    this.reset()
  }

  reset(): void {
    this.today = process.env.TRACKER_TODAY ?? dayOf(new Date())
    this.seq = 0
    this.activity = []
    this.people = [
      { id: 'ana', name: 'Ana Lestari', role: 'Product manager', email: 'ana@example.test' },
      { id: 'budi', name: 'Budi Santoso', role: 'Backend engineer', email: 'budi@example.test' },
      { id: 'citra', name: 'Citra Dewi', role: 'Designer', email: 'citra@example.test' },
      {
        id: 'dimas',
        name: 'Dimas Prasetyo',
        role: 'Frontend engineer',
        email: 'dimas@example.test',
      },
      { id: 'eka', name: 'Eka Wulandari', role: 'QA engineer', email: 'eka@example.test' },
      { id: 'fajar', name: 'Fajar Nugroho', role: 'Data analyst', email: 'fajar@example.test' },
    ]
    this.projects = [
      { id: 'web', name: 'Website Revamp', description: 'New marketing site and docs portal.' },
      { id: 'app', name: 'Mobile App v2', description: 'Second major release of the mobile app.' },
      { id: 'ops', name: 'Internal Ops', description: 'Process, tooling and reporting work.' },
    ]
    const t = (
      n: number,
      projectId: string,
      title: string,
      description: string,
      assignee: string | null,
      status: Status,
      priority: Priority,
      dueOffset: number | null,
      labels: string[],
    ): Task => ({
      id: `T-${String(n).padStart(2, '0')}`,
      projectId,
      title,
      description,
      assignee,
      status,
      priority,
      due: dueOffset === null ? null : addDays(this.today, dueOffset),
      labels,
      createdAt: `${addDays(this.today, -14)}T09:00:00Z`,
      updatedAt: `${addDays(this.today, -3)}T09:00:00Z`,
    })
    this.tasks = [
      t(
        1,
        'web',
        'Write homepage hero copy',
        'Headline, subhead and CTA for the new homepage.',
        'citra',
        'in_progress',
        'high',
        -3,
        ['copy', 'marketing'],
      ),
      t(
        2,
        'web',
        'Implement pricing page',
        'Three tiers, monthly/yearly toggle.',
        'dimas',
        'in_progress',
        'high',
        4,
        ['frontend'],
      ),
      t(
        3,
        'web',
        'Set up docs portal search',
        'Index the docs and add a search box.',
        'budi',
        'todo',
        'medium',
        10,
        ['backend', 'docs'],
      ),
      t(
        4,
        'web',
        'Review accessibility of the new header',
        'Keyboard navigation and contrast.',
        'eka',
        'review',
        'medium',
        2,
        ['qa', 'a11y'],
      ),
      t(
        5,
        'app',
        'Fix crash on login with expired session',
        'Crash reported by 12 users on Android.',
        'budi',
        'blocked',
        'urgent',
        -5,
        ['bug', 'backend'],
      ),
      t(
        6,
        'app',
        'Design onboarding flow',
        'Five screens, illustrations included.',
        'citra',
        'done',
        'medium',
        -7,
        ['design'],
      ),
      t(
        7,
        'app',
        'Push notification preferences screen',
        'Per-channel toggles.',
        'dimas',
        'todo',
        'medium',
        14,
        ['frontend'],
      ),
      t(
        8,
        'app',
        'Regression test pass for release 2.0',
        'Run the full regression checklist.',
        'eka',
        'in_progress',
        'high',
        0,
        ['qa', 'release'],
      ),
      t(
        9,
        'ops',
        'Weekly metrics report',
        'Active users, retention, tickets. Needs the CSV export.',
        'fajar',
        'todo',
        'medium',
        1,
        ['report', 'data'],
      ),
      t(
        10,
        'ops',
        'Clean up unused cloud resources',
        'List and remove idle instances and buckets.',
        null,
        'todo',
        'low',
        21,
        ['infra'],
      ),
      t(
        11,
        'ops',
        'Update the incident response runbook',
        'Add the new on-call rotation.',
        'ana',
        'done',
        'low',
        -10,
        ['docs'],
      ),
      t(
        12,
        'web',
        'Migrate blog posts to the new CMS',
        '42 posts, keep URLs stable.',
        null,
        'todo',
        'medium',
        7,
        ['content'],
      ),
    ]
    this.nextTask = this.tasks.length
    this.comments = [
      {
        id: 'C-01',
        taskId: 'T-05',
        author: 'budi',
        text: 'Waiting for the auth team to confirm the refresh-token behaviour.',
        at: `${addDays(this.today, -2)}T10:00:00Z`,
      },
      {
        id: 'C-02',
        taskId: 'T-06',
        author: 'citra',
        text: 'All five screens exported, ready for hand-off.',
        at: `${addDays(this.today, -8)}T15:00:00Z`,
      },
    ]
    this.nextComment = this.comments.length
  }

  private log(actor: string, action: string, taskId: string | null, detail: string): void {
    this.activity.push({
      seq: ++this.seq,
      at: new Date().toISOString(),
      actor,
      action,
      taskId,
      detail,
    })
  }

  person(id: string): Person | undefined {
    return this.people.find(
      (p) => p.id === id.toLowerCase() || p.name.toLowerCase() === id.toLowerCase(),
    )
  }

  task(id: string): Task | undefined {
    return this.tasks.find((x) => x.id.toLowerCase() === id.toLowerCase())
  }

  listTasks(f: TaskFilter): Task[] {
    return this.tasks.filter(
      (x) =>
        (f.project === undefined || x.projectId === f.project) &&
        (f.assignee === undefined || x.assignee === (this.person(f.assignee)?.id ?? f.assignee)) &&
        (f.status === undefined || x.status === f.status) &&
        (f.dueBefore === undefined || (x.due !== null && x.due < f.dueBefore)) &&
        (f.label === undefined || x.labels.includes(f.label)),
    )
  }

  private check(fields: {
    assignee?: string | null
    status?: string
    priority?: string
    due?: string | null
    project?: string
  }): Result<{ assignee?: string | null }> {
    let assignee: string | null | undefined
    if (fields.assignee !== undefined && fields.assignee !== null) {
      const p = this.person(fields.assignee)
      if (p === undefined)
        return {
          ok: false,
          error: `Unknown person "${fields.assignee}". Known ids: ${this.people.map((x) => x.id).join(', ')}.`,
        }
      assignee = p.id
    } else if (fields.assignee === null) assignee = null
    if (fields.status !== undefined && !(STATUSES as readonly string[]).includes(fields.status))
      return {
        ok: false,
        error: `Invalid status "${fields.status}". Use one of: ${STATUSES.join(', ')}.`,
      }
    if (
      fields.priority !== undefined &&
      !(PRIORITIES as readonly string[]).includes(fields.priority)
    )
      return {
        ok: false,
        error: `Invalid priority "${fields.priority}". Use one of: ${PRIORITIES.join(', ')}.`,
      }
    if (typeof fields.due === 'string' && !isDay(fields.due))
      return { ok: false, error: `Invalid due date "${fields.due}". Use YYYY-MM-DD.` }
    if (fields.project !== undefined && !this.projects.some((p) => p.id === fields.project))
      return {
        ok: false,
        error: `Unknown project "${fields.project}". Known ids: ${this.projects.map((x) => x.id).join(', ')}.`,
      }
    return { ok: true, value: assignee === undefined ? {} : { assignee } }
  }

  createTask(
    actor: string,
    a: {
      project: string
      title: string
      description?: string
      assignee?: string
      priority?: string
      due?: string
      labels?: string[]
    },
  ): Result<Task> {
    if (a.title.trim() === '') return { ok: false, error: 'title must not be empty.' }
    const c = this.check({
      assignee: a.assignee,
      priority: a.priority,
      due: a.due,
      project: a.project,
    })
    if (!c.ok) return c
    const now = new Date().toISOString()
    const task: Task = {
      id: `T-${String(++this.nextTask).padStart(2, '0')}`,
      projectId: a.project,
      title: a.title.trim(),
      description: a.description ?? '',
      assignee: c.value.assignee ?? null,
      status: 'todo',
      priority: (a.priority as Priority | undefined) ?? 'medium',
      due: a.due ?? null,
      labels: a.labels ?? [],
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.push(task)
    this.log(actor, 'task.created', task.id, `${task.title} (assignee ${task.assignee ?? 'none'})`)
    return { ok: true, value: task }
  }

  updateTask(
    actor: string,
    id: string,
    a: {
      status?: string
      assignee?: string | null
      priority?: string
      due?: string | null
      title?: string
      description?: string
      labels?: string[]
    },
  ): Result<Task> {
    const task = this.task(id)
    if (task === undefined) return { ok: false, error: `Task ${id} not found.` }
    const c = this.check({
      assignee: a.assignee,
      status: a.status,
      priority: a.priority,
      due: a.due,
    })
    if (!c.ok) return c
    const changes: string[] = []
    if (a.status !== undefined && a.status !== task.status) {
      changes.push(`status ${task.status} -> ${a.status}`)
      task.status = a.status as Status
    }
    if (c.value.assignee !== undefined && c.value.assignee !== task.assignee) {
      changes.push(`assignee ${task.assignee ?? 'none'} -> ${c.value.assignee ?? 'none'}`)
      task.assignee = c.value.assignee
    }
    if (a.priority !== undefined && a.priority !== task.priority) {
      changes.push(`priority ${task.priority} -> ${a.priority}`)
      task.priority = a.priority as Priority
    }
    if (a.due !== undefined && a.due !== task.due) {
      changes.push(`due ${task.due ?? 'none'} -> ${a.due ?? 'none'}`)
      task.due = a.due
    }
    if (a.title !== undefined && a.title !== task.title) {
      changes.push('title changed')
      task.title = a.title
    }
    if (a.description !== undefined && a.description !== task.description) {
      changes.push('description changed')
      task.description = a.description
    }
    if (a.labels !== undefined) {
      changes.push(`labels -> ${a.labels.join(',')}`)
      task.labels = a.labels
    }
    if (changes.length > 0) {
      task.updatedAt = new Date().toISOString()
      this.log(actor, 'task.updated', task.id, changes.join('; '))
    }
    return { ok: true, value: task }
  }

  deleteTask(actor: string, id: string): Result<Task> {
    const i = this.tasks.findIndex((x) => x.id.toLowerCase() === id.toLowerCase())
    if (i < 0) return { ok: false, error: `Task ${id} not found.` }
    const [task] = this.tasks.splice(i, 1)
    if (task === undefined) return { ok: false, error: `Task ${id} not found.` }
    this.comments = this.comments.filter((c) => c.taskId !== task.id)
    this.log(actor, 'task.deleted', task.id, task.title)
    return { ok: true, value: task }
  }

  addComment(actor: string, taskId: string, text: string): Result<Comment> {
    const task = this.task(taskId)
    if (task === undefined) return { ok: false, error: `Task ${taskId} not found.` }
    if (text.trim() === '') return { ok: false, error: 'text must not be empty.' }
    const c: Comment = {
      id: `C-${String(++this.nextComment).padStart(2, '0')}`,
      taskId: task.id,
      author: actor,
      text,
      at: new Date().toISOString(),
    }
    this.comments.push(c)
    this.log(actor, 'comment.added', task.id, text.slice(0, 120))
    return { ok: true, value: c }
  }

  commentsOf(taskId: string): Comment[] {
    return this.comments.filter((c) => c.taskId.toLowerCase() === taskId.toLowerCase())
  }

  /** Open tasks (not done) whose due date is before `today`, most overdue first. */
  overdue(): Array<Task & { daysOverdue: number }> {
    const ms = (d: string): number => Date.parse(`${d}T00:00:00Z`)
    return this.tasks
      .filter((x) => x.status !== 'done' && x.due !== null && x.due < this.today)
      .map((x) => ({
        ...x,
        daysOverdue: Math.round((ms(this.today) - ms(x.due as string)) / 86_400_000),
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue)
  }

  snapshot(): Snapshot {
    return structuredClone({
      today: this.today,
      people: this.people,
      projects: this.projects,
      tasks: this.tasks,
      comments: this.comments,
      activity: this.activity,
    })
  }
}
