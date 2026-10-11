// What a failed turn means to the person (pure, unit-tested). The server answers pre-turn failures
// with the library's `{ error: { code } }` bodies (`HarnessHttpError.code` in the browser) and a
// finished turn stores `metadata.eharness.error.code` on its assistant message (`TurnResult.error`,
// always set). Both carry the same code set (`EH_PROVIDER_AUTH`, `EH_PROVIDER`, `EH_LOCK_UNAVAILABLE`, ...).
import { isHarnessHttpError } from 'eharness/client';
import type { UIMessage } from 'ai';

/** One sentence per code worth a hint; `undefined` = show the server's own text. */
export function errorHint(code: string | undefined): string | undefined {
	switch (code) {
		case 'EH_PROVIDER_AUTH':
			return 'The model provider rejected the API key. Set it in Settings > Providers.';
		case 'EH_LOCK_UNAVAILABLE':
			return 'Storage is unavailable right now. Try again in a moment.';
		case 'EH_PROVIDER':
			return 'The model provider failed to answer. Try again, or pick another model.';
		default:
			return undefined;
	}
}

/** Text for a toast of a failed request: the hint of its code, else its message. */
export function requestFailureText(e: unknown, fallback: string): string {
	if (isHarnessHttpError(e)) return errorHint(e.code) ?? (e.message || fallback);
	return e instanceof Error && e.message ? e.message : fallback;
}

/** The error code of the last assistant message when its turn failed (`metadata.eharness.error`). */
export function lastTurnErrorCode(messages: readonly UIMessage[]): string | undefined {
	const last = messages.findLast((m) => m.role === 'assistant');
	const meta = last?.metadata as { eharness?: { error?: { code?: unknown } } } | undefined;
	const code = meta?.eharness?.error?.code;
	return typeof code === 'string' ? code : undefined;
}
