<script lang="ts">
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlash';
	import LinkIcon from 'phosphor-svelte/lib/Link';
	import UserPlusIcon from 'phosphor-svelte/lib/UserPlus';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import ChannelDirectory from '#lib/components/app/ChannelDirectory.svelte';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import { peerIdError, unlinkedDetail, unlinkedLabel, type ChannelConnection, type ChannelLink, type ChannelMember, type ChannelUnlinked } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// People of one connection (bot or account): who wrote and is not linked yet, a manual form to
	// link by Telegram user id, the linked accounts, and the "reply to unknown people" switch.
	// Nobody is linked through a link or a token: the owner picks the person here.
	let { conn, onChange }: { conn: ChannelConnection; onChange: () => void } = $props();

	let unlinked = $state<ChannelUnlinked[]>([]);
	let links = $state<ChannelLink[]>([]);
	let members = $state<ChannelMember[]>([{ id: 'owner', name: 'Owner' }]);
	let showIgnored = $state(false);
	let busy = $state(false);
	let picking = $state<string | null>(null);
	let pickMember = $state('owner');
	let manualId = $state('');
	let manualMember = $state('owner');
	let manualName = $state('');
	let revoke = $state<ChannelLink | null>(null);
	let revokeOpen = $state(false);

	const idProblem = $derived(manualId.trim() === '' ? undefined : peerIdError(manualId));
	const memberName = (id: string): string => members.find((m) => m.id === id)?.name ?? id;
	const shown = $derived(showIgnored ? unlinked : unlinked.filter((u) => !u.ignored));
	const ignoredCount = $derived(unlinked.filter((u) => u.ignored).length);

	async function load(): Promise<void> {
		try {
			const [u, l, m] = await Promise.all([
				api.get('/channels/connections/{id}/unlinked', { params: { id: conn.id }, query: { includeIgnored: 'true' } }),
				api.get('/channels/connections/{id}/links', { params: { id: conn.id } }),
				api.get('/channels/connections/{id}/members', { params: { id: conn.id } })
			]);
			unlinked = u.items;
			links = l.items;
			members = m.items.length > 0 ? m.items : members;
		} catch {
			// the lists follow on the next refresh
		}
	}
	$effect(() => {
		void conn.counts.linked;
		void conn.counts.unlinked;
		void load();
	});

	const run = async (what: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
		busy = true;
		try {
			await fn();
			if (ok) toast.success(ok);
			onChange();
			await load();
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what}`);
			return false;
		} finally {
			busy = false;
		}
	};

	async function link(peerId: string, memberId: string, name?: string): Promise<boolean> {
		return run('link the account', () => api.post('/channels/connections/{id}/links', { params: { id: conn.id }, body: { peerId, memberId, ...(name ? { name } : {}) } }), 'Linked');
	}
	async function linkPicked(u: ChannelUnlinked): Promise<void> {
		if (await link(u.peerId, pickMember)) picking = null;
	}
	async function linkManual(): Promise<void> {
		if (manualId.trim() === '' || idProblem) return;
		if (await link(manualId.trim(), manualMember, manualName.trim() || undefined)) {
			manualId = '';
			manualName = '';
		}
	}
	const ignore = (u: ChannelUnlinked, ignored: boolean): Promise<boolean> =>
		run('change this', () => api.put('/channels/connections/{id}/unlinked/{peerId}/ignored', { params: { id: conn.id, peerId: u.peerId }, body: { ignored } }), ignored ? 'Ignored' : 'Back in the list');
	const doRevoke = async (): Promise<void> => {
		if (revoke === null) return;
		await run('unlink', () => api.delete('/channels/connections/{id}/links/{peerId}', { params: { id: conn.id, peerId: revoke!.peerId } }), 'Account unlinked');
	};
	const setReply = (on: boolean): Promise<boolean> =>
		conn.binding === null
			? Promise.resolve(false)
			: run('change this', () => api.put('/channels/connections/{id}/binding', { params: { id: conn.id }, body: { agentId: conn.binding!.agentId, replyToUnknown: on } }), on ? 'Unknown people get a short reply' : 'Unknown people get silence');
</script>

<div class="flex flex-col gap-4" data-testid="people-tab">
	<ChannelDirectory {conn} {onChange} />
	<p class="text-xs text-muted-foreground">
		Only linked people can talk to the agent in a direct message. Anyone else who writes directly is listed below, and gets no answer. Link them to a team member, or ignore them.
	</p>

	<div class="flex flex-col gap-2">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h3 class="text-xs font-medium">Not linked yet {#if shown.length}<Badge shape="number" variant="secondary">{shown.length}</Badge>{/if}</h3>
			{#if ignoredCount > 0}
				<label class="flex items-center gap-2 text-xs text-muted-foreground"><Switch size="sm" bind:checked={showIgnored} aria-label="Show ignored people" /> Show {ignoredCount} ignored</label>
			{/if}
		</div>
		{#if shown.length === 0}
			<p class="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground" data-testid="no-unlinked">Nobody is waiting. When somebody who is not linked writes to this {conn.transport === 'user' ? 'account' : 'bot'} in a direct message, they show up here (their name and how often, never what they wrote).</p>
		{:else}
			<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
				{#each shown as u (u.peerId)}
					<li class="flex flex-col gap-2 p-3" data-testid="unlinked-person">
						<div class="flex flex-wrap items-center gap-3">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2"><span class="truncate text-sm">{unlinkedLabel(u)}</span>{#if u.ignored}<Badge variant="secondary">Ignored</Badge>{/if}</div>
								<div class="text-xs text-muted-foreground">{unlinkedDetail(u, Date.now())}</div>
							</div>
							<div class="flex items-center gap-1">
								<Button size="sm" variant="outline" onclick={() => { picking = picking === u.peerId ? null : u.peerId; }} disabled={busy} data-testid="link-person"><LinkIcon class="size-4" /> Link to member…</Button>
								{#if u.ignored}
									<Button size="sm" variant="ghost" onclick={() => void ignore(u, false)} disabled={busy}>Stop ignoring</Button>
								{:else}
									<Button size="sm" variant="ghost" onclick={() => void ignore(u, true)} disabled={busy} data-testid="ignore-person"><EyeSlashIcon class="size-4" /> Ignore</Button>
								{/if}
							</div>
						</div>
						{#if picking === u.peerId}
							<div class="flex flex-wrap items-end gap-2 rounded-lg bg-muted/40 p-2">
								<label class="flex min-w-40 flex-1 flex-col gap-1">
									<span class="text-xs font-medium">Team member</span>
									<NativeSelect bind:value={pickMember} aria-label="Team member">
										{#each members as m (m.id)}<NativeSelectOption value={m.id}>{m.name}</NativeSelectOption>{/each}
									</NativeSelect>
								</label>
								<Button size="sm" onclick={() => void linkPicked(u)} disabled={busy} data-testid="confirm-link">Link</Button>
								<Button size="sm" variant="ghost" onclick={() => (picking = null)}>Cancel</Button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="flex flex-col gap-2 rounded-lg border border-border p-3">
		<h3 class="text-xs font-medium">Add by Telegram user ID</h3>
		<p class="text-xs text-muted-foreground">For somebody who has not written yet. Their numeric id is in their profile on most Telegram clients, or ask them to message @userinfobot.</p>
		<div class="flex flex-wrap items-end gap-2">
			<label class="flex min-w-32 flex-1 flex-col gap-1">
				<span class="text-xs font-medium">User ID</span>
				<Input inputmode="numeric" placeholder="123456789" bind:value={manualId} aria-label="Telegram user id" aria-invalid={idProblem ? true : undefined} />
			</label>
			<label class="flex min-w-32 flex-1 flex-col gap-1">
				<span class="text-xs font-medium">Name (optional)</span>
				<Input placeholder="Ana" bind:value={manualName} aria-label="Name" />
			</label>
			<label class="flex min-w-32 flex-1 flex-col gap-1">
				<span class="text-xs font-medium">Team member</span>
				<NativeSelect bind:value={manualMember} aria-label="Team member for the id">
					{#each members as m (m.id)}<NativeSelectOption value={m.id}>{m.name}</NativeSelectOption>{/each}
				</NativeSelect>
			</label>
			<Button size="sm" variant="outline" onclick={() => void linkManual()} disabled={busy || manualId.trim() === '' || !!idProblem} data-testid="link-by-id"><UserPlusIcon class="size-4" /> Link</Button>
		</div>
		{#if idProblem}<p class="text-xs text-destructive-text" role="alert">{idProblem}</p>{/if}
	</div>

	<div class="flex flex-col gap-2">
		<h3 class="text-xs font-medium">Linked accounts</h3>
		{#if links.length === 0}
			<p class="text-sm text-muted-foreground">Nobody is linked yet.</p>
		{:else}
			<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
				{#each links as l (l.peerId)}
					<li class="flex items-center gap-3 p-3" data-testid="linked-account">
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm">{l.name ?? `Telegram ${l.peerId}`} <span class="text-muted-foreground">→ {memberName(l.memberId)}</span></div>
							<div class="text-xs text-muted-foreground">id {l.peerId} · linked {formatTime(l.linkedAt)}</div>
						</div>
						<Button size="sm" variant="ghost" onclick={() => { revoke = l; revokeOpen = true; }}>Unlink</Button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if conn.binding}
		<div class="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
			<div class="min-w-0">
				<div class="text-sm font-medium">Reply to unknown people</div>
				<p class="text-xs text-muted-foreground">Off (default): somebody who is not linked gets silence. On: they get one short neutral line, at most once in a while. Groups and approvals stay silent either way.</p>
			</div>
			<Switch checked={conn.binding.replyToUnknown} onCheckedChange={(v) => void setReply(v)} disabled={busy} aria-label="Reply to unknown people" data-testid="reply-unknown" />
		</div>
	{/if}
</div>

<ConfirmDialog bind:open={revokeOpen} title="Unlink this account?" description="They can no longer talk to the agent in a direct message until you link them again. They show up under Not linked yet when they write." confirmLabel="Unlink" onConfirm={doRevoke} />
