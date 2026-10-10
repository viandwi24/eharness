<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { cycleMode, modeInfo, teamModes, type TeamMode } from '#lib/modes.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { modesStore } from '#lib/stores/modes.svelte.js';

	/** The permission mode of the agent's DM chat: Manual / Auto / Bypass (Shift+Tab cycles). */
	let { agentId }: { agentId: string } = $props();

	const st = $derived(modesStore.state.byAgent[agentId]);

	// Load for this agent, and again when a `mode-changed` event arrives (any tab; Auto paused).
	$effect(() => {
		void live.state.revs.modes;
		const id = agentId;
		untrack(() => void modesStore.load(id));
	});

	async function pick(mode: TeamMode): Promise<void> {
		if (!st) return;
		if (mode === st.mode && !(mode === 'auto' && st.auto.paused)) return;
		// Bypass switches at once, like the other modes (the red mode badge is the warning).
		await apply(mode);
	}

	async function apply(mode: TeamMode): Promise<void> {
		try {
			await modesStore.set(agentId, mode);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change the mode');
		}
	}

	/** Shift+Tab of the composer: the next available mode (Bypass switches at once). */
	export function cycle(): void {
		if (st) void pick(cycleMode(st.mode, st.available));
	}

	const tone = (m: TeamMode, active: boolean): string => {
		if (!active) return 'text-muted-foreground hover:bg-muted hover:text-foreground';
		const t = modeInfo(m).tone;
		if (t === 'danger') return 'bg-destructive-soft text-destructive-text';
		if (t === 'info') return 'bg-info-soft text-info-text';
		return 'bg-muted text-foreground';
	};
	const disabledWhy = (m: TeamMode): string | null => {
		if (!st || st.available.includes(m)) return null;
		if (m === 'auto' && !st.autoAvailable) return 'Auto needs a classifier model, which this server does not have.';
		return `This agent's own mode does not allow ${modeInfo(m).label}.`;
	};
</script>

{#if st}
	<div class="flex min-w-0 items-center gap-2">
		<div
			role="radiogroup"
			aria-label="Permission mode"
			class="inline-flex shrink-0 items-center rounded-md border border-border p-0.5 text-xs"
			data-testid="mode-switch"
			data-mode={st.mode}
		>
			{#each teamModes as m (m.id)}
				{@const why = disabledWhy(m.id)}
				<button
					type="button"
					role="radio"
					aria-checked={st.mode === m.id}
					disabled={why !== null}
					title={why ?? m.hint}
					class="rounded px-2 py-0.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 {tone(m.id, st.mode === m.id)}"
					onclick={() => void pick(m.id)}
				>
					{m.label}
				</button>
			{/each}
		</div>
		{#if st.mode === 'auto' && st.auto.paused}
			<button
				type="button"
				class="truncate rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning-text"
				title="Repeated blocks paused Auto: tool calls ask you until you approve one. Click to resume Auto."
				onclick={() => void pick('auto')}
				data-testid="auto-paused"
			>
				auto paused · approve to resume
			</button>
		{:else}
			<span class="hidden truncate text-xs text-muted-foreground sm:inline" title={modeInfo(st.mode).hint}>
				{st.mode === 'bypass' ? 'Everything runs without asking' : st.mode === 'auto' ? 'A classifier decides' : 'Risky tools ask'}
				<kbd class="ml-1 rounded border border-border px-1 text-[10px]">⇧Tab</kbd>
			</span>
		{/if}
	</div>

{/if}
