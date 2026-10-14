<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { formatBytes, formatCpu, formatMb, type BrowserUsage } from '#lib/browser/model.js';

	/**
	 * Memory and CPU of the running browsers, polled every few seconds while the tab is visible.
	 * Resources are shown, not capped: people judge them against the free memory of the server.
	 * `profileId`: only that profile's row (the detail page).
	 */
	let { profileId, intervalMs = 4000 }: { profileId?: string; intervalMs?: number } = $props();
	let usage = $state<BrowserUsage | null>(null);
	let failed = $state(false);

	async function load(): Promise<void> {
		try {
			usage = await api.get('/browser/usage');
			failed = false;
		} catch {
			failed = true;
		}
	}
	onMount(() => {
		void load();
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') void load();
		}, intervalMs);
		return () => clearInterval(t);
	});
	const rows = $derived((usage?.profiles ?? []).filter((r) => profileId === undefined || r.profileId === profileId));
	const freePct = $derived(usage?.system ? Math.round((usage.system.freeBytes / Math.max(1, usage.system.totalBytes)) * 100) : null);
</script>

<section class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4" aria-label="Resources" data-testid="browser-usage">
	<h2 class="text-sm font-medium">Resources</h2>
	{#if usage === null}
		<p class="text-xs text-muted-foreground">{failed ? 'Could not read the usage.' : 'Reading…'}</p>
	{:else}
		{#if rows.length === 0}
			<p class="text-xs text-muted-foreground">{profileId ? 'This browser is not running.' : 'No browser is running.'}</p>
		{:else}
			<table class="w-full text-left text-xs">
				<thead class="text-muted-foreground"><tr>{#if !profileId}<th class="py-1 font-normal">Profile</th>{/if}<th class="py-1 font-normal">Memory</th><th class="py-1 font-normal">CPU</th></tr></thead>
				<tbody>
					{#each rows as r (r.profileId)}
						<tr class="border-t border-border">
							{#if !profileId}<td class="py-1 pr-2"><a class="hover:underline" href="/browser/{r.profileId}">{r.name}</a></td>{/if}
							<td class="py-1 font-mono">{formatMb(r.rssBytes)}</td>
							<td class="py-1 font-mono">{formatCpu(r.cpuPercent)}</td>
						</tr>
					{/each}
					{#if !profileId && rows.length > 1}
						<tr class="border-t border-border font-medium"><td class="py-1">Total</td><td class="py-1 font-mono">{formatMb(usage.totals.rssBytes)}</td><td class="py-1 font-mono">{formatCpu(usage.totals.cpuPercent)}</td></tr>
					{/if}
				</tbody>
			</table>
		{/if}
		{#if usage.system}
			<p class="text-xs text-muted-foreground" data-testid="browser-free-memory">
				Server memory: {formatBytes(usage.system.freeBytes)} free of {formatBytes(usage.system.totalBytes)}{freePct !== null ? ` (${freePct} %)` : ''}.
			</p>
		{/if}
	{/if}
</section>
