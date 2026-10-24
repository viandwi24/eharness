/** The event stream use cases (the Events page, `GET /events`, the `events_recent` tool). */

import { invalid, notFound } from '../domain/errors.ts'
import {
  STREAM_DEFAULT_LIMIT,
  STREAM_MAX_LIMIT,
  STREAM_TYPES,
  type StreamEvent,
  type StreamPage,
  type StreamQuery,
} from '../domain/event-stream.ts'
import type { Deps } from './ports.ts'

/** Check a query and cap its limit; unknown types are refused with the list of valid ones. */
export function checkStreamQuery(
  q: Omit<StreamQuery, 'limit'> & { limit?: number | undefined },
): StreamQuery {
  for (const t of q.types ?? []) {
    if (!(STREAM_TYPES as readonly string[]).includes(t))
      throw invalid(`unknown event type "${t}". Types: ${STREAM_TYPES.join(', ')}`, 'INVALID_QUERY')
  }
  if (q.from !== undefined && q.to !== undefined && q.from > q.to)
    throw invalid('from must not be after to', 'INVALID_QUERY')
  return {
    ...q,
    limit: Math.min(STREAM_MAX_LIMIT, Math.max(1, q.limit ?? STREAM_DEFAULT_LIMIT)),
  }
}

export function listEvents(
  deps: Deps,
  q: Omit<StreamQuery, 'limit'> & { limit?: number | undefined },
): Promise<StreamPage> {
  return deps.eventStream.list(checkStreamQuery(q))
}

export async function getEvent(deps: Deps, id: string): Promise<StreamEvent> {
  const e = await deps.eventStream.get(id)
  if (e === undefined) throw notFound('event', id)
  return e
}
