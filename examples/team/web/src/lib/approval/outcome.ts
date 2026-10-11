// What a failed answer means to the person (pure, unit-tested). An item that was answered
// elsewhere (another tab, the Auto classifier, another instance, a double click) is not an error
// of this click: the lists refresh and nothing is shown. Everything else gets one short sentence.
import { isHarnessHttpError } from 'eharness/client';

/** Text for a toast, or `null` when the failure is quiet (the item is simply gone). */
export function answerFailureText(e: unknown): string | null {
	if (isHarnessHttpError(e)) {
		if (e.isAlreadyAnswered || e.isNotFound) return null;
		if (e.isBusy) return 'The agent is busy right now. Try again in a moment.';
	}
	if (e instanceof Error && e.message) return e.message;
	return 'Could not send the answer';
}
