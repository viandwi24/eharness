<script lang="ts">
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { getToken, setToken } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	let token = $state(getToken() ?? '');
	let saved = $state(false);

	function save() {
		setToken(token.trim());
		saved = true;
		void agentsStore.load();
	}
</script>

<div class="flex min-w-0 flex-1 flex-col">
	<PageHeader title="Settings" />
	<form class="flex max-w-xl flex-col gap-3 p-4 text-sm" onsubmit={(e) => (e.preventDefault(), save())}>
		<label class="flex flex-col gap-1">
			<span class="font-medium">Server token</span>
			<Input type="password" bind:value={token} placeholder="TEAM_TOKEN (empty if the server is open)" autocomplete="off" />
			<span class="text-xs text-muted-foreground">Stored in this browser only. PUBLIC_TEAM_TOKEN overrides it.</span>
		</label>
		<Button type="submit" class="self-start">Save token</Button>
		{#if saved}<span class="text-xs text-muted-foreground">Saved.</span>{/if}
		<!-- MOCK: workspace memory, default permission mode, budgets and usage are not served yet. -->
		<p class="text-muted-foreground">Workspace memory, default permission mode, budgets and usage come in a later milestone.</p>
	</form>
</div>
