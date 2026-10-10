<script lang="ts">
	import { untrack } from 'svelte';
	import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDown';
	import { toast } from 'svelte-sonner';
	import { Kbd, KbdGroup } from '#lib/components/ui/kbd/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
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

	const tone = (m: TeamMode): string => {
		const t = modeInfo(m).tone;
		if (t === 'danger') return 'bg-destructive-soft text-destructive-text';
		if (t === 'info') return 'bg-info-soft text-info-text';
		return 'text-muted-foreground hover:bg-muted hover:text-foreground';
	};
	// One-line descriptions for the menu (the full hints stay in Settings).
	const short: Record<TeamMode, string> = {
		manual: 'Risky tools ask you first',
		auto: 'A classifier model decides',
		bypass: 'Everything runs without asking'
	};
	const disabledWhy = (m: TeamMode): string | null => {
		if (!st || st.available.includes(m)) return null;
		if (m === 'auto' && !st.autoAvailable) return 'Auto needs a classifier model, which this server does not have.';
		return `This agent's own mode does not allow ${modeInfo(m).label}.`;
	};
</script>

{#if st}
	<div class="flex min-w-0 items-center gap-1.5">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring {tone(st.mode)}"
				aria-label="Permission mode: {modeInfo(st.mode).label}"
				title="{modeInfo(st.mode).hint} (⇧Tab to switch)"
				data-testid="mode-switch"
				data-mode={st.mode}
			>
				{modeInfo(st.mode).label}
				<CaretUpDownIcon class="size-3.5 opacity-70" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content elevation="floating" side="top" align="start" class="w-64">
				<div class="flex items-center justify-between px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
					<span>Permission mode</span>
					<KbdGroup><Kbd>⇧</Kbd><Kbd>Tab</Kbd></KbdGroup>
				</div>
				<DropdownMenu.RadioGroup value={st.mode} onValueChange={(v) => void pick(v as TeamMode)}>
					{#each teamModes as m (m.id)}
						{@const why = disabledWhy(m.id)}
						<DropdownMenu.RadioItem closeOnSelect value={m.id} disabled={why !== null} class="h-auto items-start py-1.5">
							<span class="flex flex-col gap-0.5">
								<span class={m.tone === 'danger' ? 'text-destructive-text' : ''}>{m.label}</span>
								<span class="text-xs text-muted-foreground">{why ?? short[m.id]}</span>
							</span>
						</DropdownMenu.RadioItem>
					{/each}
				</DropdownMenu.RadioGroup>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
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
		{/if}
	</div>
{/if}
