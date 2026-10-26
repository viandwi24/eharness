import { api, type WorkspacePause } from '../api/index';
import { live } from './live.svelte';

/**
 * Pause all, as the UI knows it (`GET /workspace/pause`). Refreshed when the server says settings
 * changed (any tab or instance), on a slow timer as a safety net, and at once after a pause or a
 * resume from here.
 */
export const pauseStore = $state<{ view: WorkspacePause | null; busy: boolean; error: string | null }>({
	view: null,
	busy: false,
	error: null
});

export async function loadPause(): Promise<void> {
	try {
		pauseStore.view = await api.get('/workspace/pause');
	} catch {
		// offline or signed out: keep what was known
	}
}

export interface PauseChoice {
	note: string;
	holdChannels: boolean;
	answerHeldOnResume: boolean;
	stopRunning: boolean;
}

async function change(run: () => Promise<WorkspacePause>): Promise<boolean> {
	pauseStore.busy = true;
	pauseStore.error = null;
	try {
		pauseStore.view = await run();
		return true;
	} catch (e) {
		pauseStore.error = e instanceof Error ? e.message : 'The request failed';
		return false;
	} finally {
		pauseStore.busy = false;
	}
}

export const pauseWorkspace = (c: PauseChoice): Promise<boolean> =>
	change(() =>
		api.post('/workspace/pause', {
			body: { ...(c.note.trim() === '' ? {} : { note: c.note.trim() }), holdChannels: c.holdChannels, answerHeldOnResume: c.holdChannels && c.answerHeldOnResume, stopRunning: c.stopRunning }
		})
	);

export const resumeWorkspace = (): Promise<boolean> => change(() => api.post('/workspace/resume'));

/** Keep the state fresh while mounted: on every settings change event and every 15 s. */
export function trackPause(): () => void {
	const timer = setInterval(() => void loadPause(), 15_000);
	return () => clearInterval(timer);
}

/** The revision the live store bumps on `settings-changed`. */
export const pauseRevision = (): number => live.state.revs.settings;

/** "4 programs, 3 routines, 12 reminders, heartbeat, daily digest, 2 queued tasks": only what is not empty. */
export function heldText(held: WorkspacePause['held']): string {
	const n = (count: number, one: string, many = `${one}s`): string | null => (count === 0 ? null : `${count} ${count === 1 ? one : many}`);
	const parts = [
		n(held.programs, 'program'),
		n(held.routines, 'routine'),
		n(held.reminders, 'reminder'),
		n(held.scripts ?? 0, 'script'),
		held.heartbeat ? 'heartbeat' : null,
		held.digest ? 'daily digest' : null,
		n(held.queuedTasks, 'queued task')
	].filter((p): p is string => p !== null);
	return parts.length === 0 ? 'Nothing is scheduled right now' : parts.join(', ');
}
