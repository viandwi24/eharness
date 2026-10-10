// Pure helpers of the model picker: formatting and searching the model list of a profile.
import type { components } from '../api/schema';

export type ProviderModel = components['schemas']['ProviderModel'];
export type ModelPolicy = components['schemas']['ProfileModels'];

/** 1_000_000 -> `1M`, 200_000 -> `200K`, 8_192 -> `8.2K`. */
export function formatContext(tokens: number | undefined): string {
	if (tokens === undefined || tokens <= 0) return '';
	if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${trim(tokens / 1_000)}K`;
	return String(tokens);
}

function trim(n: number): string {
	return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** USD per 1M tokens: `$3`, `$0.25`, `free`. */
export function formatPrice(usdPerMillion: number): string {
	if (usdPerMillion === 0) return 'free';
	if (usdPerMillion >= 10) return `$${Math.round(usdPerMillion * 10) / 10}`;
	return `$${Math.round(usdPerMillion * 100) / 100}`;
}

/** `$3 in / $15 out`, or empty when the model has no price. */
export function formatPricing(p: ProviderModel['pricing']): string {
	return p === undefined ? '' : `${formatPrice(p.input)} in / ${formatPrice(p.output)} out`;
}

/**
 * Models matching every word of `query` in the id or name (case-insensitive), in list order, at
 * most `limit`. The list of a big provider has hundreds of models: the picker renders the first
 * matches only.
 */
export function filterModels(models: readonly ProviderModel[], query: string, limit = 80): { items: ProviderModel[]; total: number } {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits = words.length === 0 ? [...models] : models.filter((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)));
	return { items: hits.slice(0, limit), total: hits.length };
}

// --- model policy (per-model switches) ---------------------------------------------------------
// The server stores `models: { allow?, deny?, extra? }` on a profile. No `allow` = every model is
// on except the `deny` ones; an `allow` list = only those are on (ids may use `*`). This mirrors the
// library (`allowed()` in src/providers/manager.ts): `extra` models skip `allow`, never `deny`.

function glob(pattern: string, id: string): boolean {
	if (!pattern.includes('*')) return pattern === id;
	const re = pattern
		.split('*')
		.map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*');
	return new RegExp(`^${re}$`).test(id);
}

/** Whether the policy lets a model through (what the server will let an agent pick). */
export function isModelEnabled(policy: ModelPolicy | undefined, id: string): boolean {
	if (policy === undefined) return true;
	const denied = (policy.deny ?? []).some((p) => glob(p, id));
	if (policy.extra?.some((x) => x.id === id)) return !denied;
	if (policy.allow !== undefined && !policy.allow.some((p) => glob(p, id))) return false;
	return !denied;
}

/** True when a policy restricts anything (an allow list or a deny entry). */
export const hasModelPolicy = (policy: ModelPolicy | undefined): boolean => policy !== undefined && (policy.allow !== undefined || (policy.deny?.length ?? 0) > 0);

const tidy = (policy: ModelPolicy): ModelPolicy | null => {
	const out: ModelPolicy = {};
	if (policy.allow !== undefined) out.allow = policy.allow;
	if (policy.deny !== undefined && policy.deny.length > 0) out.deny = policy.deny;
	if (policy.extra !== undefined && policy.extra.length > 0) out.extra = policy.extra;
	return Object.keys(out).length === 0 ? null : out;
};

/**
 * The policy after switching one model. Off: take it out of `allow` and, when a pattern still lets
 * it in (or there is no allow list), add it to `deny`. On: take it out of `deny` and, in allow-list
 * mode, add it to `allow`. `null` = no policy left (the PATCH body that clears it).
 */
export function setModelEnabled(policy: ModelPolicy | undefined, id: string, on: boolean): ModelPolicy | null {
	const next: ModelPolicy = { ...policy };
	if (on) {
		next.deny = (next.deny ?? []).filter((p) => p !== id);
		if (next.allow !== undefined && !isModelEnabled(next, id)) next.allow = [...next.allow, id];
		// a deny pattern (`x-*`) that still hides it cannot be undone per model: leave the policy as is
		return tidy(next);
	}
	if (next.allow !== undefined) next.allow = next.allow.filter((p) => p !== id);
	if (isModelEnabled(next, id)) next.deny = [...(next.deny ?? []), id];
	return tidy(next);
}

/**
 * The policy after adding a custom model id: it goes into `extra`, leaves `deny` and, in allow-list
 * mode, joins `allow` (so it stays on even if `extra` precedence changes). A deny pattern (`x-*`)
 * that still hides it cannot be undone per model: check `isModelEnabled` on the result.
 */
export function addCustomModel(policy: ModelPolicy | undefined, id: string): ModelPolicy {
	const next: ModelPolicy = { ...policy };
	if (!(next.extra ?? []).some((x) => x.id === id)) next.extra = [...(next.extra ?? []), { id }];
	next.deny = (next.deny ?? []).filter((p) => p !== id);
	if (next.deny.length === 0) delete next.deny;
	if (next.allow !== undefined && !next.allow.some((p) => glob(p, id))) next.allow = [...next.allow, id];
	return next;
}

/** Every model on again: no allow list, no deny entries (extras stay). */
export const enableAllModels = (policy: ModelPolicy | undefined): ModelPolicy | null => tidy({ ...(policy?.extra ? { extra: policy.extra } : {}) });

/** Every model off: an empty allow list (switch the ones you want on); extras skip `allow`, so they are denied by id. */
export const disableAllModels = (policy: ModelPolicy | undefined): ModelPolicy => {
	const extra = policy?.extra ?? [];
	return { allow: [], ...(extra.length > 0 ? { deny: extra.map((x) => x.id), extra } : {}) };
};
