// Permission modes of the product: Manual, Auto, Bypass (server `domain/modes.ts`). Pure helpers.

export type TeamMode = 'manual' | 'auto' | 'bypass';
export type Tone = 'neutral' | 'info' | 'danger';

export const teamModes: { id: TeamMode; label: string; hint: string; tone: Tone }[] = [
	{ id: 'manual', label: 'Manual', hint: 'Risky tools ask you first.', tone: 'neutral' },
	{
		id: 'auto',
		label: 'Auto',
		hint: 'Rules first, then a classifier model decides. Blocked actions are denied; repeated blocks pause Auto and ask you.',
		tone: 'info'
	},
	{ id: 'bypass', label: 'Bypass', hint: 'Everything runs without asking. Use with care.', tone: 'danger' }
];

export const modeInfo = (id: TeamMode) => teamModes.find((m) => m.id === id) ?? teamModes[0]!;

/** Next mode of the Shift+Tab cycle (Manual, Auto, Bypass), among the `available` ones. */
export function cycleMode(current: TeamMode, available: readonly TeamMode[]): TeamMode {
	const ring = teamModes.map((m) => m.id).filter((id) => available.includes(id));
	if (ring.length === 0) return current;
	const at = ring.indexOf(current);
	return ring[(at + 1) % ring.length] ?? current;
}

/** Switching to Bypass asks first; every other switch is immediate. */
export const needsConfirm = (from: TeamMode, to: TeamMode): boolean => to === 'bypass' && from !== 'bypass';

// --- stored values ------------------------------------------------------------------------

/** An agent's own choice: a mode, or "inherit the workspace default" (stored as `default`). */
export type AgentChoice = 'inherit' | TeamMode;

export const agentChoices: { id: AgentChoice; stored: string; label: string; hint: string }[] = [
	{ id: 'inherit', stored: 'default', label: 'Inherit workspace default', hint: 'Follows Settings. No limit on what a chat may pick.' },
	{ id: 'manual', stored: 'manual', label: 'Manual', hint: 'Risky tools ask. Its chats can never be set to Auto or Bypass.' },
	{ id: 'auto', stored: 'auto', label: 'Auto', hint: 'Starts in Auto. Its chats can never be set to Bypass.' },
	{ id: 'bypass', stored: 'bypassPermissions', label: 'Bypass', hint: 'Starts in Bypass; chats may pick any mode.' }
];

/** A stored agent `permissionMode` (legacy values included) as the product's choice. */
export function agentChoiceOf(stored: string | null | undefined): AgentChoice {
	if (stored === 'default' || stored == null) return 'inherit';
	if (stored === 'auto') return 'auto';
	if (stored === 'bypassPermissions') return 'bypass';
	return 'manual'; // manual, acceptEdits, plan, dontAsk
}

export const storedOfChoice = (choice: AgentChoice): string => agentChoices.find((c) => c.id === choice)?.stored ?? 'default';

/** Workspace default as stored (`default` = Manual) <-> product mode. */
export const settingsModes: { id: 'default' | 'auto' | 'bypassPermissions'; mode: TeamMode }[] = [
	{ id: 'default', mode: 'manual' },
	{ id: 'auto', mode: 'auto' },
	{ id: 'bypassPermissions', mode: 'bypass' }
];

export function settingsModeOf(stored: string | null | undefined): 'default' | 'auto' | 'bypassPermissions' {
	if (stored === 'auto') return 'auto';
	if (stored === 'bypassPermissions') return 'bypassPermissions';
	return 'default';
}

export const teamModeOfSettings = (stored: string | null | undefined): TeamMode =>
	settingsModes.find((m) => m.id === settingsModeOf(stored))?.mode ?? 'manual';
