/**
 * The last consistency scan of the Health page (see `app/health.ts`). Its own module so a fix can
 * forget it without importing the page.
 */
import type { Finding } from '../domain/health.ts'

export const consistencyCache = new WeakMap<object, { at: number; findings: Finding[] }>()

/** A fix changed the workspace: the next read of the Health page scans again. */
export const forgetConsistency = (deps: object): void => void consistencyCache.delete(deps)
