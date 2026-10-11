/**
 * Eval framework types. A scenario is plain data plus a few functions: it never knows about a
 * specific client. Everything a developer swaps (fixtures, tasks, checks, rubrics) lives in the
 * scenario folder.
 */
import type { LanguageModel } from 'ai'

/** One unit of work the agent is asked to do (one turn in its own session, run in order). */
export interface ScenarioTask {
  id: string
  prompt: string
}

/** What a check can look at. */
export interface CheckContext {
  /** Files the agent wrote under `scenario.outputDir`, by path. */
  outputs: Readonly<Record<string, string>>
  /** Every file in the workspace after the run (fixtures included). */
  files: Readonly<Record<string, string>>
  tasks: readonly TaskResult[]
}

export interface CheckOutcome {
  /** 0..1 */
  score: number
  detail?: string
  /** Extra numbers worth keeping in the report (recall, precision, counts). */
  metrics?: Record<string, number>
}

/** A deterministic check: pure code, no model. */
export interface Check {
  id: string
  description?: string
  /** Weight in the total. Default 1. */
  weight?: number
  /** Score at or above which the check passes. Default 1. */
  passAt?: number
  /** A failed required check fails the run whatever the total. */
  required?: boolean
  run(ctx: CheckContext): CheckOutcome | Promise<CheckOutcome>
}

/** Rubric file (JSON): criteria scored 0-5 by a judge model. */
export interface Rubric {
  name: string
  /** Weighted score (0..1) at or above which the rubric check passes. Default 0.7. */
  passThreshold?: number
  criteria: Array<{ id: string; description: string; weight?: number }>
}

/** A rubric check: an LLM judge grades the produced files against a rubric file. */
export interface RubricCheck {
  id: string
  /** Rubric file, relative to the scenario folder. */
  rubric: string
  /** Which produced files the judge sees: `*` / `**` globs over output paths. Default every output. */
  files?: string
  /** Weight in the total. Default 1. */
  weight?: number
  required?: boolean
}

export interface Scenario {
  name: string
  description: string
  /** Folder of the scenario (rubric files resolve against it). */
  dir: string
  /** System instructions of the agent under test. */
  instructions: string
  /** Fixture files to load into the workspace, by absolute path (`/data/...`). */
  files(): Record<string, string> | Promise<Record<string, string>>
  /** Tasks, run one after the other. */
  tasks: readonly ScenarioTask[]
  /** Where the agent writes its deliverables. Default `/out`. */
  outputDir?: string
  checks: readonly Check[]
  rubrics?: readonly RubricCheck[]
  /** Weighted total at or above which the run passes. Default 0.7. */
  passThreshold?: number
  /** Step limit per task. Default 40. */
  maxSteps?: number
}

export interface TaskResult {
  id: string
  stop: string
  steps: number
  costUsd: number
  text: string
}

export interface CheckReport {
  id: string
  kind: 'deterministic' | 'rubric'
  score: number
  weight: number
  passed: boolean
  required: boolean
  detail?: string
  metrics?: Record<string, number>
  /** Rubric checks: per criterion score (0-5) and reason. */
  criteria?: Array<{ id: string; score: number; reason: string }>
  skipped?: boolean
}

export interface RunReport {
  scenario: string
  runId: string
  startedAt: string
  durationMs: number
  model: string
  judgeModel: string
  budgetUsd: number
  /** Agent + judge cost, estimated from the catalog. */
  costUsd: number
  agentCostUsd: number
  judgeCostUsd: number
  budgetExceeded: boolean
  tasks: TaskResult[]
  checks: CheckReport[]
  totalScore: number
  passThreshold: number
  passed: boolean
  /** Harness warnings of the run (budget, unpriced model). */
  warnings: string[]
  /** Produced files, relative to the report folder. */
  outputs: string[]
}

export interface RunOptions {
  model: LanguageModel
  modelId: string
  judgeModel?: LanguageModel
  judgeModelId?: string
  /** USD cap for the whole run (agent + judge). */
  budgetUsd: number
  /** Prices and window of the models in use. */
  catalog: import('eharness').ModelCatalog
  /** Wall clock, for tests. */
  now?: () => number
}
