<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import AgentsPanel from '#lib/components/app/developers/AgentsPanel.svelte';
	import KeysPanel from '#lib/components/app/developers/KeysPanel.svelte';
	import RequestsPanel from '#lib/components/app/developers/RequestsPanel.svelte';
	import TryIt from '#lib/components/app/developers/TryIt.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import type { ApiAgent, ApiKeyView, ApiUsage } from '#lib/developers/model.js';

	let tab = $state<'agents' | 'keys' | 'requests' | 'try'>('agents');
	let agents = $state<ApiAgent[] | null>(null);
	let keys = $state<ApiKeyView[]>([]);
	let usage = $state<ApiUsage | null>(null);
	let error = $state('');
	// bumps on every change so the requests tab reloads
	let version = $state(0);

	async function load(): Promise<void> {
		try {
			const [a, k, u] = await Promise.all([api.get('/developer/agents', {}), api.get('/developer/keys', {}), api.get('/developer/usage', { query: { days: 14 } })]);
			agents = a.agents;
			keys = k.keys;
			usage = u;
			error = '';
			version += 1;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the Developers page';
		}
	}
	onMount(() => void load());
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Developers" description="Let other applications call isolated agents with an API key." />
	<PageBody size="wide" class="gap-4">
		{#if error && agents === null}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Try again</button></p>
		{:else if agents === null}
			<div class="flex flex-col gap-3" aria-busy="true"><Skeleton class="h-10 w-64" /><Skeleton class="h-28 w-full rounded-xl" /></div>
		{:else}
			<Tabs.Root bind:value={tab} class="gap-4">
				<Tabs.List variant="line" class="h-10 gap-4">
					<Tabs.Trigger value="agents" data-testid="tab-agents">API agents</Tabs.Trigger>
					<Tabs.Trigger value="keys" data-testid="tab-keys">Keys</Tabs.Trigger>
					<Tabs.Trigger value="requests" data-testid="tab-requests">Requests</Tabs.Trigger>
					<Tabs.Trigger value="try" data-testid="tab-try">Try it</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>
			{#if tab === 'agents'}
				<AgentsPanel {agents} onChanged={() => void load()} />
			{:else if tab === 'keys'}
				<KeysPanel {keys} {agents} {usage} onChanged={() => void load()} onCreated={() => {}} />
			{:else if tab === 'requests'}
				<RequestsPanel {keys} {agents} {version} />
			{:else}
				<TryIt {agents} />
			{/if}
		{/if}
	</PageBody>
</div>
