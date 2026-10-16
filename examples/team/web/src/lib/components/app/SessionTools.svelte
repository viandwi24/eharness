<script lang="ts">
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import { api } from '#lib/api/index.js';
	import { Alert, AlertDescription, AlertTitle } from '#lib/components/ui/alert/index.js';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { groupSessionTools, TOOL_STATE_LABEL, type SessionTools, type ToolState } from '#lib/session/tools-view.js';
	import { formatDateTime } from '#lib/time.js';

	/**
	 * "Tools in this session": what the agent is configured with against what its last model call
	 * really carried (loaded, on demand, missing), and a forced reload for urgent cases.
	 */
	let { open = $bindable(false), sessionId }: { open: boolean; sessionId: string } = $props();

	let raw = $state<SessionTools | null>(null);
	let error = $state('');
	let reloading = $state(false);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/sessions/{id}/tools', { params: { id: sessionId } });
			if (mine === seq) {
				raw = r;
				error = '';
			}
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not read the tools';
		}
	}

	let loadedFor = '';
	$effect(() => {
		if (!open) return;
		if (loadedFor !== sessionId) {
			loadedFor = sessionId;
			raw = null;
		}
		void load();
	});

	async function reload(): Promise<void> {
		reloading = true;
		try {
			const r = await api.post('/sessions/{id}/reload', { params: { id: sessionId } });
			toast.success(
				(r.pending
					? 'The agent is busy: its tools reload right after this turn. The next message uses the fresh tools.'
					: 'Tools reloaded. The next message uses the fresh tools.') + (r.pinsCleared > 0 ? ' The new tool definitions of the servers are accepted.' : '')
			);
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not reload the tools');
		} finally {
			reloading = false;
		}
	}

	const view = $derived(raw === null ? null : groupSessionTools(raw));
	const VARIANT: Record<ToolState, BadgeVariant> = {
		loaded: 'success',
		deferred: 'info',
		missing: 'destructive',
		blocked: 'warning',
		off: 'secondary',
		'chat-off': 'secondary',
		unchecked: 'outline'
	};
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
		<Sheet.Header class="gap-1 border-b border-border pb-4">
			<Sheet.Title>Tools in this session</Sheet.Title>
			<Sheet.Description>
				What this agent is set up with, and what its last model call really carried.
				{#if raw?.lastCall}Last call: {formatDateTime(raw.lastCall.at)}.{/if}
			</Sheet.Description>
			<div class="pt-2">
				<Button size="sm" variant="outline" onclick={reload} disabled={reloading}>
					{#if reloading}<Spinner class="size-3.5" /> Reloading...{:else}<ArrowClockwiseIcon class="size-3.5" /> Reload tools{/if}
				</Button>
				<p class="pt-1.5 text-xs text-muted-foreground">Refreshes the connectors (remote tool lists are fetched again) and gives this chat a fresh start on its next message. A running turn is not cut.</p>
			</div>
		</Sheet.Header>

		<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-[22px]">
			{#if error}
				<p class="text-sm text-destructive-text" role="alert">{error}</p>
			{:else if view === null}
				<div class="space-y-2" aria-busy="true" aria-label="Loading"><Skeleton class="h-5 w-2/3" /><Skeleton class="h-4 w-full" /><Skeleton class="h-4 w-4/5" /></div>
			{:else}
				{#if view.blocked.length}
					<Alert variant="warning">
						<WarningIcon weight="fill" aria-hidden="true" />
						<AlertTitle>Changed on the server</AlertTitle>
						<AlertDescription>
							<p class="text-xs">The server changed these tools after this chat first saw them. For safety they stay off until you accept the new definitions.</p>
							<p class="font-mono text-xs break-words">{view.blocked.join(', ')}</p>
							<div class="pt-1"><Button size="sm" variant="outline" onclick={reload} disabled={reloading}>{#if reloading}<Spinner class="size-3.5" /> Accepting...{:else}Accept &amp; reload{/if}</Button></div>
						</AlertDescription>
					</Alert>
				{/if}
				{#if view.missing.length}
					<Alert variant="warning">
						<WarningIcon weight="fill" aria-hidden="true" />
						<AlertTitle>The agent did not get these tools in its last call</AlertTitle>
						<AlertDescription>
							<p class="font-mono text-xs break-words">{view.missing.join(', ')}</p>
							<p class="text-xs">If you allowed them after that call, send a message first. Otherwise use Reload tools.</p>
						</AlertDescription>
					</Alert>
				{/if}
				{#if !view.checked && raw?.lastCallNote}
					<p class="text-xs text-muted-foreground">{raw.lastCallNote}</p>
				{/if}
				{#each view.groups as g (g.key)}
					<section class="space-y-1.5" aria-label={g.title}>
						<h3 class="text-sm font-medium">{g.summary}</h3>
						<ul class="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
							{#each g.rows as r (r.name)}
								<li class="flex items-center justify-between gap-2 px-3 py-1.5">
									<span class="min-w-0 truncate font-mono text-xs {r.state === 'off' || r.state === 'chat-off' ? 'text-muted-foreground' : ''}" title={r.name}>{r.name}{r.asks ? ' · asks first' : ''}</span>
									<Badge variant={VARIANT[r.state]}>{TOOL_STATE_LABEL[r.state]}</Badge>
								</li>
							{/each}
						</ul>
					</section>
				{:else}
					<p class="text-sm text-muted-foreground">No tools are configured for this agent.</p>
				{/each}
				{#if view.extra.length}
					<p class="text-xs text-muted-foreground">Also in the last call (app and plugin tools): {view.extra.join(', ')}</p>
				{/if}
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
