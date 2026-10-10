/** Model call log use cases (the Logs page). */
import { invalid, notFound } from '../domain/errors.ts'
import type {
  ModelCallDetail,
  ModelCallFilter,
  ModelCallPage,
  ModelCallStats,
} from '../domain/model-calls.ts'
import type { Deps } from './ports.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export function listModelCalls(
  deps: Deps,
  query: ModelCallFilter & { cursor?: string; limit?: number },
): ModelCallPage {
  const { limit, ...rest } = query
  return deps.modelCalls.list({ ...rest, limit: limit ?? 50 })
}

export function modelCallStats(
  deps: Deps,
  query: ModelCallFilter & { bucketMs?: number },
): ModelCallStats {
  const to = query.to ?? deps.clock.now()
  const from = query.from ?? to - DAY_MS
  if (from > to) throw invalid('from must not be after to')
  return deps.modelCalls.stats({ ...query, from, to })
}

export function getModelCall(deps: Deps, id: string, filter: ModelCallFilter): ModelCallDetail {
  const call = deps.modelCalls.get(id, filter)
  if (call === undefined) throw notFound('model call', id)
  return call
}
