/**
 * Bun test preload (see `bunfig.toml`): a `W_INVARIANT_VIOLATION` raised by a session during a test
 * fails that test. The core only warns about broken session invariants (it must never break a
 * running session), so without this a violation scrolls by in the log of a green run.
 *
 * It also turns `debug.invariants` on for every agent defined in a test (the core never infers it
 * from `NODE_ENV`).
 *
 * Implementation: the module that checks the invariants at the end of a turn is wrapped; a problem
 * found by the session's own check (the call that skips the schema check) is recorded and the
 * `afterEach` below throws it. Direct calls from invariant tests are not recorded.
 */
import { afterEach, mock } from 'bun:test'

const recorded: string[] = []

const actual = await import('../src/session/invariants.ts')
// captured before mocking: Bun rewires the namespace object to the mock
const realCheck = actual.checkSessionInvariants
const realExports = { ...actual }

mock.module('../src/session/invariants.ts', () => ({
  ...realExports,
  checkSessionInvariants: async (...args: Parameters<typeof realCheck>) => {
    const problems = await realCheck(...args)
    const options = args[2]
    if (problems.length > 0 && options?.skipSchema === true && options.quiescent !== true) {
      recorded.push(...problems)
    }
    return problems
  },
}))

// `debug.invariants` is explicit-only (no NODE_ENV sniffing): every agent a test defines runs with
// it on unless the test sets `debug.invariants` itself.
const actualAgent = await import('../src/agent/define-agent.ts')
const realDefine = actualAgent.defineHarnessAgent
const agentExports = { ...actualAgent }
mock.module('../src/agent/define-agent.ts', () => ({
  ...agentExports,
  defineHarnessAgent: ((config: Parameters<typeof realDefine>[0]) =>
    realDefine({
      ...config,
      debug: { invariants: true, ...config.debug },
    } as typeof config)) as typeof realDefine,
}))

declare global {
  // eslint-disable-next-line no-var
  var allowInvariantViolation: ((pattern: RegExp) => void) | undefined
}

/** Tests that break an invariant on purpose call this (`allowInvariantViolation(/I3/)`); reset after each test. */
let allowed: RegExp[] = []
globalThis.allowInvariantViolation = (pattern: RegExp): void => {
  allowed.push(pattern)
}

afterEach(() => {
  const all = recorded.splice(0)
  const patterns = allowed
  allowed = []
  const problems = all.filter((p) => !patterns.some((re) => re.test(p)))
  if (problems.length === 0) return
  throw new Error(`W_INVARIANT_VIOLATION during the test:\n- ${problems.join('\n- ')}`)
})
