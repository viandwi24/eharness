/**
 * Rehearsal use cases (docs/plans/P40-team-autonomous-operations.md, phase K): test runs of a
 * program on sample data, and the program's saved test cases. The run itself is
 * `infra/eh/rehearsal-service.ts`; the rules are `domain/rehearsal.ts`.
 */
import { conflict, invalid, notFound } from '../domain/errors.ts'
import type { Program } from '../domain/programs.ts'
import {
  checkTestName,
  evaluateExpect,
  isStale,
  MAX_TEST_CASES,
  normalizeExpect,
  normalizeSample,
  programFingerprint,
  REHEARSAL_DEFAULT_BUDGET_USD,
  REHEARSAL_MAX_BUDGET_USD,
  type Rehearsal,
  type RehearsalFile,
  type RehearsalSample,
  summarizeTests,
  type TestCase,
  type TestExpect,
  type TestSummary,
} from '../domain/rehearsal.ts'
import type { Deps } from './ports.ts'
import { getProgram } from './programs.ts'

export interface StartRehearsalInput {
  sample?: Partial<RehearsalSample> | undefined
  /** Spend cap of this rehearsal (USD). Default 0.5, at most 5. */
  budgetUsd?: number | undefined
}

export function checkBudget(budgetUsd: number | undefined): number {
  if (budgetUsd === undefined) return REHEARSAL_DEFAULT_BUDGET_USD
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > REHEARSAL_MAX_BUDGET_USD) {
    throw invalid(
      `budgetUsd must be above 0 and at most ${REHEARSAL_MAX_BUDGET_USD}`,
      'INVALID_REHEARSAL',
    )
  }
  return budgetUsd
}

/** Start a rehearsal of the program as it is saved now; returns while it runs. */
export async function startRehearsal(
  deps: Deps,
  programId: string,
  input: StartRehearsalInput = {},
): Promise<Rehearsal> {
  const program = getProgram(deps, programId)
  return deps.rehearsalRunner.start(program, {
    sample: normalizeSample(input.sample),
    budgetUsd: checkBudget(input.budgetUsd),
  })
}

export function listRehearsals(deps: Deps, programId: string, limit = 30): Rehearsal[] {
  getProgram(deps, programId)
  return deps.rehearsals.list(programId, limit)
}

export function getRehearsal(deps: Deps, id: string): Rehearsal {
  const found = deps.rehearsals.get(id)
  if (found === undefined) throw notFound('rehearsal', id)
  return found
}

export function deleteRehearsal(deps: Deps, id: string): Rehearsal {
  const found = getRehearsal(deps, id)
  if (found.status === 'running') {
    throw conflict('the rehearsal is still running', 'REHEARSAL_BUSY')
  }
  deps.rehearsals.delete(id)
  return found
}

/** One produced file of a rehearsal. */
export function rehearsalFile(deps: Deps, id: string, path: string): RehearsalFile {
  const file = getRehearsal(deps, id).files.find((f) => f.path === path)
  if (file === undefined) throw notFound('rehearsal file', path)
  return file
}

export async function rehearsalMessages(deps: Deps, id: string): Promise<unknown[]> {
  return deps.rehearsalRunner.messages(getRehearsal(deps, id).sessionId)
}

// --- test cases ---------------------------------------------------------------------------------

/** A test case with whether its last result predates an edit that matters. */
export type TestCaseView = TestCase & { stale: boolean }

export interface TestList {
  cases: TestCaseView[]
  summary: TestSummary
}

export function listTests(deps: Deps, programId: string): TestList {
  const program = getProgram(deps, programId)
  const cases = deps.programTests.list(programId)
  const fingerprint = programFingerprint(program)
  return {
    cases: cases.map((c) => ({ ...c, stale: isStale(c.lastResult, fingerprint) })),
    summary: summarizeTests(cases, fingerprint),
  }
}

