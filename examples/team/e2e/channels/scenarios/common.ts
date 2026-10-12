/** Shared helpers of the scenario files: scripted-model steps, seed chatter, secret phrases. */
import type { ScriptedStepInput } from 'eharness/testing'
import { type Step, say } from '../dsl.ts'

/** One tool call as a scripted model step. */
export const call = (
  toolName: string,
  input: Record<string, unknown>,
  id = 'c1',
): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: id }],
})
/** Several tool calls in one step (parallel). */
export const calls = (list: Array<[string, Record<string, unknown>]>): ScriptedStepInput => ({
  toolCalls: list.map(([toolName, input], i) => ({ toolName, input, toolCallId: `p${i}` })),
})
export const text = (t: string): ScriptedStepInput => ({ text: t })
/** Load a deferred tool (native actions) before it can be called. */
export const search = (name: string, id = 's1'): ScriptedStepInput =>
  call('tool_search', { query: `select:${name}` }, id)
/** A step that reads the previous tool results (the whole prompt as text) and builds the next step. */
export const after = (fn: (wire: string) => ScriptedStepInput): ScriptedStepInput =>
  ((opts: { prompt: unknown }) => fn(JSON.stringify(opts.prompt))) as unknown as ScriptedStepInput

/** Secrets planted in chats of other divisions; no reply to somebody else may contain them. */
export const SECRET = {
  finance: 'GAJI-RAHASIA-7781',
  clipper: 'KLIEN-CLIP-ALPHA-93',
  programming: 'DEPLOY-KEY-HINT-5521',
  general: 'RAPAT-DIREKSI-4410',
  dm: 'DM-PRIBADI-6602',
}

/** People talk in a topic without addressing the bot (observed, never woken). */
export const chatter = (): Step[] => [
  say('budi', 'produksi', 'Shooting scene 3 selesai, besok lanjut scene 4', { mention: false }),
  say('sari', 'clipper', 'Clip episode 12 sudah diupload ke channel', { mention: false }),
  say('dodi', 'programming', 'Bug login sudah di-fix dan di-merge ke main', { mention: false }),
  say('admin', 'finance', `Total gaji bulan ini ${SECRET.finance}, jangan disebar`, {
    mention: false,
  }),
]

/** The latest `<message-meta>` header of a scripted model's prompts, as plain text. */
export function lastHeader(wire: string): string {
  const all = [...wire.matchAll(/<message-meta>([\s\S]*?)<\/message-meta>/g)]
  return (all.at(-1)?.[1] ?? '').replace(/\\n/g, '\n').replace(/\\"/g, '"')
}
