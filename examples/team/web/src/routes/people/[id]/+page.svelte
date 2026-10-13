<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import KeyIcon from 'phosphor-svelte/lib/Key';
	import LinkIcon from 'phosphor-svelte/lib/Link';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { formatDateTime } from '#lib/time.js';
	import { eventText, PERSON_ROLES, platformName, STATUSES, type PersonDetail, type PersonRole, type PersonStatus } from '#lib/people/model.js';

	// One person: who they are, what they may do (role, divisions), their chat accounts, free
	// fields and staff notes. Role and divisions apply to every account of the person.
	type Unassigned = { connectionId: string; platform: string; peerId: string; name: string | null; username: string | null };

	const id = $derived(page.params.id ?? '');
	let person = $state<PersonDetail | null>(null);
	let notFound = $state(false);
	let error = $state('');
	let busy = $state(false);
	let seq = 0;

	let draftName = $state('');
	let draftNickname = $state('');
	let draftStatus = $state<PersonStatus>('active');
	let draftRole = $state<PersonRole | ''>('');
	let draftDivisions = $state<string[]>([]);
	let draftFields = $state<{ key: string; value: string }[]>([]);
	let draftNotes = $state('');
	let labels = $state<Record<string, string>>({});

	let nodes = $state<{ id: string; connectionId: string; label: string }[]>([]);
	let unassigned = $state<Unassigned[]>([]);
	let linkKey = $state('');
	let linkLabel = $state('');
	let unlinking = $state<PersonDetail['accountViews'][number] | null>(null);
	let unlinkOpen = $state(false);
	let pairing = $state<{ code: string; expiresAt: number } | null>(null);

	const keyOf = (u: Unassigned): string => `${u.connectionId}:${u.peerId}`;
	const divisionOptions = $derived.by(() => {
		const known = new Set(nodes.map((n) => n.id));
		// a division whose chat is not in the list any more stays visible, so it can be removed
		const extra = (person?.divisions ?? []).filter((d) => !known.has(d.nodeId)).map((d) => ({ id: d.nodeId, label: d.title }));
		return [...nodes.map((n) => ({ id: n.id, label: n.label })), ...extra];
	});

	function adopt(p: PersonDetail): void {
		person = p;
		draftName = p.displayName;
		draftNickname = p.nickname ?? '';
		draftStatus = p.status;
		draftRole = p.role ?? '';
		draftDivisions = p.divisions.map((d) => d.nodeId);
		draftFields = Object.entries(p.fields).map(([key, value]) => ({ key, value }));
		draftNotes = p.notes;
		labels = Object.fromEntries(p.accountViews.map((a) => [a.id, a.label ?? '']));
	}
	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const p = await api.get('/people/{id}', { params: { id } });
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
	async function loadUnassigned(): Promise<void> {
		try {
			unassigned = (await api.get('/people/unassigned', { query: { limit: 200 } })).items;
		} catch {
			// the picker stays empty
		}
	}
	onMount(() => {
		void load();
		void loadUnassigned();
		void api.get('/people/nodes').then((r) => (nodes = r.items)).catch(() => undefined);
	});

	/** Run one change; the answer is the whole person, which refreshes every draft. */
	async function run(what: string, fn: () => Promise<PersonDetail>, ok?: string): Promise<boolean> {
		busy = true;
		try {
			adopt(await fn());
			if (ok) toast.success(ok);
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what}`);
			return false;
		} finally {
			busy = false;
		}
	}
	const patch = (what: string, body: Record<string, unknown>, ok: string): Promise<boolean> => run(what, () => api.patch('/people/{id}', { params: { id }, body: body as never }), ok);

	const saveProfile = (): Promise<boolean> => patch('save', { displayName: draftName.trim(), nickname: draftNickname.trim() === '' ? null : draftNickname.trim(), status: draftStatus, role: draftRole === '' ? null : draftRole, divisions: draftDivisions }, 'Saved');
	const profileDirty = $derived(
		person !== null &&
			(draftName.trim() !== person.displayName ||
				draftNickname.trim() !== (person.nickname ?? '') ||
				draftStatus !== person.status ||
				draftRole !== (person.role ?? '') ||
				JSON.stringify([...draftDivisions].sort()) !== JSON.stringify(person.divisions.map((d) => d.nodeId).sort()))
	);

	function saveFields(): Promise<boolean> {
		const next: Record<string, string | null> = {};
		const keys = new Set<string>();
		for (const f of draftFields) {
			const key = f.key.trim();
			if (key === '') continue;
			keys.add(key);
			next[key] = f.value.trim();
		}
		// a key that was removed is deleted (null)
		for (const key of Object.keys(person?.fields ?? {})) if (!keys.has(key)) next[key] = null;
		return patch('save the fields', { fields: next }, 'Fields saved');
	}
	const fieldsDirty = $derived(JSON.stringify(Object.fromEntries(draftFields.filter((f) => f.key.trim() !== '').map((f) => [f.key.trim(), f.value.trim()]))) !== JSON.stringify(person?.fields ?? {}));

	const saveNotes = (): Promise<boolean> => patch('save the notes', { notes: draftNotes }, 'Notes saved');

	async function linkAccount(): Promise<void> {
		const u = unassigned.find((x) => keyOf(x) === linkKey);
		if (!u) return;
		const ok = await run('link the account', () => api.post('/people/{id}/accounts', { params: { id }, body: { connectionId: u.connectionId, peerId: u.peerId, ...(linkLabel.trim() ? { label: linkLabel.trim() } : {}) } }), 'Account linked');
		if (ok) {
			linkKey = '';
			linkLabel = '';
			void loadUnassigned();
		}
	}
	const saveLabel = (accountId: string): Promise<boolean> => run('save the label', () => api.patch('/people/{id}/accounts/{accountId}', { params: { id, accountId }, body: { label: (labels[accountId] ?? '').trim() === '' ? null : labels[accountId]!.trim() } }), 'Label saved');
	async function unlink(): Promise<void> {
		const a = unlinking;
		if (!a) return;
		if (await run('unlink the account', () => api.delete('/people/{id}/accounts/{accountId}', { params: { id, accountId: a.id } }), 'Account unlinked')) void loadUnassigned();
	}
	let deleteOpen = $state(false);
	async function remove(): Promise<void> {
		busy = true;
		try {
			await api.delete('/people/{id}', { params: { id } });
			toast.success('Person deleted');
			void goto('/people');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the person');
		} finally {
			busy = false;
		}
	}
	async function pair(): Promise<void> {
		busy = true;
		try {
			pairing = await api.post('/people/{id}/pairing-code', { params: { id } });
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not make a code');
		} finally {
			busy = false;
		}
	}
	const addable = $derived(unassigned.filter((u) => !(person?.accountViews ?? []).some((a) => a.platform === u.platform && a.nativeId === u.peerId)));
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={person?.displayName ?? 'Person'} description={person?.nickname ? `Called “${person.nickname}”` : undefined} breadcrumb={[{ label: 'People', href: '/people' }]} backHref="/people" />
	<PageBody size="wide" class="gap-5">
		{#if notFound}
			<Empty.Root class="border border-dashed border-border" data-testid="person-not-found">
				<Empty.Header>
					<Empty.Title>No such person</Empty.Title>
					<Empty.Description>This person does not exist (any more).</Empty.Description>
				</Empty.Header>
				<Button size="sm" href="/people">All people</Button>
			</Empty.Root>
		{:else if error && !person}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Try again</button></p>
		{:else if !person}
			<div class="flex flex-col gap-3" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-24 w-full rounded-xl" />{/each}</div>
		{:else}
			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Profile" data-testid="person-profile">
				<div>
					<h2 class="text-sm font-medium">Profile, role and divisions</h2>
					<p class="text-xs text-muted-foreground">The role and the divisions apply to every account of this person. A suspended or former person is a guest, whatever the role says. Nothing said in a chat changes them.</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="flex flex-col gap-1"><span class="text-xs font-medium">Full name</span><Input bind:value={draftName} data-testid="person-name" /></label>
					<label class="flex flex-col gap-1"><span class="text-xs font-medium">Nickname</span><Input bind:value={draftNickname} placeholder="What people call them" data-testid="person-nickname" /></label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Status</span>
						<NativeSelect bind:value={draftStatus} aria-label="Status" data-testid="person-status">
							{#each STATUSES as s (s.value)}<NativeSelectOption value={s.value}>{s.label}: {s.hint}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Role</span>
						<NativeSelect bind:value={draftRole} aria-label="Role" data-testid="person-role">
							<NativeSelectOption value="">Default of the chat</NativeSelectOption>
							{#each PERSON_ROLES as r (r.value)}<NativeSelectOption value={r.value}>{r.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
				</div>
				<fieldset class="flex flex-col gap-1">
					<legend class="text-xs font-medium">Divisions (topics or chats this person may read)</legend>
					{#if divisionOptions.length === 0}
						<span class="text-xs text-muted-foreground">No chats known yet.</span>
					{:else}
						<div class="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-2">
							{#each divisionOptions as o (o.id)}
								<label class="flex items-center gap-2 text-xs"><input type="checkbox" value={o.id} bind:group={draftDivisions} /> {o.label}</label>
							{/each}
						</div>
					{/if}
				</fieldset>
				<div class="flex flex-wrap items-center justify-between gap-2">
					<span class="text-xs text-muted-foreground">Created {formatDateTime(person.createdAt)}{person.memberId ? ' · linked to a web team member' : ''}</span>
					<Button size="sm" onclick={() => void saveProfile()} disabled={busy || !profileDirty || draftName.trim() === ''} data-testid="save-profile">Save</Button>
				</div>
			</section>

			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Accounts" data-testid="person-accounts">
				<div>
					<h2 class="text-sm font-medium">Accounts</h2>
					<p class="text-xs text-muted-foreground">The chat accounts of this person, by their stable platform id. An account belongs to one person; to move it, unlink it first.</p>
				</div>
				{#if person.accountViews.length === 0}
					<p class="text-xs text-muted-foreground" data-testid="no-accounts">No account yet: link one below or make a pairing code.</p>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each person.accountViews as a (a.id)}
							<li class="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3" data-testid="account-row">
								<div class="flex min-w-40 flex-1 flex-col">
									<span class="flex flex-wrap items-center gap-2 text-sm font-medium">{a.name ?? (a.username ? `@${a.username}` : 'Not seen yet')} <Badge variant="secondary">{platformName(a.platform)}</Badge></span>
									<span class="text-xs text-muted-foreground">{a.username ? `@${a.username} · ` : ''}<span class="font-mono">{a.nativeId}</span></span>
								</div>
								<Input
									class="w-44"
									placeholder="Label (e.g. work account)"
									aria-label="Label"
									bind:value={labels[a.id]}
									onblur={() => (labels[a.id] ?? '').trim() !== (a.label ?? '') && void saveLabel(a.id)}
									onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
								/>
								<Button size="sm" variant="outline" onclick={() => ((unlinking = a), (unlinkOpen = true))} disabled={busy} data-testid="unlink-account">Unlink</Button>
							</li>
						{/each}
					</ul>
				{/if}
				<div class="flex flex-wrap items-end gap-2 border-t border-border pt-3" data-testid="link-account">
					<label class="flex min-w-48 flex-1 flex-col gap-1">
						<span class="text-xs font-medium">Link an account</span>
						<NativeSelect bind:value={linkKey} aria-label="Account to link">
							<NativeSelectOption value="">{addable.length === 0 ? 'No unassigned account' : 'Pick an account seen in the chats…'}</NativeSelectOption>
							{#each addable as u (keyOf(u))}<NativeSelectOption value={keyOf(u)}>{u.name ?? (u.username ? `@${u.username}` : u.peerId)} ({platformName(u.platform)}{u.username ? ` @${u.username}` : ''})</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<Input class="w-44" placeholder="Label (optional)" bind:value={linkLabel} aria-label="New account label" />
					<Button size="sm" onclick={() => void linkAccount()} disabled={busy || linkKey === ''} data-testid="confirm-link"><LinkIcon class="size-4" /> Link</Button>
				</div>
				<div class="flex flex-col gap-2 border-t border-border pt-3" data-testid="pairing">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div>
							<h3 class="text-xs font-medium">Pairing code</h3>
							<p class="text-xs text-muted-foreground">For an account that has not written to the agent yet: the person sends the code from that account.</p>
						</div>
						<Button size="sm" variant="outline" onclick={() => void pair()} disabled={busy} data-testid="make-code"><KeyIcon class="size-4" /> Make a code</Button>
					</div>
					{#if pairing}
						<div class="rounded-lg bg-muted p-3 text-sm" role="status" data-testid="pairing-code">
							<p>Send <code class="rounded bg-background px-1.5 py-0.5 font-mono font-medium">/link {pairing.code}</code> from the other account, in a direct message or a group, within one hour (until {formatDateTime(pairing.expiresAt)}).</p>
							<p class="mt-1 text-xs text-muted-foreground">The code is shown only now and works once. Do not share it anywhere else.</p>
						</div>
					{/if}
				</div>
			</section>

			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Fields" data-testid="person-fields">
				<div>
					<h2 class="text-sm font-medium">Fields</h2>
					<p class="text-xs text-muted-foreground">Free facts about the person (position, branch, ...). The agent reads them to know who it talks to.</p>
				</div>
				<div class="flex flex-col gap-2">
					{#each draftFields as f, i (i)}
						<div class="flex items-center gap-2">
							<Input class="w-40" placeholder="Field" aria-label="Field name" bind:value={f.key} />
							<Input class="flex-1" placeholder="Value" aria-label="Field value" bind:value={f.value} />
							<Button size="icon-sm" variant="ghost" aria-label="Remove the field" onclick={() => (draftFields = draftFields.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>
						</div>
					{/each}
				</div>
				<div class="flex flex-wrap justify-between gap-2">
					<Button size="sm" variant="outline" onclick={() => (draftFields = [...draftFields, { key: '', value: '' }])} data-testid="add-field"><PlusIcon class="size-4" /> Add a field</Button>
					<Button size="sm" onclick={() => void saveFields()} disabled={busy || !fieldsDirty} data-testid="save-fields">Save fields</Button>
				</div>
			</section>

			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Notes" data-testid="person-notes">
				<div>
					<h2 class="text-sm font-medium">Notes</h2>
					<p class="text-xs text-muted-foreground">For the staff only. The agent shows them to admins and owners, never to members or guests.</p>
				</div>
				<Textarea bind:value={draftNotes} rows={4} aria-label="Staff notes" />
				<div class="flex justify-end"><Button size="sm" onclick={() => void saveNotes()} disabled={busy || draftNotes === person.notes} data-testid="save-notes">Save notes</Button></div>
			</section>

			<section class="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 p-4" aria-label="Delete" data-testid="person-delete">
				<div class="flex min-w-60 flex-1 flex-col gap-0.5">
					<h2 class="text-sm font-medium">Delete this person</h2>
					<p class="text-xs text-muted-foreground">Their accounts belong to nobody again and act as guests until linked. The history of changes is kept.</p>
				</div>
				<Button size="sm" variant="destructive" onclick={() => (deleteOpen = true)} disabled={busy} data-testid="delete-person">Delete</Button>
			</section>

			<section class="flex flex-col gap-2" aria-label="Activity of this person" data-testid="person-activity">
				<h2 class="text-sm font-medium">Activity</h2>
				{#if person.events.length === 0}
					<p class="text-xs text-muted-foreground">Nothing yet.</p>
				{:else}
					<ul class="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
						{#each person.events as e (e.id)}
							<li class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
								<Badge variant="secondary">{e.kind}</Badge>
								<span class="min-w-0 flex-1 break-words text-muted-foreground">{eventText(e)}</span>
								<span class="text-muted-foreground">{e.actor ?? 'system'} · {formatDateTime(e.at)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</PageBody>
</div>

<ConfirmDialog
	bind:open={unlinkOpen}
	title={`Unlink this ${unlinking ? platformName(unlinking.platform) : ''} account?`}
	description="The account stays known in the chats but belongs to nobody: it is a guest again until it is linked."
	confirmLabel="Unlink"
	onConfirm={() => unlink()}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title={`Delete ${person?.displayName ?? 'this person'}?`}
	description={`${person?.role === 'owner' ? 'This person is an OWNER: they lose the owner rights on every account. ' : ''}${person?.accountViews.length ?? 0} account(s) will belong to nobody and act as guests until they are linked again. The history of changes is kept.`}
	confirmLabel="Delete"
	onConfirm={() => remove()}
/>
