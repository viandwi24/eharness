/**
 * `cutAnswer` plugin: a program run whose final answer was cut at the output limit (stop `length`)
 * gets one more step to give a short final report, instead of ending as failed with no report.
 * Chats are left alone: their cut reply is already on its way to a person. Hook only.
 */
import { definePlugin, type HarnessPlugin } from 'eharness'

/** The note the model reads when its final answer was cut. */
export const CUT_ANSWER_NOTE =
  'Your last answer was cut at the output limit: it was too long. Do not repeat it. Give the final ' +
  'report now, short: the summary in a few sentences, details in library files you already wrote.'

/** Sessions whose cut final answer is retried once (program runs). */
export const retriesCutAnswer = (sessionId: string): boolean => sessionId.startsWith('program:')

export function cutAnswer(): HarnessPlugin<'cut-answer'> {
  /** Turns that already got their extra step. */
  const retried = new Set<string>()
  return definePlugin({
    name: 'cut-answer',
    setup: () => ({
      hooks: {
        'turn.beforeEnd': (
          ctx,
          e: { stop: string },
        ): { continue: { reason: string } } | undefined => {
          if (e.stop !== 'length' || !retriesCutAnswer(ctx.session.id)) return undefined
          const turnId = ctx.turn?.id
          if (turnId === undefined || retried.has(turnId)) return undefined
          retried.add(turnId)
          return { continue: { reason: CUT_ANSWER_NOTE } }
        },
        'turn.end': (_ctx, e: { turnId: string }): void => {
          retried.delete(e.turnId)
        },
      },
    }),
  })
}
