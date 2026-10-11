/**
 * The activity routes: `GET /activity/stream` (SSE) and `GET /activity` (a page).
 *
 * @see docs/specs/26-http.md#10-activity-routes
 */
import {
  activityCursor,
  readActivityPage,
  handleActivityStream as serveStream,
} from '../activity/index.ts'
import { httpError, jsonResponse } from './errors.ts'
import { parseLimit } from './sessions.ts'
import type { HttpCall, HttpEnv } from './types.ts'

export async function handleActivityStreamRoute<P>(
  env: HttpEnv<P>,
  call: HttpCall<P>,
): Promise<Response> {
  const activity = env.options.activity
  if (activity === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  if (activityCursor(call.request) === null) {
    return httpError('EH_INVALID_INPUT', 'after must be a non-negative integer.', {
      reason: 'after',
    })
  }
  const filter = activity.filter(call.principal)
  const onError = env.options.onFailure
  return serveStream(call.request, {
    store: activity.store,
    bootId: activity.bootId,
    ...(filter === 'all' ? {} : { filter }),
    ...(activity.pollMs === undefined ? {} : { pollMs: activity.pollMs }),
    ...(activity.keepAliveMs === undefined ? {} : { keepAliveMs: activity.keepAliveMs }),
    ...(activity.retryMs === undefined ? {} : { retryMs: activity.retryMs }),
    ...(onError === undefined
      ? {}
      : {
          onError: (error: unknown) =>
            onError(error, { request: call.request, action: call.action }),
        }),
  })
}

export async function handleActivityPageRoute<P>(
  env: HttpEnv<P>,
  call: HttpCall<P>,
): Promise<Response> {
  const activity = env.options.activity
  if (activity === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  const url = new URL(call.request.url)
  const afterRaw = url.searchParams.get('after') ?? '0'
  if (!/^\d{1,15}$/.test(afterRaw)) {
    return httpError('EH_INVALID_INPUT', 'after must be a non-negative integer.', {
      reason: 'after',
    })
  }
  const limit = parseLimit(url.searchParams.get('limit'), 100, 500)
  if (limit === undefined) {
    return httpError('EH_INVALID_INPUT', 'limit must be 1 to 500.', { reason: 'limit' })
  }
  const filter = activity.filter(call.principal)
  const page = await readActivityPage(activity.store, {
    after: Number(afterRaw),
    limit,
    ...(filter === 'all' ? {} : { filter }),
  })
  return jsonResponse(page)
}
