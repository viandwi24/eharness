import { api } from '../api/index';
import type { components } from '../api/schema';
import { toast } from '../components/ui/sonner/index.js';
import { live } from '../stores/live.svelte.js';
import { activationWarning } from '../rehearsal/model';

type Program = components['schemas']['Program'];

/** Pause, resume or run a program now; toasts the outcome and bumps the live programs rev. */
export async function programAction(p: Program, action: 'pause' | 'resume' | 'run'): Promise<boolean> {
	try {
		await api.post(`/programs/{id}/${action}`, { params: { id: p.id } });
		if (action === 'run') toast.success(`${p.name} started`);
		live.state.revs.programs++;
		return true;
	} catch (e) {
		toast.error(e instanceof Error ? e.message : `Could not ${action} the program`);
		return false;
	}
}

/**
 * The warning to show before a program is activated when its saved test cases fail (phase K); null
 * when there is nothing to say. Never a block: the person can activate anyway.
 */
export async function activationText(p: Program): Promise<string | null> {
	try {
		const r = await api.get('/programs/{id}/tests', { params: { id: p.id } });
		return activationWarning(r.summary);
	} catch {
		return null;
	}
}
