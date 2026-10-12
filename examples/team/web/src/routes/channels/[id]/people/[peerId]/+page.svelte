<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlash';
	import LinkIcon from 'phosphor-svelte/lib/Link';
	import { api } from '#lib/api/index.js';
	import ActivityTable from '#lib/components/app/channels/ActivityTable.svelte';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { channelHref, divisionOptions, personName, platformAdminText, roleLabel, roleLocked, ROLES, roleSourceLabel, type ChannelChat, type ChannelMember, type ChannelPerson, type Role } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// One person: the role and divisions the team gave them, the team member they are linked to,
	// what they asked to be called, and what happened with their messages.
	const cs = useConnection();
	const id = cs.id();
	const peerId = $derived(page.params.peerId ?? '');

	let person = $state<ChannelPerson | null>(null);
	let notFound = $state(false);
	let error = $state('');
	let chats = $state<ChannelChat[]>([]);
	let members = $state<ChannelMember[]>([{ id: 'owner', name: 'Owner' }]);
	let busy = $state(false);
	let draftRole = $state<Role>('member');
	let draftDivisions = $state<string[]>([]);
	let draftMember = $state('owner');
	let unlinkOpen = $state(false);
	let editing = false;
	let seq = 0;

	const options = $derived(divisionOptions(chats));
	const locked = $derived(person ? roleLocked(person) : false);

	function adopt(p: ChannelPerson): void {
		person = p;
		// the form follows the server until the person starts changing it
		if (!editing) {
			draftRole = p.role;
			draftDivisions = p.divisions.map((d) => d.nodeId);
		}
	}
	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const p = await api.get('/channels/connections/{id}/people/{peerId}', { params: { id, peerId } });
			if (mine !== seq) return;
			adopt(p);
			notFound = false;
			error = '';
		} catch (e) {
			if (mine !== seq) return;
			notFound = (e as { status?: number }).status === 404;
			error = e instanceof Error ? e.message : 'Could not load the person';
		}
	}
	onMount(() => {
		void load();
		void api.get('/channels/connections/{id}/chats/table', { params: { id }, query: { level: 'all', limit: 100, sort: 'title', order: 'asc' } }).then((r) => (chats = r.items)).catch(() => undefined);
		void api.get('/channels/connections/{id}/members', { params: { id } }).then((m) => (members = m.items.length > 0 ? m.items : members)).catch(() => undefined);
	});

	async function run(what: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
		busy = true;
		try {
			await fn();
			if (ok) toast.success(ok);
			editing = false;
			await Promise.all([load(), cs.load()]);
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what}`);
			return false;
		} finally {
			busy = false;
		}
	}
	const setRole = (role: Role, divisions?: string[]): Promise<boolean> =>
		run('set the role', () => api.put('/channels/connections/{id}/people/{peerId}/role', { params: { id, peerId }, body: { role, ...(divisions === undefined ? {} : { divisions }) } }), `Role set to ${roleLabel(role)}`);
	const clearRole = (): Promise<boolean> => run('clear the role', () => api.delete('/channels/connections/{id}/people/{peerId}/role', { params: { id, peerId } }), 'Back to the derived role');
	const link = (): Promise<boolean> => run('link the account', () => api.post('/channels/connections/{id}/links', { params: { id }, body: { peerId, memberId: draftMember } }), 'Linked');
	const unlink = (): Promise<boolean> => run('unlink', () => api.delete('/channels/connections/{id}/links/{peerId}', { params: { id, peerId } }), 'Account unlinked');
	const ignore = (ignored: boolean): Promise<boolean> => run('change this', () => api.put('/channels/connections/{id}/unlinked/{peerId}/ignored', { params: { id, peerId }, body: { ignored } }), ignored ? 'Ignored' : 'Back in the list');
	const memberName = (m: string): string => members.find((x) => x.id === m)?.name ?? m;
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="people" detail title={person ? personName(person) : 'Person'} />
	<PageBody size="wide" class="gap-5">
		{#if notFound}
			<Empty.Root class="border border-dashed border-border" data-testid="person-not-found">
				<Empty.Header>
					<Empty.Title>Nobody with this id</Empty.Title>
					<Empty.Description>This channel has not seen that person.</Empty.Description>
				</Empty.Header>
				<Button size="sm" href={channelHref(id, 'people')}>All people</Button>
			</Empty.Root>
		{:else if error && !person}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Try again</button></p>
		{:else if !person}
			<div class="flex flex-col gap-3" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-20 w-full rounded-xl" />{/each}</div>
		{:else}
			<section class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4" aria-label="About this person" data-testid="person-facts">
				<div class="flex min-w-0 flex-wrap items-center gap-2">
					<Badge variant={person.role === 'owner' || person.role === 'admin' ? 'default' : 'secondary'}>{roleLabel(person.role)}</Badge>
					{#if person.isBot}<Badge variant="secondary">Bot</Badge>{/if}
					{#if person.memberId}<Badge variant="secondary">Team: {memberName(person.memberId)}</Badge>{:else}<Badge variant="warning">Not linked</Badge>{/if}
					{#if person.ignored}<Badge variant="secondary">Ignored</Badge>{/if}
				</div>
				<dl class="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
					{#if person.username}<div><dt class="inline">Username: </dt><dd class="inline text-foreground">@{person.username}</dd></div>{/if}
					<div><dt class="inline">Platform id: </dt><dd class="inline font-mono text-foreground">{person.peerId}</dd></div>
					<div><dt class="inline">First seen: </dt><dd class="inline text-foreground">{formatTime(person.firstSeen)}</dd></div>
					<div><dt class="inline">Last seen: </dt><dd class="inline text-foreground">{formatTime(person.lastSeen)}</dd></div>
					<div><dt class="inline">Role: </dt><dd class="inline text-foreground">{roleSourceLabel(person)}</dd></div>
					{#if (person.directMessages ?? 0) > 0}<div><dt class="inline">Direct messages while not linked: </dt><dd class="inline text-foreground">{person.directMessages}</dd></div>{/if}
				</dl>
				{#if person.platformAdmin.length > 0}<p class="text-xs text-muted-foreground">Platform: {platformAdminText(person)}</p>{/if}
				{#if person.note}<p class="text-xs text-muted-foreground" data-testid="person-note">Asked to be addressed: {person.note}</p>{/if}
			</section>

			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Role and divisions" data-testid="person-role">
				<div>
					<h2 class="text-sm font-medium">Role and divisions</h2>
					<p class="text-xs text-muted-foreground">Roles come only from here: nothing said in a chat changes them. Divisions are the topics or chats a member may read.</p>
				</div>
				{#if person.suggestion}
					<div class="flex flex-wrap items-center gap-2 rounded-lg bg-warning-soft p-3 text-xs text-warning-text" data-testid="suggestion">
						<span class="min-w-0 flex-1">Suggested: {person.suggestion.reason}. The platform says so; it is a role only after you confirm it.</span>
						<Button size="sm" onclick={() => void setRole(person!.suggestion!.role)} disabled={busy} data-testid="confirm-suggestion">Confirm as {roleLabel(person.suggestion.role)}</Button>
					</div>
				{/if}
				{#if locked}
					<p class="text-xs text-muted-foreground">{roleSourceLabel(person)}. This role cannot be changed.</p>
				{:else}
					<label class="flex max-w-72 flex-col gap-1">
						<span class="text-xs font-medium">Role</span>
						<NativeSelect bind:value={draftRole} onchange={() => (editing = true)} aria-label="Role">
							{#each ROLES as r (r.value)}<NativeSelectOption value={r.value}>{r.label}: {r.hint}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<fieldset class="flex flex-col gap-1">
						<legend class="text-xs font-medium">Divisions (topics or chats this person may read)</legend>
						{#if options.length === 0}
							<span class="text-xs text-muted-foreground">No chats known yet.</span>
						{:else}
							<div class="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-2">
								{#each options as o (o.id)}
									<label class="flex items-center gap-2 text-xs"><input type="checkbox" value={o.id} bind:group={draftDivisions} onchange={() => (editing = true)} /> {o.label}</label>
								{/each}
							</div>
						{/if}
					</fieldset>
					<div class="flex flex-wrap justify-end gap-2">
						{#if person.explicit}<Button size="sm" variant="ghost" onclick={() => void clearRole()} disabled={busy}>Use the derived role</Button>{/if}
						<Button size="sm" onclick={() => void setRole(draftRole, draftDivisions)} disabled={busy} data-testid="save-role">Save role</Button>
					</div>
				{/if}
			</section>

			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Team member" data-testid="person-link">
				<div>
					<h2 class="text-sm font-medium">Team member</h2>
					<p class="text-xs text-muted-foreground">Only linked people can talk to the agent in a direct message. Anyone else who writes directly gets no answer.</p>
				</div>
				{#if person.memberId}
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="text-sm">Linked to <span class="font-medium">{memberName(person.memberId)}</span></span>
						<Button size="sm" variant="outline" onclick={() => (unlinkOpen = true)} disabled={busy}>Unlink</Button>
					</div>
				{:else}
					<div class="flex flex-wrap items-end gap-2">
						<label class="flex min-w-40 flex-1 flex-col gap-1">
							<span class="text-xs font-medium">Link to</span>
							<NativeSelect bind:value={draftMember} aria-label="Team member">
								{#each members as m (m.id)}<NativeSelectOption value={m.id}>{m.name}</NativeSelectOption>{/each}
							</NativeSelect>
						</label>
						<Button size="sm" onclick={() => void link()} disabled={busy} data-testid="confirm-link"><LinkIcon class="size-4" /> Link</Button>
						{#if person.ignored}
							<Button size="sm" variant="ghost" onclick={() => void ignore(false)} disabled={busy}>Stop ignoring</Button>
						{:else}
							<Button size="sm" variant="ghost" onclick={() => void ignore(true)} disabled={busy} data-testid="ignore-person"><EyeSlashIcon class="size-4" /> Ignore</Button>
						{/if}
					</div>
				{/if}
			</section>

			<section class="flex flex-col gap-3" aria-label="Activity of this person" data-testid="person-activity">
				<h2 class="text-sm font-medium">Activity</h2>
				<ActivityTable connectionId={id} {peerId} url={false} />
			</section>
		{/if}
	</PageBody>
</div>

<ConfirmDialog bind:open={unlinkOpen} title="Unlink this account?" description="They can no longer talk to the agent in a direct message until you link them again. They show up as not linked when they write." confirmLabel="Unlink" onConfirm={() => void unlink()} />
