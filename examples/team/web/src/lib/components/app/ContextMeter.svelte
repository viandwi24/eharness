<script lang="ts">
	import { api } from '#lib/api/index.js';
	import type { Task } from '#lib/api/client.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { contextView, formatTokens, type ChatStats } from '#lib/context.js';
	import ContextUsage from './ContextUsage.svelte';

	/**
	 * Context usage of the agent's DM chat in the composer: a donut and the percentage; hover or click
	 * opens the breakdown (context, compaction, usage and cost). Refreshes when a message is stored.
	 */
	let { agentId }: { agentId: string } = $props();

	let stats = $state<ChatStats | null>(null);
	let tasks = $state<{ owned: Task[]; delegated: Task[] }>({ owned: [], delegated: [] });
	let open = $state(false);
	let seq = 0;
	let loaded: string | undefined;
	const id = $derived(agentsStore.find(agentId)?.id ?? agentId);

	$effect(() => {
		const agent = id;
		void live.state.revs.chat;
		if (agent !== loaded) {
			loaded = agent;
			stats = null;
		}
		const mine = ++seq;
		api.get('/agents/{id}/stats', { params: { id: agent } }).then(
			(s) => {
				if (mine === seq) stats = s;
			},
			() => {} // the indicator is optional: keep the last numbers
		);
	});

	// Task costs only matter in the popover: load them when it opens.
	$effect(() => {
		if (!open) return;
		const agent = id;
		api.get('/agents/{id}/sessions', { params: { id: agent } }).then(
			(r) => (tasks = { owned: r.tasks, delegated: r.delegated }),
			() => {}
		);
	});

	// Hover opens after a short delay and closes when the pointer leaves trigger and popover.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const hover = (next: boolean, ms: number) => () => {
		clearTimeout(timer);
		timer = setTimeout(() => (open = next), ms);
	};

	const view = $derived(stats ? contextView(stats.context) : null);
	const tone = $derived(view?.over ? 'text-destructive-text' : view?.near ? 'text-warning-text' : 'text-muted-foreground');

	// Donut: one arc per segment (instructions, tools, messages) on a faint track.
	const R = 7;
	const C = 2 * Math.PI * R;
	const arcs = $derived.by(() => {
		if (!view) return [];
		let at = 0;
		return view.segments.map((s) => {
			const len = (C * Math.min(s.pct, 100 - at)) / 100;
			const arc = { key: s.key, len, offset: (-C * at) / 100 };
			at += s.pct;
			return arc;
		});
	});
	const shade: Record<string, number> = { instructions: 0.9, tools: 0.6, messages: 0.35 };
</script>

{#if view && stats}
	<Popover.Root bind:open>
		<Popover.Trigger
			class="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors hover:bg-muted {tone}"
			aria-label="Context used {view.pct}%, {formatTokens(stats.context.window - stats.context.tokens)} tokens left"
			data-testid="context-meter"
			onpointerenter={hover(true, 150)}
			onpointerleave={hover(false, 200)}
		>
			<svg viewBox="0 0 18 18" class="size-[18px] -rotate-90" aria-hidden="true">
				<circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" stroke-opacity="0.15" stroke-width="3" />
				{#each arcs as a (a.key)}
					<circle
						cx="9"
						cy="9"
						r={R}
						fill="none"
						stroke="currentColor"
						stroke-opacity={view.near ? 1 : shade[a.key]}
						stroke-width="3"
						stroke-dasharray="{a.len} {C}"
						stroke-dashoffset={a.offset}
					/>
				{/each}
			</svg>
			<span class="tabular-nums">{view.pct}%</span>
		</Popover.Trigger>
		<Popover.Content
			side="top"
			align="start"
			class="w-80 p-3 text-sm"
			onpointerenter={hover(true, 0)}
			onpointerleave={hover(false, 200)}
			onOpenAutoFocus={(e) => e.preventDefault()}
		>
			<ContextUsage {stats} owned={tasks.owned} delegated={tasks.delegated} />
		</Popover.Content>
	</Popover.Root>
{/if}
