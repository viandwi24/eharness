// Header numbers of a background worker job. The job row (`GET /tasks/{id}` -> `job`) counts only
// finished turns (chunks) and numbers chunks from 0, so a job in its first chunk read "Chunk 0 ·
// 0 steps · $0.00" for its whole first chunk. The running turn's totals come from the live
// stream (`data-eh.usage`). Pure, unit-tested.
import type { TurnUsage } from './live-stream.ts';

export type JobStats = { chunk: number; steps: number; costUsd: number };

/** The chunk as people count it (from 1), steps and cost including the turn running now. */
export function jobStats(job: { chunk: number; steps: number; costUsd: number }, turn?: TurnUsage): JobStats {
	return {
		chunk: job.chunk + 1,
		steps: job.steps + (turn?.steps ?? 0),
		costUsd: job.costUsd + (turn?.costUsd ?? 0)
	};
}
