import type { Scenario } from '../dsl.ts'
import { scenarios as a } from './a-collaboration.ts'
import { scenarios as b } from './b-boundaries.ts'
import { scenarios as c } from './c-social.ts'
import { scenarios as d } from './d-leakage.ts'
import { scenarios as e } from './e-abuse.ts'
import { scenarios as f } from './f-deadends.ts'
import { scenarios as g } from './g-cancel.ts'

export function allScenarios(): Scenario[] {
  return [...a, ...b, ...c, ...d, ...e, ...f, ...g]
}
