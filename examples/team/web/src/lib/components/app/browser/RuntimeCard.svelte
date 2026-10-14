<script lang="ts">
	import { onMount } from 'svelte';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { formatBytes, runtimeView, type BrowserRuntime } from '#lib/browser/model.js';

	/**
	 * The managed engine of an adapter: Missing, Installing (bytes / total, polled), Ready, Running;
	 * Install / Update / Remove, version, disk size, and the last error with a retry.
	 */
	let { adapter, label, runtime: initial, onChange }: { adapter: string; label: string; runtime: BrowserRuntime | null; onChange?: (r: BrowserRuntime) => void } = $props();
	let runtime = $state<BrowserRuntime | null>(null);
	let busy = $state(false);
	$effect(() => {
		runtime = initial;
	});
	const view = $derived(runtime ? runtimeView(runtime) : undefined);

	async function refresh(): Promise<void> {
		try {
			runtime = await api.get('/browser/runtimes/{adapter}', { params: { adapter } });
			onChange?.(runtime);
		} catch {
			// next poll tries again
		}
	}
	onMount(() => {
		const t = setInterval(() => {
			if (runtime?.state === 'installing') void refresh();
		}, 1000);
		return () => clearInterval(t);
	});

	async function act(kind: 'install' | 'uninstall'): Promise<void> {
		busy = true;
		try {
			runtime = await api.post(kind === 'install' ? '/browser/runtimes/{adapter}/install' : '/browser/runtimes/{adapter}/uninstall', { params: { adapter } });
			onChange?.(runtime);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not do that');
		} finally {
			busy = false;
		}
	}
</script>

{#if runtime && view}
	<div class="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="runtime-card" data-state={runtime.state}>
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-sm font-medium">{label} engine</span>
			<Badge variant={view.variant}>{view.label}</Badge>
			{#if runtime.version}<span class="text-xs text-muted-foreground">version {runtime.version}</span>{/if}
			{#if runtime.diskBytes}<span class="text-xs text-muted-foreground">{formatBytes(runtime.diskBytes)} on disk</span>{/if}
			<div class="ml-auto flex gap-2">
				{#if runtime.state === 'missing' || runtime.state === 'error'}
					<Button size="sm" disabled={busy} onclick={() => void act('install')} data-testid="runtime-install"><DownloadSimpleIcon class="size-4" /> {runtime.state === 'error' ? 'Retry' : 'Install'}</Button>
				{:else if runtime.state === 'ready' || runtime.state === 'running'}
					<Button size="sm" variant="outline" disabled={busy} onclick={() => void act('install')}>Update</Button>
					<Button size="sm" variant="ghost" disabled={busy || runtime.state === 'running'} onclick={() => void act('uninstall')} title={runtime.state === 'running' ? 'Stop the running browsers first' : undefined}>Remove</Button>
				{/if}
			</div>
		</div>
		{#if runtime.state === 'installing'}
			<div class="flex flex-col gap-1" role="progressbar" aria-label="Download progress" aria-valuenow={view.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
				<div class="h-2 overflow-hidden rounded-full bg-muted">
					<div class="h-full bg-brand transition-[width] {view.percent === null ? 'w-1/3 animate-pulse' : ''}" style={view.percent === null ? '' : `width:${view.percent}%`}></div>
				</div>
				<span class="text-xs text-muted-foreground">{formatBytes(runtime.progress?.received ?? 0)}{runtime.progress?.total ? ` of ${formatBytes(runtime.progress.total)}` : ''}</span>
			</div>
		{/if}
		{#if runtime.error}<p class="text-xs text-destructive-text" role="alert">{runtime.error}</p>{/if}
	</div>
{/if}
