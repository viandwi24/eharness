/**
 * Scripts (docs/plans/P59-scripts-and-tables.md, ADR-0065): the shapes shared by the executor and
 * the features built on it. A script is TypeScript whose default export is
 * `async (event, ctx) => unknown`; it runs in QuickJS inside a Worker and reaches the system only
 * through `ctx`, whose methods are host calls checked by the caller. Pure.
 */

/** Limits of one run. */
export interface ScriptLimits {
  /** Heap of the QuickJS runtime. */
  memoryMb: number
  /** Time spent executing script code (waiting on host calls does not count). */
  cpuMs: number
  /** The whole run, host calls included; the Worker is terminated past it. */
  wallMs: number
  /** Host calls (`ctx.*`) one run may make. */
  maxHostCalls: number
  /** Log lines kept (`console.log`, `ctx.log`), and characters across them. */
  maxLogLines: number
  maxLogChars: number
  /** Characters of the JSON result and of one host call's arguments or answer. */
  maxValueChars: number
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  memoryMb: 64,
  cpuMs: 5_000,
  wallMs: 30_000,
  maxHostCalls: 200,
  maxLogLines: 200,
  maxLogChars: 20_000,
  maxValueChars: 100_000,
}

/** How a run ended. */
export type ScriptOutcome =
  /** The default export returned (or its promise resolved). */
  | 'ok'
  /** The script threw or its promise rejected, or it is not a valid script. */
  | 'error'
  /** CPU time ran out (an endless loop). */
  | 'cpu'
  /** The heap limit was hit. */
  | 'memory'
  /** The wall time ran out (waiting forever, a host call that never answered). */
  | 'timeout'
  /** Too many host calls. */
  | 'limit'

/** One `ctx.*` call as the run trace keeps it. */
export interface HostCallRecord {
  method: string
  args: unknown
  ok: boolean
  result?: unknown
  error?: string
  ms: number
  /** A dry run: the call was recorded, not performed. */
  dryRun?: boolean
}

export interface ScriptRunResult {
  outcome: ScriptOutcome
  /** The returned value (JSON), when `ok`. */
  result?: unknown
  /** A sentence, when not `ok`. */
  error?: string
  logs: string[]
  calls: HostCallRecord[]
  durationMs: number
  /** Time spent executing script code. */
  cpuMs: number
}

/** A host method a script may call, with the documentation the generated `scripts.d.ts` shows. */
export interface HostMethodDoc {
  /** Dotted name under `ctx` (`channels.send`). */
  name: string
  /** TypeScript type of the single argument (`{ chat: string; text: string }`), or `void`. */
  args: string
  /** TypeScript type of the answer (without the Promise). */
  returns: string
  /** One sentence. */
  doc: string
  /** Changes something outside the script (a dry run records it instead of doing it). */
  sideEffect: boolean
}

const METHOD = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){0,2}$/

/** Why a host method name is not usable, or undefined. */
export const hostMethodProblem = (name: string): string | undefined =>
  METHOD.test(name) ? undefined : `"${name}" is not a host method name (like channels.send)`

/** The `scripts.d.ts` an author (person or agent) writes against. */
export function scriptTypes(methods: readonly HostMethodDoc[]): string {
  // a tree of namespaces from the dotted names
  interface Node {
    children: Map<string, Node>
    method?: HostMethodDoc
  }
  const root: Node = { children: new Map() }
  for (const m of [...methods].sort((a, b) => a.name.localeCompare(b.name))) {
    let node = root
    for (const part of m.name.split('.')) {
      let next = node.children.get(part)
      if (next === undefined) {
        next = { children: new Map() }
        node.children.set(part, next)
      }
      node = next
    }
    node.method = m
  }
  const render = (node: Node, indent: string): string[] => {
    const out: string[] = []
    for (const [key, child] of node.children) {
      if (child.method !== undefined) {
        const m = child.method
        out.push(
          `${indent}/** ${m.doc}${m.sideEffect ? ' (recorded, not done, in a dry run)' : ''} */`,
        )
        out.push(
          `${indent}${key}(${m.args === 'void' ? '' : `input: ${m.args}`}): Promise<${m.returns}>`,
        )
      } else {
        out.push(`${indent}${key}: {`, ...render(child, `${indent}  `), `${indent}}`)
      }
    }
    return out
  }
  return [
    '/** What a script receives: its trigger event, and `ctx`, the only way to reach the system. */',
    'interface ScriptContext {',
    '  /** A line in the run trace (also `console.log`). */',
    '  log(...values: unknown[]): void',
    '  /** Wait (at most 10 seconds; counts toward the run time limit). */',
    '  sleep(ms: number): Promise<void>',
    ...render(root, '  '),
    '}',
    '',
    '/** A script: `export default async function (event, ctx) { ... }`. Imports are not allowed. */',
    'type Script = (event: Record<string, unknown>, ctx: ScriptContext) => unknown | Promise<unknown>',
    '',
  ].join('\n')
}
