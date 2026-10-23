/**
 * Where agent text leaves the app, a public share link is checked against the live shares
 * (`domain/share-links.ts`): a mistyped token is repaired, a dead link is marked. The owner sees a
 * warning in the server log, nobody is alarmed.
 */
import { definePlugin, type HarnessPlugin, type HarnessUIMessage } from 'eharness'
import { fixShareLinks } from '../../domain/share-links.ts'
import type { ArtifactService } from './service.ts'

/** Rewrites the share links of a text; `where` names the place for the log line. */
export type ShareLinkFixer = (text: string, where: string) => string

export function createShareLinkFixer(
  service: Pick<ArtifactService, 'liveShares'>,
  warn: (message: string) => void,
): ShareLinkFixer {
  // the same text is checked more than once (each step is stored again, then delivered): log once
  const logged = new Map<string, number>()
  const once = (key: string, message: string): void => {
    const now = Date.now()
    if (now - (logged.get(key) ?? -Infinity) < 60_000) return
    logged.set(key, now)
    if (logged.size > 500) logged.delete(logged.keys().next().value as string)
    warn(message)
  }
  return (text, where) => {
    // cheap: no `/s/` in the text means no query at all
    if (!text.includes('/s/')) return text
    try {
      const out = fixShareLinks(text, service.liveShares())
      for (const f of out.fixed) {
        once(
          `fix\0${f.from}`,
          `artifacts: ${where}: share link "${f.from}" was mistyped and is now "${f.to}" (${f.title})`,
        )
      }
      for (const token of out.dead) {
        once(
          `dead\0${token}`,
          `artifacts: ${where}: share link "${token}" is not public any more; the text now says so`,
        )
      }
      return out.text
    } catch (error) {
      warn(`artifacts: ${where}: share links were not checked: ${String(error)}`)
      return text
    }
  }
}

/**
 * `shareLinks` plugin: the text parts of an assistant message are fixed before the message is
 * stored, so a reload shows the working link. The text that is streamed live is not rewritten
 * (chunk order is public API); the stored message replaces it when the turn ends.
 */
export function shareLinks(fix: ShareLinkFixer): HarnessPlugin<'share-links'> {
  return definePlugin({
    name: 'share-links',
    setup: () => ({
      hooks: {
        'message.beforeSave': (
          ctx: { session: { id: string } },
          message: HarnessUIMessage,
        ): HarnessUIMessage | undefined => {
          if (message.role !== 'assistant') return undefined
          let changed = false
          const parts = message.parts.map((part) => {
            if (part.type !== 'text' || !part.text.includes('/s/')) return part
            const text = fix(part.text, `session ${ctx.session.id}`)
            if (text === part.text) return part
            changed = true
            return { ...part, text }
          })
          return changed ? { ...message, parts } : undefined
        },
      },
    }),
  })
}
