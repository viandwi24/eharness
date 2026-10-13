// Artifact kinds come from the server's registry (`examples/team/shared/artifacts/kinds.ts`, plan
// P45); `viewers.ts` is the one place that maps a kind to its viewer.
import { ARTIFACT_KIND_IDS, isKnownKind as known, kindOf, kindForFile } from '../../../../shared/artifacts/kinds.js';

export type ArtifactKindId = 'html' | 'document' | 'image' | 'mermaid' | 'code' | 'data' | 'file';
export const ARTIFACT_KINDS: readonly string[] = ARTIFACT_KIND_IDS;
export const isKnownKind = (k: string): k is ArtifactKindId => known(k);
export const kindLabel = (k: string): string => kindOf(k).label;
export { kindForFile, kindOf };
