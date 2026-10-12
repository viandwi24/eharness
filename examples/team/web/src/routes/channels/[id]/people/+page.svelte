<script lang="ts">
	import { goto } from '$app/navigation';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import UserPlusIcon from 'phosphor-svelte/lib/UserPlus';
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import DataTable, { type Column } from '#lib/components/app/DataTable.svelte';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { ServerTable } from '#lib/channels/table.svelte.js';
	import { tableQuery } from '#lib/channels/table-core.js';
	import { ago, channelHref, peerIdError, personName, roleLabel, ROLES, roleSourceLabel, YES_NO_ALL, type ChannelMember, type ChannelPerson } from '#lib/channels/model.js';

	const cs = useConnection();
	const id = cs.id();
	const conn = $derived(cs.conn!);

	const table = new ServerTable<ChannelPerson>(
		(p) => api.get('/channels/connections/{id}/people/table', { params: { id }, query: tableQuery(p) as never }),
		{ sort: 'lastSeen', order: 'desc', filters: { linked: '', role: '', ignored: '' } }
	);

	let busy = $state(false);
	let note = $state('');
	let members = $state<ChannelMember[]>([{ id: 'owner', name: 'Owner' }]);
	let manualId = $state('');
	let manualMember = $state('owner');
	let manualName = $state('');
	const idProblem = $derived(manualId.trim() === '' ? undefined : peerIdError(manualId));

	onMount(() => {
		void api
			.get('/channels/connections/{id}/members', { params: { id } })
			.then((m) => (members = m.items.length > 0 ? m.items : members))
			.catch(() => undefined);
	});

	async function importAdmins(): Promise<void> {
		busy = true;
		try {
			const r = await api.post('/channels/connections/{id}/people/import', { params: { id } });
			note = r.problems.length > 0 ? r.problems.join(' ') : `Read the admins of ${r.chats} chat(s): ${r.people} people. They are suggestions until you confirm them.`;
			await table.load(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not read the chat admins');
		} finally {
			busy = false;
		}
	}
	async function linkManual(): Promise<void> {
		if (manualId.trim() === '' || idProblem) return;
		busy = true;
		try {
			await api.post('/channels/connections/{id}/links', { params: { id }, body: { peerId: manualId.trim(), memberId: manualMember, ...(manualName.trim() ? { name: manualName.trim() } : {}) } });
			toast.success('Linked');
			const peer = manualId.trim();
			manualId = '';
			manualName = '';
			await cs.load();
			void goto(channelHref(id, 'people', peer));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not link the account');
		} finally {
			busy = false;
		}
	}

	const columns: Column<ChannelPerson>[] = [
		{ id: 'name', header: 'Person', sort: 'name', mobile: 'title', cell: nameCell },
		{ id: 'role', header: 'Role', sort: 'role', cell: roleCell },
		{ id: 'linked', header: 'Team member', cell: linkedCell },
		{ id: 'messages', header: 'Direct messages', sort: 'messages', firstOrder: 'desc', numeric: true, cell: dmCell },
		{ id: 'lastSeen', header: 'Last seen', sort: 'lastSeen', firstOrder: 'desc', cell: seenCell }
	];
</script>

{#snippet nameCell(p: ChannelPerson)}
	<div class="flex min-w-0 flex-col">
		<div class="flex min-w-0 flex-wrap items-center gap-2">
			<a href={channelHref(id, 'people', p.peerId)} class="truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none" data-testid="person-link">{personName(p)}</a>
			{#if p.isBot}<Badge variant="secondary">Bot</Badge>{/if}
			{#if p.ignored}<Badge variant="secondary">Ignored</Badge>{/if}
			{#if p.suggestion}<Badge variant="warning" title={p.suggestion.reason}>Suggested {roleLabel(p.suggestion.role)}</Badge>{/if}
		</div>
		<span class="text-xs text-muted-foreground">{p.username && p.name ? `@${p.username} · ` : ''}id {p.peerId}</span>
	</div>
{/snippet}
{#snippet roleCell(p: ChannelPerson)}
	<div class="flex flex-col gap-0.5">
		<Badge variant={p.role === 'owner' || p.role === 'admin' ? 'default' : 'secondary'} data-testid="role-badge">{roleLabel(p.role)}</Badge>
		<span class="text-xs text-muted-foreground">{roleSourceLabel(p)}</span>
	</div>
{/snippet}
{#snippet linkedCell(p: ChannelPerson)}{#if p.memberId}<Badge variant="secondary">{p.memberId}</Badge>{:else}<span class="text-muted-foreground">Not linked</span>{/if}{/snippet}
{#snippet dmCell(p: ChannelPerson)}{p.directMessages ?? 0}{/snippet}
{#snippet seenCell(p: ChannelPerson)}<span class="text-muted-foreground">{ago(p.lastSeen, Date.now())}</span>{/snippet}

{#snippet filters()}
	<FilterChips label="Team member" options={YES_NO_ALL('Linked', 'Not linked')} value={table.params.filters.linked ?? ''} onChange={(v) => table.setFilter('linked', v)} />
	<NativeSelect size="sm" value={table.params.filters.role ?? ''} onchange={(e) => table.setFilter('role', (e.currentTarget as HTMLSelectElement).value)} aria-label="Filter by role set by the team" data-testid="people-role">
		<NativeSelectOption value="">Any role</NativeSelectOption>
		{#each ROLES as r (r.value)}<NativeSelectOption value={r.value}>{r.label}</NativeSelectOption>{/each}
	</NativeSelect>
	<FilterChips label="Ignored" options={[{ value: '', label: 'All' }, { value: 'yes', label: 'Ignored' }]} value={table.params.filters.ignored ?? ''} onChange={(v) => table.setFilter('ignored', v)} />
{/snippet}
{#snippet actions()}
	<Button size="sm" variant="outline" onclick={() => void importAdmins()} disabled={busy} data-testid="import-admins"><ArrowsClockwiseIcon class="size-4" /> Read the chat admins</Button>
{/snippet}
{#snippet empty()}
	<p class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="no-people">Nobody was seen yet. People appear here when they write in an allowed chat or to this {conn.transport === 'user' ? 'account' : 'bot'} directly, or when you read the chat admins.</p>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="people" description="Roles, divisions and who is linked to a team member." />
	<PageBody size="wide" class="gap-4">
		<p class="text-xs text-muted-foreground">
			The agent is told each sender's role from this list, and the tools check it: an owner or admin can approve in a chat, set reminders for others and use write tools; a member reads the chats of their divisions; a guest only gets answers. Only linked people can talk to the agent in a direct message. Platform admin status and what people say about themselves never change a role.
		</p>
		{#if note}<p class="rounded-lg bg-muted/40 p-2 text-xs" role="status">{note}</p>{/if}
		<DataTable {table} {columns} rowKey={(p) => p.peerId} label="People" onRowClick={(p) => void goto(channelHref(id, 'people', p.peerId))} {filters} {actions} {empty} searchPlaceholder="Search name, @username or id" testid="people-table" />

		<section class="flex flex-col gap-2 rounded-xl border border-border bg-card p-4" aria-label="Link by Telegram user id" data-testid="link-by-id-card">
			<h2 class="text-sm font-medium">Link by Telegram user ID</h2>
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
		</section>
	</PageBody>
</div>
