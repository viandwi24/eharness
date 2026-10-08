/**
 * Approval notes (internal): the framed text the model reads for the note a human added to an
 * approved tool call, and the `data-eh.input` data it is stored as.
 *
 * @see docs/specs/11-interaction.md#36-approval-notes
 */
import { neutralizeTags } from '../../messages/framing.ts'
import type { InputPartData } from '../../messages/types.ts'

/** An attribute value that cannot break out of its quotes. */
function attr(value: string): string {
  return value.replace(/[^\w.:-]/g, '_')
}

/**
 * The `data-eh.input` data of an approval note: `source: 'user'`, `text` =
 * `<user-note tool="…" call="…">note</user-note>` (the frame tags neutralised inside the note, so
 * it cannot close its own block or a `<system-reminder>`), `approvalNote` = the raw note.
 */
export function approvalNoteData(answer: {
  toolCallId: string
  toolName: string
  note?: string
}): InputPartData {
  const note = answer.note ?? ''
  const safe = neutralizeTags(note, ['user-note', 'system-reminder'])
  return {
    source: 'user',
    text: `<user-note tool="${attr(answer.toolName)}" call="${attr(answer.toolCallId)}">\n${safe}\n</user-note>`,
    approvalNote: { toolCallId: answer.toolCallId, toolName: answer.toolName, text: note },
  }
}
