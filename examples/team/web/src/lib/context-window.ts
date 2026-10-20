// The context window setting of an agent: presets below the model's window, the effective window
// (a custom limit never exceeds the model's) and the input cost of one call at the threshold.
// Pure, unit-tested.

export const MIN_CONTEXT_WINDOW = 16_000;
export const DEFAULT_COMPACT_AT = 80;
const PRESETS = [800_000, 500_000, 256_000, 128_000, 64_000];

/** Presets that are below the model's window (all of them when the window is unknown). */
export function windowPresets(modelWindow: number | undefined): number[] {
	return PRESETS.filter((p) => modelWindow === undefined || p < modelWindow);
}

/** The window the agent works in: the model's, or the smaller of its own limit and the model's. */
export function effectiveWindow(modelWindow: number | undefined, custom: number | null): number | undefined {
	if (custom === null) return modelWindow;
	return modelWindow === undefined ? custom : Math.min(custom, modelWindow);
}

/** An error text for a custom limit that cannot be saved; undefined = fine. */
export function windowProblem(custom: number, modelWindow: number | undefined): string | undefined {
	if (!Number.isInteger(custom) || custom < MIN_CONTEXT_WINDOW) return `At least ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')} tokens`;
	if (modelWindow !== undefined && custom > modelWindow) return `Above the model's window (${modelWindow.toLocaleString('en-US')} tokens)`;
	return undefined;
}

/** Input cost (USD) of one call with the context at the threshold; undefined without a price. */
export function costAtThreshold(window: number | undefined, percent: number, inputUsdPerMillion: number | undefined): number | undefined {
	if (window === undefined || inputUsdPerMillion === undefined) return undefined;
	return (window * (percent / 100) * inputUsdPerMillion) / 1_000_000;
}
