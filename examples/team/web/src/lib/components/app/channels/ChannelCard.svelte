<script lang="ts">
	import TelegramLogoIcon from 'phosphor-svelte/lib/TelegramLogo';
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import StatusBadges from './StatusBadges.svelte';
	import { attentionOf, channelHref, connectionHandle, type ChannelConnection } from '#lib/channels/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// One connected channel in the list: what it is, how it is doing, who answers, a few numbers.
	// The whole card is the link to its page.
	let { conn }: { conn: ChannelConnection } = $props();

	const agentName = $derived(conn.binding ? (agentsStore.state.agents.find((a) => a.id === conn.binding?.agentId)?.name ?? 'an agent') : undefined);
	const handle = $derived(connectionHandle(conn));
	const attention = $derived(attentionOf(conn));
	const stats = $derived([
		{ label: conn.transport === 'user' ? 'chats read' : 'chats', value: conn.counts.chats },
		{ label: 'linked', value: conn.counts.linked },
		{ label: 'not linked', value: conn.counts.unlinked, warn: conn.counts.unlinked > 0 },
		{ label: 'waiting to send', value: conn.counts.outboxPending },
		...(conn.counts.outboxFailed > 0 ? [{ label: 'failed', value: conn.counts.outboxFailed, warn: true }] : [])
	]);
</script>

<a
	href={channelHref(conn.id)}
	class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors outline-none hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
	data-testid="channel-card"
	aria-label="{conn.label}, open"
>
	<div class="flex items-start gap-3">
		<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info-text"><TelegramLogoIcon class="size-5" /></span>
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<h2 class="truncate text-sm font-medium">{conn.label}</h2>
				{#if handle}<span class="truncate text-xs text-muted-foreground">{handle}</span>{/if}
			</div>
			<div class="mt-1.5 flex flex-wrap items-center gap-1.5"><StatusBadges {conn} /></div>
		</div>
	</div>
	<p class="text-xs text-muted-foreground">
		{#if agentName}Answered by <span class="font-medium text-foreground">{agentName}</span>{:else}No agent yet{/if}
	</p>
	<dl class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
		{#each stats as s (s.label)}
			<div class="flex items-baseline gap-1"><dt class="sr-only">{s.label}</dt><dd class="font-mono tabular-nums {s.warn ? 'text-warning-text' : ''}">{s.value}</dd><span class="text-muted-foreground" aria-hidden="true">{s.label}</span></div>
		{/each}
	</dl>
	{#if attention.length > 0}
		<p class="flex gap-1.5 text-xs text-warning-text" data-testid="card-attention"><WarningIcon class="mt-0.5 size-3.5 shrink-0" /> <span class="min-w-0">{attention[0]}{attention.length > 1 ? ` (+${attention.length - 1} more)` : ''}</span></p>
	{/if}
</a>
