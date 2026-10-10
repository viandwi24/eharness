// What a failed answer means to the person (pure, unit-tested). An item that was answered
// elsewhere (another tab, the Auto classifier, another instance, a double click) is not an error
// of this click: the lists refresh and nothing is shown. Everything else gets one short sentence.
import { ApiError } from '../api/client';

/** The server says the item is not waiting any more (404 unknown id, 409 `ALREADY_ANSWERED`). */
export function isAlreadyAnswered(e: unknown): boolean {
	return e instanceof ApiError && (e.status === 404 || (e.status === 409 && e.code === 'ALREADY_ANSWERED'));
}

/** Text for a toast, or `null` when the failure is quiet (the item is simply gone). */
export function answerFailureText(e: unknown): string | null {
	if (isAlreadyAnswered(e)) return null;
	if (e instanceof ApiError && e.status === 409 && e.code === 'EH_SESSION_BUSY') {
		return 'The agent is busy right now. Try again in a moment.';
	}
	if (e instanceof Error && e.message) return e.message;
	return 'Could not send the answer';
}
