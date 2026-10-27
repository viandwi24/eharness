// Turn totals of a task's live stream. The job row counts finished turns only; the running turn's
// steps and cost come from the transient `data-eh.usage` chunk (`followSessionStream`'s `onChunk`).
import type { UIMessageChunk } from 'ai';

/** Turn totals of the transient `data-eh.usage` chunk (cumulative for the running turn). */
export type TurnUsage = { steps: number; costUsd?: number };

/** The turn totals a `data-eh.usage` chunk carries, else undefined. */
export function usageOf(chunk: UIMessageChunk): TurnUsage | undefined {
	if (chunk.type !== 'data-eh.usage') return undefined;
	const d = (chunk as { data?: { steps?: unknown; costUsd?: unknown } }).data;
	if (typeof d?.steps !== 'number') return undefined;
	return typeof d.costUsd === 'number' ? { steps: d.steps, costUsd: d.costUsd } : { steps: d.steps };
}
