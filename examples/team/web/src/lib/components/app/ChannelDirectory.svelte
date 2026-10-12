<script lang="ts">
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import {
		divisionOptions,
		personName,
		platformAdminText,
		roleLabel,
		roleLocked,
		roleSourceLabel,
		ROLES,
		sortPeople,
		type ChannelChat,
		type ChannelConnection,
		type ChannelPeopleSettings,
		type ChannelPerson,
		type Role
	} from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// The people directory of a connection: the role and divisions the team gives each person.
	// Roles come only from here. What the platform says (admin, creator) is a suggestion until you
	// confirm it with one click; nothing said in a chat changes a role.
	let { conn, onChange }: { conn: ChannelConnection; onChange: () => void } = $props();

	let people = $state<ChannelPerson[]>([]);
	let chats = $state<ChannelChat[]>([]);
	let settings = $state<ChannelPeopleSettings>({ defaultRole: 'guest', approvalTtlHours: 24 });
	let busy = $state(false);
	let editing = $state<string | null>(null);
	let draftRole = $state<Role>('member');
	let draftDivisions = $state<string[]>([]);
	let ttl = $state('24');
	let note = $state('');

	const sorted = $derived(sortPeople(people));
	const options = $derived(divisionOptions(chats));

	async function load(): Promise<void> {
		try {
			const [p, c, s] = await Promise.all([
				api.get('/channels/connections/{id}/people', { params: { id: conn.id } }),
				api.get('/channels/connections/{id}/chats', { params: { id: conn.id } }),
				api.get('/channels/connections/{id}/people/settings', { params: { id: conn.id } })
			]);
			people = p.items;
			chats = c.items;
			settings = s;
			ttl = String(s.approvalTtlHours);
		} catch {
			// the list follows on the next refresh
		}
	}
	$effect(() => {
		void conn.counts.linked;
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

	const setRole = (p: ChannelPerson, role: Role, divisions?: string[]): Promise<boolean> =>
		run('set the role', () => api.put('/channels/connections/{id}/people/{peerId}/role', { params: { id: conn.id, peerId: p.peerId }, body: { role, ...(divisions === undefined ? {} : { divisions }) } }), `${personName(p)} is now ${roleLabel(role)}`);

	function edit(p: ChannelPerson): void {
		editing = editing === p.peerId ? null : p.peerId;
		draftRole = p.role;
		draftDivisions = p.divisions.map((d) => d.nodeId);
	}
	async function saveEdit(p: ChannelPerson): Promise<void> {
		if (await setRole(p, draftRole, draftDivisions)) editing = null;
	}
	const clear = (p: ChannelPerson): Promise<boolean> =>
		run('clear the role', () => api.delete('/channels/connections/{id}/people/{peerId}/role', { params: { id: conn.id, peerId: p.peerId } }), 'Back to the derived role');
	async function importAdmins(): Promise<void> {
		await run('import the admins', async () => {
			const r = await api.post('/channels/connections/{id}/people/import', { params: { id: conn.id } });
			note = r.problems.length > 0 ? r.problems.join(' ') : `Read the admins of ${r.chats} chat(s): ${r.people} people. They are suggestions until you confirm them.`;
		});
	}
	const saveSettings = (patch: Partial<ChannelPeopleSettings>): Promise<boolean> =>
		run('save', () => api.put('/channels/connections/{id}/people/settings', { params: { id: conn.id }, body: patch }), 'Saved');
	const ttlProblem = $derived(ttl.trim() === '' || !(Number(ttl) >= 0.02 && Number(ttl) <= 720) ? 'Hours, 0.02 to 720' : undefined);
</script>

<div class="flex flex-col gap-3" data-testid="directory">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class="text-xs font-medium">Roles and divisions {#if sorted.length}<Badge shape="number" variant="secondary">{sorted.length}</Badge>{/if}</h3>
		<Button size="sm" variant="outline" onclick={() => void importAdmins()} disabled={busy || !conn.binding} data-testid="import-admins"><ArrowsClockwiseIcon class="size-4" /> Read the chat admins</Button>
	</div>
	<p class="text-xs text-muted-foreground">
		The agent is told each sender's role from this list, and the tools check it: an owner or admin can approve in a chat, set reminders for others and use write tools; a member reads the chats of their divisions and sets their own reminders; a guest only gets answers. Platform admin status and what people say about themselves never change a role.
	</p>
	{#if note}<p class="rounded-lg bg-muted/40 p-2 text-xs" role="status">{note}</p>{/if}

	{#if sorted.length === 0}
		<p class="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground" data-testid="no-people">Nobody was seen in a group yet. People appear here when they write in an allowed chat, or when you read the chat admins.</p>
	{:else}
		<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
			{#each sorted as p (p.peerId)}
				<li class="flex flex-col gap-2 p-3" data-testid="directory-person">
					<div class="flex flex-wrap items-center gap-3">
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="truncate text-sm">{personName(p)}</span>
								{#if p.username && p.name}<span class="text-xs text-muted-foreground">@{p.username}</span>{/if}
								<Badge variant={p.role === 'owner' || p.role === 'admin' ? 'default' : 'secondary'} data-testid="role-badge">{roleLabel(p.role)}</Badge>
								{#if p.isBot}<Badge variant="secondary">Bot</Badge>{/if}
								{#if p.memberId}<Badge variant="secondary">Team: {p.memberId}</Badge>{/if}
							</div>
							<div class="text-xs text-muted-foreground">
								{roleSourceLabel(p)} · id {p.peerId} · last seen {formatTime(p.lastSeen)}
								{#if p.divisions.length > 0} · divisions: {p.divisions.map((d) => d.title).join(', ')}{/if}
							</div>
							{#if p.platformAdmin.length > 0}<div class="text-xs text-muted-foreground">Platform: {platformAdminText(p)}</div>{/if}
						</div>
						<div class="flex items-center gap-1">
							{#if p.suggestion}
								<Button size="sm" onclick={() => void setRole(p, p.suggestion!.role)} disabled={busy} data-testid="confirm-suggestion">Confirm as {roleLabel(p.suggestion.role)}</Button>
							{/if}
							{#if !roleLocked(p)}
								<Button size="sm" variant="outline" onclick={() => edit(p)} disabled={busy}>Role…</Button>
							{/if}
						</div>
					</div>
					{#if p.suggestion}<p class="text-xs text-warning-text" data-testid="suggestion">Suggested: {p.suggestion.reason}. The platform says so; it is a role only after you confirm it.</p>{/if}
					{#if editing === p.peerId}
						<div class="flex flex-col gap-2 rounded-lg bg-muted/40 p-2">
							<label class="flex max-w-60 flex-col gap-1">
								<span class="text-xs font-medium">Role</span>
								<NativeSelect bind:value={draftRole} aria-label="Role">
									{#each ROLES as r (r.value)}<NativeSelectOption value={r.value}>{r.label}: {r.hint}</NativeSelectOption>{/each}
								</NativeSelect>
							</label>
							<fieldset class="flex flex-col gap-1">
								<legend class="text-xs font-medium">Divisions (topics or chats this person may read)</legend>
								{#if options.length === 0}
									<span class="text-xs text-muted-foreground">No chats known yet.</span>
								{:else}
									<div class="flex max-h-40 flex-col gap-1 overflow-y-auto">
										{#each options as o (o.id)}
											<label class="flex items-center gap-2 text-xs"><input type="checkbox" value={o.id} bind:group={draftDivisions} /> {o.label}</label>
										{/each}
									</div>
								{/if}
							</fieldset>
							<div class="flex flex-wrap justify-end gap-2">
								{#if p.explicit}<Button size="sm" variant="ghost" onclick={() => void clear(p)} disabled={busy}>Use the derived role</Button>{/if}
								<Button size="sm" variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
								<Button size="sm" onclick={() => void saveEdit(p)} disabled={busy} data-testid="save-role">Save</Button>
							</div>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<div class="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3">
		<label class="flex min-w-48 flex-1 flex-col gap-1">
			<span class="text-xs font-medium">Role of somebody who is not in the directory or linked</span>
			<NativeSelect value={settings.defaultRole} onchange={(e) => void saveSettings({ defaultRole: (e.currentTarget as HTMLSelectElement).value as Role })} aria-label="Default role" disabled={busy || !conn.binding}>
				{#each ROLES as r (r.value)}<NativeSelectOption value={r.value}>{r.label}</NativeSelectOption>{/each}
			</NativeSelect>
		</label>
		<label class="flex w-40 flex-col gap-1">
			<span class="text-xs font-medium">Approvals expire after (hours)</span>
			<input class="h-9 rounded-md border border-border bg-background px-2 text-sm" inputmode="decimal" bind:value={ttl} aria-label="Approval expiry in hours" aria-invalid={!!ttlProblem} onchange={() => { if (!ttlProblem) void saveSettings({ approvalTtlHours: Number(ttl) }); }} disabled={busy || !conn.binding} />
		</label>
		{#if ttlProblem}<span class="text-xs text-destructive-text">{ttlProblem}</span>{/if}
	</div>
</div>
