// Pure helpers of the model picker: formatting and searching the model list of a profile.
import type { components } from '../api/schema';

export type ProviderModel = components['schemas']['ProviderModel'];

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
