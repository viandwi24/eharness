<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import DataTable, { type Column } from '#lib/components/app/DataTable.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { ServerTable } from '#lib/channels/table.svelte.js';
	import { tableQuery } from '#lib/channels/table-core.js';
	import { ago } from '#lib/channels/model.js';
	import { formatDateTime } from '#lib/time.js';
	import { accountText, platformName, roleName, type PersonItem } from '#lib/people/model.js';

	// The people of the team: one person, any number of platform accounts. The role lives on the
	// person, so every account of one human has the same rights.
	type Unassigned = { connectionId: string; platform: string; peerId: string; name: string | null; username: string | null };

	let tab = $state<'people' | 'unassigned'>('people');
	const table = new ServerTable<PersonItem>(
		(p) => api.get('/people', { query: tableQuery(p) as never }),
		{ limit: 25 }
	);

	let newOpen = $state(false);
	let newName = $state('');
	let newNickname = $state('');
	let busy = $state(false);

	let unassigned = $state<Unassigned[] | null>(null);
	let unassignedError = $state('');
	let pickable = $state<PersonItem[]>([]);
	let attachTo = $state<Record<string, string>>({});
	const keyOf = (u: Unassigned): string => `${u.connectionId}:${u.peerId}`;

	async function loadUnassigned(): Promise<void> {
		try {
			unassigned = (await api.get('/people/unassigned', { query: { limit: 200 } })).items;
			unassignedError = '';
		} catch (e) {
			unassignedError = e instanceof Error ? e.message : 'Could not load the accounts';
		}
	}
	async function loadPickable(): Promise<void> {
		try {
			pickable = (await api.get('/people', { query: { limit: 100 } })).items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		} catch {
			// the picker stays empty
		}
	}
	onMount(() => {
		void table.load();
		void loadUnassigned();
		void loadPickable();
		return () => table.destroy();
	});

	async function create(): Promise<void> {
		if (newName.trim() === '') return;
		busy = true;
		try {
			const p = await api.post('/people', { body: { displayName: newName.trim(), ...(newNickname.trim() ? { nickname: newNickname.trim() } : {}) } });
			void goto(`/people/${p.id}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not create the person');
		} finally {
			busy = false;
		}
	}
	async function fromAccount(u: Unassigned): Promise<void> {
		busy = true;
		try {
			const p = await api.post('/people/from-account', { body: { connectionId: u.connectionId, peerId: u.peerId } });
			toast.success('Person created');
			void goto(`/people/${p.id}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not create the person');
		} finally {
			busy = false;
		}
	}
	// every unassigned account becomes a person (one per account; accounts of one human are merged
	// later by attaching), with the role chosen here
	let bulkOpen = $state(false);
	let bulkRole = $state<'member' | 'default' | 'guest'>('member');
	let bulkProgress = $state('');
	async function createAll(): Promise<void> {
		const list = unassigned ?? [];
		busy = true;
		let done = 0;
		let failed = 0;
		for (const u of list) {
			bulkProgress = `${done + failed + 1} / ${list.length}`;
			try {
				const p = await api.post('/people/from-account', { body: { connectionId: u.connectionId, peerId: u.peerId } });
				if (bulkRole !== 'default' && p.role === null) await api.patch('/people/{id}', { params: { id: p.id }, body: { role: bulkRole } });
				done += 1;
			} catch {
				failed += 1;
			}
		}
		busy = false;
		bulkProgress = '';
		if (failed === 0) toast.success(`${done} people created`);
		else toast.error(`${done} people created, ${failed} failed`);
		await Promise.all([loadUnassigned(), table.load(true), loadPickable()]);
		if ((unassigned ?? []).length === 0) tab = 'people';
	}

	async function attach(u: Unassigned): Promise<void> {
		const personId = attachTo[keyOf(u)];
		if (!personId) return;
		busy = true;
		try {
			await api.post('/people/{id}/accounts', { params: { id: personId }, body: { connectionId: u.connectionId, peerId: u.peerId } });
			toast.success('Account attached');
			await Promise.all([loadUnassigned(), table.load(true)]);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not attach the account');
		} finally {
			busy = false;
		}
	}

	const columns: Column<PersonItem>[] = [
		{ id: 'name', header: 'Name', mobile: 'title', cell: nameCell },
		{ id: 'role', header: 'Role', cell: roleCell },
		{ id: 'status', header: 'Status', cell: statusCell },
		{ id: 'accounts', header: 'Accounts', cell: accountsCell },
		{ id: 'updated', header: 'Updated', cell: updatedCell }
	];
</script>

{#snippet nameCell(p: PersonItem)}
	<div class="flex min-w-0 flex-wrap items-center gap-x-2">
		<a href="/people/{p.id}" class="truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none" data-testid="person-link">{p.displayName}</a>
		{#if p.nickname}<span class="text-xs text-muted-foreground">“{p.nickname}”</span>{/if}
	</div>
{/snippet}
{#snippet roleCell(p: PersonItem)}
	<Badge variant={p.role === 'owner' || p.role === 'admin' ? 'default' : 'secondary'}>{roleName(p.role)}</Badge>
{/snippet}
{#snippet statusCell(p: PersonItem)}
	<Badge variant={p.status === 'active' ? 'success' : p.status === 'suspended' ? 'warning' : 'secondary'}>{p.status === 'active' ? 'Active' : p.status === 'suspended' ? 'Suspended' : 'Left'}</Badge>
{/snippet}
{#snippet accountsCell(p: PersonItem)}
	{#if p.accountCount === 0}
		<span class="text-muted-foreground">None</span>
	{:else}
		<span class="text-xs">{p.accounts.map(accountText).join(', ')}{p.accountCount > p.accounts.length ? ` +${p.accountCount - p.accounts.length}` : ''}</span>
	{/if}
{/snippet}
{#snippet updatedCell(p: PersonItem)}<span class="text-muted-foreground" title={formatDateTime(p.updatedAt)}>{ago(p.updatedAt, Date.now())}</span>{/snippet}

{#snippet actions()}
	<Button size="sm" onclick={() => (newOpen = !newOpen)} data-testid="new-person"><PlusIcon class="size-4" /> New person</Button>
{/snippet}
{#snippet empty()}
	<div class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground" data-testid="people-empty">
		Nobody yet. Create a person here, or turn a chat account into one from Unassigned accounts.
	</div>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="People" description="Who is who: one person, any number of chat accounts, one role." />
	<PageBody size="wide" class="gap-4">
		<div class="flex gap-2" role="tablist" aria-label="People views">
			<Button size="sm" variant={tab === 'people' ? 'default' : 'outline'} role="tab" aria-selected={tab === 'people'} onclick={() => (tab = 'people')} data-testid="tab-people">People</Button>
			<Button size="sm" variant={tab === 'unassigned' ? 'default' : 'outline'} role="tab" aria-selected={tab === 'unassigned'} onclick={() => { tab = 'unassigned'; void loadUnassigned(); }} data-testid="tab-unassigned">
				Unassigned accounts{#if unassigned && unassigned.length > 0}<Badge variant="secondary">{unassigned.length}</Badge>{/if}
			</Button>
		</div>

		{#if tab === 'people'}
			{#if newOpen}
				<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="New person" data-testid="new-person-form">
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="flex flex-col gap-1"><span class="text-xs font-medium">Full name</span><Input bind:value={newName} placeholder="Full name" data-testid="new-person-name" /></label>
						<label class="flex flex-col gap-1"><span class="text-xs font-medium">Nickname (optional)</span><Input bind:value={newNickname} placeholder="What people call them" /></label>
					</div>
					<div class="flex justify-end gap-2">
						<Button size="sm" variant="ghost" onclick={() => (newOpen = false)}>Cancel</Button>
						<Button size="sm" onclick={() => void create()} disabled={busy || newName.trim() === ''} data-testid="create-person">Create</Button>
					</div>
				</section>
			{/if}
			<DataTable {table} {columns} rowKey={(p) => p.id} label="People" onRowClick={(p) => void goto(`/people/${p.id}`)} {actions} {empty} searchPlaceholder="Search name, nickname, field or id" testid="people-table" />
		{:else if unassignedError && unassigned === null}
			<p class="text-sm text-destructive-text" role="alert">{unassignedError} <button class="underline underline-offset-4" onclick={() => void loadUnassigned()}>Try again</button></p>
		{:else if unassigned === null}
			<div class="flex flex-col gap-3" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-14 w-full rounded-xl" />{/each}</div>
		{:else if unassigned.length === 0}
			<div class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground" data-testid="unassigned-empty">Every account seen in the chats belongs to a person.</div>
		{:else}
			<p class="text-xs text-muted-foreground">Accounts seen in the chats that belong to nobody. Create a person from one, or attach it to somebody who already exists.</p>
			<ul class="flex flex-col gap-2" data-testid="unassigned-list">
				{#each unassigned as u (keyOf(u))}
					<li class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
						<div class="flex min-w-40 flex-1 flex-col">
							<span class="truncate text-sm font-medium">{u.name ?? (u.username ? `@${u.username}` : `id ${u.peerId}`)}</span>
							<span class="text-xs text-muted-foreground">{platformName(u.platform)}{u.username ? ` · @${u.username}` : ''} · <span class="font-mono">{u.peerId}</span></span>
						</div>
						<Button size="sm" variant="outline" onclick={() => void fromAccount(u)} disabled={busy} data-testid="create-from-account">Create person</Button>
						<div class="flex items-center gap-2">
							<NativeSelect bind:value={attachTo[keyOf(u)]} aria-label="Attach to a person" class="w-48">
								<NativeSelectOption value="">Attach to…</NativeSelectOption>
								{#each pickable as p (p.id)}<NativeSelectOption value={p.id}>{p.displayName}</NativeSelectOption>{/each}
							</NativeSelect>
							<Button size="sm" onclick={() => void attach(u)} disabled={busy || !attachTo[keyOf(u)]}>Attach</Button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</PageBody>
</div>

<ConfirmDialog
	bind:open={bulkOpen}
	title={`Create ${unassigned?.length ?? 0} people?`}
	description={`Each account becomes its own person named after the account${bulkRole === 'default' ? '' : `, with the role ${bulkRole}`}. Two accounts of one human can be merged later by attaching one to the other person. Owners and admins are set on each person.`}
	confirmLabel="Create"
	confirmVariant="default"
	onConfirm={() => createAll()}
/>
