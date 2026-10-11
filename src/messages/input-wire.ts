/**
 * The model wire form of a stored `data-eh.input` part (internal).
 *
 * @see docs/specs/03-messages.md
 */
import { convertToModelMessages, type ModelMessage } from 'ai'
import type { InputFilesConfig } from '../agent/types.ts'
import { resolveFileParts } from './files.ts'
import type { InputPartData } from './types.ts'

/**
 * The user model message of a `data-eh.input` part: exactly what projection produces when it
 * splits the stored assistant message (spec 03 §6 step 4), so stored order equals model order.
 */
export async function inputWireMessage(
  data: InputPartData,
  files?: {
    resolve?: InputFilesConfig['resolve']
    describe?: InputFilesConfig['describe']
    refuse?: (file: { mediaType: string; filename?: string }) => string | undefined
    sessionId: string
  },
): Promise<ModelMessage[]> {
  const parts: Array<{ type: 'text'; text: string } | NonNullable<InputPartData['files']>[number]> =
    await resolveFileParts(
      [{ type: 'text', text: data.text }, ...(data.files ?? [])] as Array<{
        type: 'text'
        text: string
      }>,
      files?.resolve,
      { sessionId: files?.sessionId ?? '' },
      files?.describe,
      files?.refuse,
    )
  return convertToModelMessages([{ role: 'user', parts }])
}
