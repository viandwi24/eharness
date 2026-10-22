// Program briefs and notes as library files (P57): small pure helpers for the move dialog.
import type { components } from '../api/schema';

type Item = components['schemas']['ProgramFilesPreview']['items'][number];
type Result = components['schemas']['ProgramFilesResult'];

export const readyCount = (items: readonly Pick<Item, 'status'>[]): number => items.filter((i) => i.status === 'ready').length;

/** One line for the outcome of a move. */
export function filesResultText(r: Pick<Result, 'moved' | 'failed'>): string {
	const parts = [`${r.moved} program${r.moved === 1 ? '' : 's'} moved to the library`];
	if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed.map((f) => f.error).join('; ')}`);
	return `${parts.join('. ')}.`;
}

/** The program is in file mode when its brief points to a library file. */
export const inFileMode = (p: { briefPath?: string | null }): boolean => typeof p.briefPath === 'string' && p.briefPath !== '';

/** The Files page link that opens a library file. */
export const libraryLink = (path: string): string => `/files?path=${encodeURIComponent(path)}`;
