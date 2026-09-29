/**
 * Helper types derived from AI SDK (internal, not re-exported).
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
import type { streamText } from 'ai'

/** `ai` does not export `ProviderOptions`; derive it from `streamText`. */
export type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/** A value or a promise of it (user-supplied callbacks). */
export type Awaitable<T> = T | Promise<T>
