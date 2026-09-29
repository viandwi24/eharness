/**
 * Regenerate / edit targets and `eh.rewind` markers (internal).
 *
 * @see docs/specs/11-interaction.md#5-regenerate-edit-rewind
 */
import { payloadOf } from '../../compaction/turns.ts'
import { HarnessError } from '../../errors.ts'
import { createKindMessage, kindOf } from '../../messages/kinds.ts'
import type { MessageRegistry } from '../../messages/registry.ts'
import type { HarnessUIMessage, RewindPayload } from '../../messages/types.ts'

/** A resolved regenerate / edit target. */
export interface RewindTarget {
  /** The re-answered assistant message (regenerate) or the replaced user message (edit). */
  message: HarnessUIMessage
  /** Id of the message just before the target in the view (`null` = the target is the first). */
  afterId: string | null
}

function isBoundary(message: HarnessUIMessage, registry: MessageRegistry): boolean {
  const kind = kindOf(message)
  return kind !== undefined && registry.kind(kind)?.def.boundary === true
}

function notFound(message: string, messageId: string | undefined): HarnessError {
  return new HarnessError('EH_INVALID_INPUT', message, {
    details: { reason: 'not-found', ...(messageId === undefined ? {} : { messageId }) },
  })
}

/**
 * Resolve the target of `regenerate()` (`role: 'assistant'`) or `edit()` (`role: 'user'`) in the
 * cached view (spec 11 §5). A message matches by id or by `metadata.eharness.clientId`; kind
 * messages never match. Without `messageId` (regenerate only) the newest assistant message is the
 * target.
 *
 * Throws `EH_INVALID_INPUT` with `details.reason` `'not-found'` (unknown, hidden, wrong role) or
 * `'beyond-compaction'` (the message before the target is not in the current view).
 */
export function resolveRewindTarget(args: {
  view: readonly HarnessUIMessage[]
  registry: MessageRegistry
  role: 'user' | 'assistant'
  messageId: string | undefined
}): RewindTarget {
  const { view, registry, role, messageId } = args
  const body = view.filter((m) => !isBoundary(m, registry))
  let index = -1
  for (let i = body.length - 1; i >= 0; i--) {
    const message = body[i] as HarnessUIMessage
    if (message.role !== role || kindOf(message) !== undefined) continue
    if (
      messageId === undefined ||
      message.id === messageId ||
      message.metadata?.eharness?.clientId === messageId
    ) {
      index = i
      break
    }
  }
  if (index < 0) {
    throw notFound(
      messageId === undefined
        ? 'There is no assistant message to regenerate.'
        : `No ${role} message '${messageId}' in the current view of the session.`,
      messageId,
    )
  }
  const message = body[index] as HarnessUIMessage
  const before = body[index - 1]
  const boundary = view.find((m) => isBoundary(m, registry))
  if (boundary !== undefined) {
    const start = payloadOf(boundary)?.resumeFromId ?? boundary.id
    if (before === undefined || before.id < start) {
      throw new HarnessError(
        'EH_INVALID_INPUT',
        'The message before the target was summarized by a compaction; it can no longer be rewound to.',
        { details: { reason: 'beyond-compaction', messageId: message.id } },
      )
    }
  }
  return { message, afterId: before?.id ?? null }
}

/** Build an `eh.rewind` marker. */
export function createRewind(args: {
  id: string
  afterId: string | null
  reason: RewindPayload['reason']
  turnId: string
  createdAt: number
  parentId: string | null
}): HarnessUIMessage {
  return createKindMessage(
    'eh.rewind',
    { afterId: args.afterId, reason: args.reason },
    {
      id: args.id,
      role: 'user',
      createdAt: args.createdAt,
      turnId: args.turnId,
      parentId: args.parentId,
    },
  ) as HarnessUIMessage
}
