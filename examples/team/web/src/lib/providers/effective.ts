// The model an agent (or the workspace) ends up on when nothing picks one, for the hint under a model
// picker. Mirrors the server's resolution: the agent's own pick, else the workspace pick, else the default
// profile and its default model (`TEAM_MODEL` on the env default profile). Pure, unit-tested.
import type { ProviderProfile } from './store-core.js';

export type ModelPick = { profileId: string | null; modelId: string | null };
export type EffectiveModel = { profileId: string; profileLabel: string; modelId: string };

export function effectiveModel(profiles: readonly ProviderProfile[], own: ModelPick, workspace: ModelPick): EffectiveModel | undefined {
	const def = profiles.find((p) => p.isDefault);
	const profileId = own.profileId ?? workspace.profileId ?? def?.id ?? null;
	const profile = profiles.find((p) => p.id === profileId);
	if (!profile) return undefined;
	// a model with no profile of its own belongs to the profile it ends up on; the workspace model
	// only applies when the agent picked no profile
	const modelId = own.modelId ?? (own.profileId === null ? workspace.modelId : null) ?? profile.defaultModel;
	if (!modelId) return undefined;
	return { profileId: profile.id, profileLabel: profile.label, modelId };
}

/** "OpenRouter · deepseek/deepseek-v4.1-flash" */
export function effectiveModelText(e: EffectiveModel): string {
	return `${e.profileLabel} · ${e.modelId}`;
}
