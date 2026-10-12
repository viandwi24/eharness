<script lang="ts">
	import { untrack } from 'svelte';
	import type { AgentConnector } from '#lib/api/index.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { splitLines } from '#lib/programs/form.js';

	/**
	 * What the program may use: a picker over the agent's real connectors and what each can do.
	 * Choices write to the same two line lists the form saves (`tools`, `connectors`); a rule the
	 * picker does not know (`WebFetch(domain:example.com)`) stays editable under "Other rules".
	 */
	let { agentId, tools = $bindable(), connectors = $bindable() }: { agentId: string; tools: string; connectors: string } = $props();

	let list = $state<AgentConnector[]>([]);
	let loaded = $state(false);
	let failed = $state(false);

	$effect(() => {
		const id = agentId;
		untrack(() => {
			list = [];
			failed = false;
			loaded = !id;
		});
		if (!id) return;
		let stale = false;
		connectorsStore.agentConnectors(id).then(
			(l) => {
				if (stale) return;
				list = l.filter((c) => c.enabled);
				loaded = true;
			},
			() => {
				if (stale) return;
				failed = true;
				loaded = true;
			}
		);
		return () => {
			stale = true;
		};
	});

	const toolSet = $derived(new Set(splitLines(tools)));
	const connectorSet = $derived(new Set(splitLines(connectors)));

	/** The names the agent really calls a capability's tools by (prefixed per connection); bare names for older servers. */
	const namesOf = (cap: AgentConnector['capabilities'][number]): string[] => cap.agentTools ?? cap.tools;

	function toggleConnector(id: string, on: boolean): void {
		const s = new Set(connectorSet);
		if (on) s.add(id);
		else s.delete(id);
		connectors = [...s].join('\n');
	}
	function toggleTools(names: string[], on: boolean): void {
		const s = new Set(toolSet);
		for (const n of names) {
			if (on) s.add(n);
			else s.delete(n);
		}
		tools = [...s].join('\n');
	}
</script>

<div class="flex flex-col gap-2" data-testid="tool-picker">
	<span class="font-medium">What it may use</span>
	{#if !agentId}
		<p class="text-xs text-muted-foreground">Choose an agent to see its tools.</p>
	{:else if !loaded}
		<p class="text-xs text-muted-foreground">Loading the agent's tools…</p>
	{:else if failed}
		<p class="text-xs text-destructive-text" role="alert">Could not load this agent's tools. You can still type rules under "Other rules".</p>
	{:else if list.length === 0}
		<p class="text-xs text-muted-foreground">This agent has no connectors turned on. Its built-in tools are named under "Other rules".</p>
	{/if}
	{#each list as c (c.connectionId)}
		<div class="rounded-md border border-border px-3 py-2">
			<label class="flex items-center gap-2 text-[13px] font-medium">
				<input type="checkbox" checked={connectorSet.has(c.connectionId)} onchange={(e) => toggleConnector(c.connectionId, e.currentTarget.checked)} />
				<span class="min-w-0 truncate">{c.label}</span>
				<span class="text-xs font-normal text-muted-foreground">everything it can do</span>
			</label>
			{#if !connectorSet.has(c.connectionId) && c.capabilities.length}
				<div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-6">
					{#each c.capabilities as cap (cap.id)}
						<label class="flex items-center gap-1.5 text-xs" title={cap.description}>
							<input type="checkbox" checked={namesOf(cap).length > 0 && namesOf(cap).every((t) => toolSet.has(t))} onchange={(e) => toggleTools(namesOf(cap), e.currentTarget.checked)} />
							{cap.title}
						</label>
					{/each}
				</div>
			{/if}
		</div>
	{/each}
	<details class="text-xs">
		<summary class="cursor-pointer text-muted-foreground">Other rules (built-in tools, advanced)</summary>
		<Textarea bind:value={tools} rows={3} placeholder={'web_fetch\nWebFetch(domain:example.com)'} class="mt-1 font-mono text-xs" aria-label="Other tool rules" />
		<span class="text-muted-foreground">One tool name or rule per line. It is checked against what this agent really has.</span>
	</details>
</div>
