<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { ScriptTypes } from '#lib/scripts/scripts.js';

	/** The `ctx` API scripts are written against: the methods, and the `scripts.d.ts` text. Loads on open. */
	let open = $state(false);
	let types = $state<ScriptTypes | null>(null);
	let error = $state('');
	let loading = $state(false);
	let showDts = $state(false);

	async function load(): Promise<void> {
		if (types || loading) return;
		loading = true;
		error = '';
		try {
			types = await api.get('/scripts-types');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the API reference';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open) void load();
	});
</script>

<Collapsible.Root bind:open class="rounded-md border border-border">
	<Collapsible.Trigger class="group flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium hover:bg-accent/50">
		<CaretDownIcon class="size-3.5 transition-transform group-data-[state=open]:rotate-180" /> API reference
		<span class="text-xs font-normal text-muted-foreground">— what <code class="font-mono">ctx</code> offers</span>
	</Collapsible.Trigger>
	<Collapsible.Content class="border-t border-border px-3 py-3">
		{#if loading}
			<Spinner class="size-4" />
		{:else if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if types}
			<p class="mb-2 text-xs text-muted-foreground">Also <code class="font-mono">ctx.log(...)</code> (or <code class="font-mono">console.log</code>) and <code class="font-mono">ctx.sleep(ms)</code>. Calls marked "side effect" are recorded, not done, in a dry run. Every call needs a grant in the manifest.</p>
			<ul class="flex max-h-96 flex-col divide-y divide-border overflow-auto">
				{#each types.methods as m (m.name)}
					<li class="py-2 text-xs">
						<div class="flex flex-wrap items-center gap-2">
							<code class="font-mono font-medium">ctx.{m.name}</code>
							{#if m.sideEffect}<Badge variant="warning">side effect</Badge>{/if}
						</div>
						<p class="mt-0.5 text-muted-foreground">{m.doc}</p>
						<p class="mt-0.5 font-mono break-words text-muted-foreground">({m.args === 'void' ? '' : `input: ${m.args}`}) → {m.returns}</p>
					</li>
				{/each}
			</ul>
			<button type="button" class="mt-2 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" onclick={() => (showDts = !showDts)}>{showDts ? 'Hide' : 'Show'} scripts.d.ts</button>
			{#if showDts}
				<pre class="mt-2 max-h-96 overflow-auto rounded-md border border-sk-bd bg-sk-bg p-2.5 font-mono text-xs leading-5">{types.types}</pre>
			{/if}
		{/if}
	</Collapsible.Content>
</Collapsible.Root>
