<script lang="ts">
	import BellIcon from 'phosphor-svelte/lib/Bell';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import type { ChannelConnection, ChannelReminder } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// Reminders created from chats ("remind the group at 15:00"): where they post, when (absolute
	// time in the team timezone), whom they mention. They are posted as written, without a model call.
	let { conn }: { conn: ChannelConnection } = $props();

	let items = $state<ChannelReminder[]>([]);
	let all = $state(false);
	let busy = $state(false);

	async function load(): Promise<void> {
		try {
			items = (await api.get('/channels/connections/{id}/reminders', { params: { id: conn.id }, query: { all: all ? 'true' : 'false' } })).items;
		} catch {
			// next refresh
		}
	}
	$effect(() => {
		void all;
		void load();
	});

	async function cancel(r: ChannelReminder): Promise<void> {
		busy = true;
		try {
			await api.delete('/channels/connections/{id}/reminders/{reminderId}', { params: { id: conn.id, reminderId: r.id } });
			toast.success('Reminder cancelled');
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not cancel the reminder');
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-3" data-testid="reminders-tab">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-xs text-muted-foreground">Owners and admins can set reminders for the group or for other people, members only for themselves. Cancel one here or in the chat.</p>
		<label class="flex items-center gap-2 text-xs text-muted-foreground"><Switch size="sm" bind:checked={all} aria-label="Show finished reminders" /> Show finished</label>
	</div>
	{#if items.length === 0}
		<p class="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground" data-testid="no-reminders">No reminders. Ask the agent in a chat: "remind the group tomorrow at 9:00 to send the report".</p>
	{:else}
		<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
			{#each items as r (r.id)}
				<li class="flex items-start gap-3 p-3" data-testid="reminder">
					<BellIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2 text-sm">
							<span class="truncate">{r.text}</span>
							<Badge variant={r.status === 'active' ? 'default' : 'secondary'}>{r.status}</Badge>
						</div>
						<div class="text-xs text-muted-foreground">
							{r.whenText} · in {r.chatTitle}{r.mentions.length ? ` · mentions ${r.mentions.join(', ')}` : ''}{r.createdByName ? ` · set by ${r.createdByName}${r.createdByRole ? ` (${r.createdByRole})` : ''}` : ''}{r.lastFiredAt ? ` · last posted ${formatTime(r.lastFiredAt)}` : ''}
						</div>
						{#if r.lastError}<div class="text-xs text-destructive-text">{r.lastError}</div>{/if}
					</div>
					{#if r.status === 'active'}<Button size="sm" variant="ghost" onclick={() => void cancel(r)} disabled={busy}>Cancel</Button>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
