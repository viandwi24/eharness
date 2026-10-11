/**
 * Validation of stored messages on cold load (internal).
 *
 * Works on in-memory copies; storage is never modified.
 *
 * @see docs/specs/03-messages.md#7-validation-on-load
 */
import { safeValidateUIMessages } from 'ai'
import { z } from 'zod/v4'
import { HarnessError, type HarnessWarning } from '../errors.ts'
import { kindOf } from './kinds.ts'
import type { MessageRegistry } from './registry.ts'
import { normalizeDeniedApprovals, normalizeRawInput } from './tool-parts.ts'
import type { HarnessUIMessage } from './types.ts'

/** What to do with a message that fails validation (`SessionOptions.onInvalidMessage`). */
export type InvalidMessagePolicy = 'drop' | 'keep' | 'throw'

/** Result of {@link validateStoredMessages}. */
export interface ValidateStoredMessagesResult {
  /** Valid (or kept) messages, in input order. */
  messages: HarnessUIMessage[]
  /** Warnings to emit (`W_UNKNOWN_STORED_PART` once per type, `W_INVALID_MESSAGE` per message). */
  warnings: HarnessWarning[]
}

/**
 * LOOSE metadata schema: keeps unknown keys (app keys and unknown `metadata.eharness` keys),
 * because validation replaces `message.metadata` with the parsed value.
 */
const metadataSchema = z
  .looseObject({
    eharness: z
      .looseObject({
        v: z.literal(1),
        createdAt: z.number(),
        kind: z.string().optional(),
        turnId: z.string().optional(),
        tokens: z.number().optional(),
        clientId: z.string().optional(),
        parentId: z.string().nullable().optional(),
        augmented: z.number().optional(),
        deliveredIn: z.string().optional(),
        model: z.string().optional(),
        usage: z.looseObject({}).optional(),
        stop: z.string().optional(),
        pending: z.looseObject({ messageId: z.string() }).nullable().optional(),
        steps: z.number().optional(),
        durationMs: z.number().optional(),
        error: z.looseObject({ code: z.string().optional(), message: z.string() }).optional(),
      })
      .optional(),
  })
  .optional()

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validate stored messages one by one (spec 03 §7):
 *
 * 1. apply `upgrade` of each registered data part / kind to its parts;
 * 2. remove parts whose `data-*` type is not registered (`W_UNKNOWN_STORED_PART` once per type,
 *    never escalated by `strict`); a kind message whose kind is not registered is skipped the
 *    same way;
 * 3. `safeValidateUIMessages` with the loose metadata schema and the registry's data schemas
 *    (no `tools`), and the kind shape rule (one `data-<kind>` part).
 *
 * A message that fails is dropped (`W_INVALID_MESSAGE`), kept unvalidated, or rejected with
 * `EH_INVALID_MESSAGE`, per `policy`.
 */
