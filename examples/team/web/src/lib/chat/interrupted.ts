// A turn that a dead process left unfinished (stop `interrupted`, spec 05 §9): the chat offers
// Continue (a normal message) and Retry (regenerate that reply). Pure, unit-tested.
import type { UIMessage } from 'ai';

type Meta = { eharness?: { stop?: string; kind?: string } } | undefined;

/**
 * The interrupted assistant message when it is the end of the conversation (kind messages such as
 * the recovery notice do not count), else `undefined`: once a user message or a newer reply
 * follows, there is nothing to offer.
 */
export function interruptedTurn(messages: readonly UIMessage[]): UIMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const eh = (m.metadata as Meta)?.eharness;
		if (eh?.kind !== undefined) continue;
		return m.role === 'assistant' && eh?.stop === 'interrupted' ? m : undefined;
	}
	return undefined;
}

/** What Continue sends. */
export const CONTINUE_TEXT = 'Continue where you left off.';