export interface CreateTestInput {
  name: string
  /** Save the sample of this rehearsal as the case (the case is judged against that run at once). */
  rehearsalId?: string | undefined
  sample?: Partial<RehearsalSample> | undefined
  expect?: Partial<TestExpect> | undefined
}

export function createTest(deps: Deps, programId: string, input: CreateTestInput): TestCase {
  const program = getProgram(deps, programId)
  const name = checkTestName(input.name)
  if (deps.programTests.list(programId).length >= MAX_TEST_CASES) {
    throw conflict(`a program has at most ${MAX_TEST_CASES} test cases`, 'TOO_MANY_TESTS')
  }
  const source = input.rehearsalId === undefined ? undefined : getRehearsal(deps, input.rehearsalId)
  if (source !== undefined && source.programId !== program.id) {
    throw invalid('that rehearsal belongs to another program', 'INVALID_TEST')
  }
  const sample = normalizeSample(source === undefined ? input.sample : source.sample)
  if (program.worker != null && sample.task === null) {
    throw invalid('a worker program needs a sample task in the test case', 'INVALID_TEST')
  }
  const now = deps.clock.now()
  const testCase: TestCase = {
    id: deps.ids.next(),
    programId,
    name,
    sample,
    expect: normalizeExpect(input.expect),
    lastResult: null,
    createdAt: now,
    updatedAt: now,
  }
  // a case saved from a rehearsal has been run once: judge that run now
  if (source !== undefined && source.status !== 'running') {
    testCase.lastResult = judgeNow(program, testCase, source, now)
  }
  deps.programTests.save(testCase)
  return testCase
}

function judgeNow(
  program: Program,
  testCase: TestCase,
  rehearsal: Rehearsal,
  at: number,
): TestCase['lastResult'] {
  const verdict = evaluateExpect(testCase.expect, rehearsal, program.deliverables.length > 0)
  return {
    status: verdict.status,
    rehearsalId: rehearsal.id,
    programFingerprint: rehearsal.programFingerprint,
    failures: verdict.failures,
    at,
  }
}

export interface UpdateTestInput {
  name?: string | undefined
  sample?: Partial<RehearsalSample> | undefined
  expect?: Partial<TestExpect> | undefined
}

export function updateTest(deps: Deps, id: string, patch: UpdateTestInput): TestCase {
  const found = deps.programTests.get(id)
  if (found === undefined) throw notFound('test case', id)
  const next: TestCase = {
    ...found,
    ...(patch.name === undefined ? {} : { name: checkTestName(patch.name) }),
    ...(patch.sample === undefined ? {} : { sample: normalizeSample(patch.sample) }),
    // a patch changes the fields it names
    ...(patch.expect === undefined
      ? {}
      : { expect: normalizeExpect({ ...found.expect, ...patch.expect }) }),
    // what was judged is not what is saved any more: the old result no longer counts
    ...(patch.sample === undefined && patch.expect === undefined ? {} : { lastResult: null }),
    updatedAt: deps.clock.now(),
  }
  deps.programTests.save(next)
  return next
}

export function deleteTest(deps: Deps, id: string): TestCase {
  const found = deps.programTests.get(id)
  if (found === undefined) throw notFound('test case', id)
  deps.programTests.delete(id)
  return found
}

/**
 * Run the test cases of a program (all, or one) one after the other in the background. Each case
 * stores its result as it finishes; the cases show `running` meanwhile.
 */
export function runTests(deps: Deps, programId: string, caseId?: string): { started: number } {
  const program = getProgram(deps, programId)
  const all = deps.programTests.list(programId)
  const cases = caseId === undefined ? all : all.filter((c) => c.id === caseId)
  if (caseId !== undefined && cases.length === 0) throw notFound('test case', caseId)
  if (cases.length === 0) return { started: 0 }
  if (cases.some((c) => c.lastResult?.status === 'running')) {
    throw conflict('these tests are already running', 'TESTS_BUSY')
  }
  deps.rehearsalRunner.runCases(program, cases)
  return { started: cases.length }
}