export async function validateStoredMessages(
  messages: readonly unknown[],
  registry: MessageRegistry,
  policy: InvalidMessagePolicy = 'drop',
  protectedIds: ReadonlySet<string> = new Set(),
): Promise<ValidateStoredMessagesResult> {
  const result: HarnessUIMessage[] = []
  const warnings: HarnessWarning[] = []
  const unknownTypes = new Set<string>()
  const dataSchemas = registry.dataSchemas()

  const unknownPart = (type: string, messageId: unknown) => {
    if (unknownTypes.has(type)) return
    unknownTypes.add(type)
    warnings.push({
      code: 'W_UNKNOWN_STORED_PART',
      message: `Stored messages contain the unregistered data part type '${type}'; it is ignored (kept in storage).`,
      details: { type, messageId },
    })
  }

  for (const stored of messages) {
    let copy: HarnessUIMessage
    try {
      copy = structuredClone(stored) as HarnessUIMessage
    } catch (error) {
      invalid(stored, `not cloneable: ${describe(error)}`)
      continue
    }
    const id = (copy as { id?: unknown } | null)?.id
    let problem: string | undefined

    if (typeof copy !== 'object' || copy === null || !Array.isArray(copy.parts)) {
      invalid(stored, 'not a UIMessage (missing parts)')
      continue
    }

    // 1 + 2: upgrade registered data parts, remove unregistered ones
    const kind = kindOf(copy)
    if (kind !== undefined && registry.kind(kind) === undefined) {
      unknownPart(`data-${kind}`, id)
      continue
    }
    const parts: typeof copy.parts = []
    for (const part of copy.parts) {
      const type = (part as { type?: unknown } | null)?.type
      if (typeof type !== 'string' || !type.startsWith('data-')) {
        parts.push(part)
        continue
      }
      const registered = registry.dataPart(type)
      if (registered === undefined) {
        unknownPart(type, id)
        continue
      }
      const upgrade = registered.def.upgrade
      if (upgrade !== undefined) {
        try {
          ;(part as { data: unknown }).data = upgrade(
            structuredClone((part as { data: unknown }).data),
          )
        } catch (error) {
          problem ??= `upgrade of '${type}' failed: ${describe(error)}`
        }
      }
      parts.push(part)
    }
    copy.parts = parts
    const repaired = normalizeDeniedApprovals(copy)
    if (repaired !== copy) {
      warnings.push({
        code: 'W_REPAIRED_MESSAGE',
        message: `Stored message ${String(id)} had an 'output-denied' tool part with approval.approved true; it was repaired to approved false.`,
        details: { messageId: id, repair: 'denied-approval' },
      })
    }
    copy = normalizeRawInput(repaired)

    // kind shape: exactly one part, of type data-<kind>
    if (problem === undefined && kind !== undefined) {
      if (copy.parts.length !== 1 || copy.parts[0]?.type !== `data-${kind}`) {
        problem = `kind message '${kind}' must have exactly one part of type 'data-${kind}'`
      }
    }

    if (problem === undefined) {
      const validated = await safeValidateUIMessages<HarnessUIMessage>({
        messages: [copy],
        metadataSchema,
        dataSchemas,
      })
      if (validated.success) {
        result.push(validated.data[0] as HarnessUIMessage)
        continue
      }
      problem = describe(validated.error)
    }
    invalid(copy, problem, stored)
  }
  return { messages: result, warnings }

  function invalid(copy: unknown, reason: string, original: unknown = copy): void {
    const messageId = (original as { id?: unknown } | null)?.id
    if (policy === 'throw') {
      throw new HarnessError(
        'EH_INVALID_MESSAGE',
        `Stored message ${String(messageId)} is invalid: ${reason}`,
        {
          details: { messageId, reason },
        },
      )
    }
    // 'keep' uses the unvalidated copy, but only if it is structurally a message at all. A message
    // that holds pending state (or the active turn) is never dropped: "repair, don't drop"
    const holdsState = typeof messageId === 'string' && protectedIds.has(messageId)
    if (
      (policy === 'keep' || holdsState) &&
      Array.isArray((copy as { parts?: unknown } | null)?.parts)
    ) {
      if (holdsState && policy !== 'keep') {
        warnings.push({
          code: 'W_INVALID_MESSAGE',
          message: `Stored message ${String(messageId)} failed validation but holds pending state; it was kept unvalidated: ${reason}`,
          details: { messageId, reason, kept: true },
        })
      }
      result.push(copy as HarnessUIMessage)
      return
    }
    warnings.push({
      code: 'W_INVALID_MESSAGE',
      message: `Stored message ${String(messageId)} failed validation and was dropped: ${reason}`,
      details: { messageId, reason },
    })
  }
}

/**
 * Check one message about to be saved (spec 05 §3, invariant I1): AI SDK `UIMessage` schema with
 * the loose harness metadata schema and the registry's data schemas, plus the kind shape rule.
 * Unregistered `data-*` parts are not checked (they are ignored on load). Returns the problem, or
 * `undefined` when the message is valid. Never throws.
 */
export async function checkMessageShape(
  message: unknown,
  registry: MessageRegistry,
): Promise<string | undefined> {
  let copy: HarnessUIMessage
  try {
    copy = structuredClone(message) as HarnessUIMessage
  } catch (error) {
    return `not cloneable: ${describe(error)}`
  }
  if (typeof copy !== 'object' || copy === null || !Array.isArray(copy.parts)) {
    return 'not a UIMessage (missing parts)'
  }
  const kind = kindOf(copy)
  if (kind !== undefined) {
    if (registry.kind(kind) === undefined) return `kind '${kind}' is not registered`
    if (copy.parts.length !== 1 || copy.parts[0]?.type !== `data-${kind}`) {
      return `kind message '${kind}' must have exactly one part of type 'data-${kind}'`
    }
  }
  copy.parts = copy.parts.filter((part) => {
    const type = (part as { type?: unknown } | null)?.type
    return (
      typeof type !== 'string' || !type.startsWith('data-') || registry.dataPart(type) !== undefined
    )
  })
  try {
    const validated = await safeValidateUIMessages<HarnessUIMessage>({
      messages: [copy],
      metadataSchema,
      dataSchemas: registry.dataSchemas(),
    })
    return validated.success ? undefined : describe(validated.error)
  } catch (error) {
    return describe(error)
  }
}
