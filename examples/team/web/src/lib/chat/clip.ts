// Clipped history pages of `eharness/client`: the server cuts big tool inputs/outputs in pages
// (`createChatSession({ clip })`), `isClippedPart` tells a cut part, `session.loadFull(id)` fetches
// the whole message and replaces it in place.
import { type ChatSession, isClippedPart } from 'eharness/client';

/** The server cut this tool part's input or output (see `loadFull`). */
export function isClipped(part: unknown): boolean {
	return isClippedPart(part as Parameters<typeof isClippedPart>[0]);
}

/** `session.loadFull(messageId)` bound to the session. */
export function loadFullOf(session: ChatSession): (messageId: string) => Promise<unknown> {
	return (id) => session.loadFull(id);
}
