<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '#lib/api/index.js';
	import BindingForm from '#lib/components/app/channels/BindingForm.svelte';
	import ChannelHeader from '#lib/components/app/channels/ChannelHeader.svelte';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import ConnectFlowDialog from '#lib/components/app/ConnectFlowDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { useConnection } from '#lib/channels/connection.svelte.js';
	import { DELIVERY_OPTIONS, fieldText, isAccount, retentionError, ROLES, WAKE_OPTIONS, type ChannelPeopleSettings, type Role } from '#lib/channels/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// Everything that configures one channel: the agent, who may write, the defaults of its chats,
	// the directory defaults, reconnecting, and the one destructive action (unbind).
	const cs = useConnection();
	const id = cs.id();
	const conn = $derived(cs.conn!);
	const binding = $derived(conn.binding);
	const account = $derived(isAccount(conn));
	const agentName = $derived(binding ? (agentsStore.state.agents.find((a) => a.id === binding.agentId)?.name ?? 'The agent') : undefined);

	let busy = $state(false);
	let unbindOpen = $state(false);
	let reconnectOpen = $state(false);
	let settings = $state<ChannelPeopleSettings>({ defaultRole: 'guest', approvalTtlHours: 24, directInstructions: true });
	let ttl = $state('24');
	// the defaults of the chats, as typed ('' = the product default)
	let wake = $state(untrack(() => cs.conn?.binding?.defaults.wake ?? ''));
	let delivery = $state(untrack(() => cs.conn?.binding?.defaults.delivery ?? ''));
	let retention = $state<string | number | null>(untrack(() => (cs.conn?.binding?.defaults.retentionDays === undefined ? '' : String(cs.conn.binding.defaults.retentionDays))));
	let observe = $state(untrack(() => (cs.conn?.binding?.defaults.observe === undefined ? '' : cs.conn.binding.defaults.observe ? 'on' : 'off')));
	const retentionProblem = $derived(retentionError(retention));
	// minutes a missed message may be old and still be answered (account only)
	let missedMinutes = $state<string | number | null>(untrack(() => String(cs.conn?.binding?.missedWindowMinutes ?? 30)));
	const missedProblem = $derived(Number.isInteger(Number(missedMinutes)) && Number(missedMinutes) >= 1 && Number(missedMinutes) <= 720 ? undefined : 'Whole minutes, 1 to 720');
	const ttlProblem = $derived(ttl.trim() === '' || !(Number(ttl) >= 0.02 && Number(ttl) <= 720) ? 'Hours, 0.02 to 720' : undefined);

	onMount(() => {
		if (!conn.binding) return;
		void api
			.get('/channels/connections/{id}/people/settings', { params: { id } })
			.then((s) => {
				settings = s;
				ttl = String(s.approvalTtlHours);
			})
			.catch(() => undefined);
	});

	async function run(what: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> {
		busy = true;
		try {
			await fn();
			toast.success(ok);
			await cs.load();
			return true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what}`);
			return false;
		} finally {
			busy = false;
		}
	}
	const rebind = (patch: Record<string, unknown>, ok: string): Promise<boolean> =>
		binding ? run('save', () => api.put('/channels/connections/{id}/binding', { params: { id }, body: { agentId: binding.agentId, ...patch } }), ok) : Promise.resolve(false);

	const saveDefaults = (): Promise<boolean> | undefined => {
		if (retentionProblem) return undefined;
		return rebind(
			{
				defaults: {
					...(wake === '' ? {} : { wake }),
					...(delivery === '' ? {} : { delivery }),
					...(fieldText(retention) === '' ? {} : { retentionDays: Number(fieldText(retention)) }),
					...(observe === '' ? {} : { observe: observe === 'on' })
				}
			},
			'Defaults saved'
		);
	};
	const savePeople = (patch: Partial<ChannelPeopleSettings>): Promise<boolean> => run('save', () => api.put('/channels/connections/{id}/people/settings', { params: { id }, body: patch }), 'Saved');
	const restart = (): Promise<boolean> => run('restart', () => api.post('/channels/connections/{id}/restart', { params: { id } }), 'Restarted');
	async function unbind(): Promise<void> {
		if (await run('unbind', () => api.delete('/channels/connections/{id}/binding', { params: { id } }), account ? 'Account unbound' : 'Bot unbound')) void goto(`/channels/${encodeURIComponent(id)}/overview`);
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<ChannelHeader section="settings" description="The agent, who may write, defaults and connection." />
	<PageBody size="narrow" class="gap-4">
		<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Agent" data-testid="settings-agent">
			<div>
				<h2 class="text-sm font-medium">Agent</h2>
				<p class="text-xs text-muted-foreground">
					{#if binding}{agentName} {account ? 'owns this account. Chats you choose are stored and observe-only; the agent answers only where you change a chat to answer.' : 'answers here. Group chats must be allowed one by one on the Chats page.'} Direct messages only work for people you link on the People page.{:else}Choose the agent. {account ? 'The account starts as soon as you bind it.' : 'Polling starts as soon as you bind it.'}{/if}
				</p>
			</div>
			<BindingForm {conn} onChange={() => void cs.load()} />
		</section>

		{#if binding}
			<section class="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" aria-label="Who may write" data-testid="settings-access">
				<h2 class="text-sm font-medium">Who may write</h2>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Groups</span>
						<NativeSelect value={binding.groupPolicy} onchange={(e) => void rebind({ groupPolicy: (e.currentTarget as HTMLSelectElement).value }, 'Saved')} aria-label="Group policy" disabled={busy}>
							<NativeSelectOption value="allowlist">Only the chats I allow</NativeSelectOption>
							<NativeSelectOption value="open">Every chat the {account ? 'account' : 'bot'} is in</NativeSelectOption>
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Direct messages</span>
						<NativeSelect value={binding.dm} onchange={(e) => void rebind({ dm: (e.currentTarget as HTMLSelectElement).value }, 'Saved')} aria-label="Direct messages" disabled={busy}>
							<NativeSelectOption value="pairing">Only people linked to a team member</NativeSelectOption>
							<NativeSelectOption value="disabled">Off</NativeSelectOption>
						</NativeSelect>
					</label>
				</div>
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0">
						<div class="text-sm font-medium">Reply to unknown people</div>
						<p class="text-xs text-muted-foreground">Off (default): somebody who is not linked gets silence. On: they get one short neutral line, at most once in a while. Groups and approvals stay silent either way.</p>
					</div>
					<Switch checked={binding.replyToUnknown} onCheckedChange={(v) => void rebind({ replyToUnknown: v }, v ? 'Unknown people get a short reply' : 'Unknown people get silence')} disabled={busy} aria-label="Reply to unknown people" data-testid="reply-unknown" />
				</div>
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0">
						<div class="text-sm font-medium">Listen to other bots</div>
						<p class="text-xs text-muted-foreground">Off (default): messages from bots are dropped, so two bots never loop.</p>
					</div>
					<Switch checked={binding.allowBots} onCheckedChange={(v) => void rebind({ allowBots: v }, 'Saved')} disabled={busy} aria-label="Listen to other bots" />
				</div>
				{#if account}
					<div class="flex flex-col gap-3" data-testid="reply-missed-section">
						<div class="flex items-center justify-between gap-3">
							<div class="min-w-0">
								<div class="text-sm font-medium">Reply to messages missed while the server was down</div>
								<p class="text-xs text-muted-foreground">On (default): after a restart, messages in the chats you let the agent answer that addressed it (a mention, a reply to it, a command) are answered once per chat, with a note that they arrived late. Off: they are only stored.</p>
							</div>
							<Switch checked={binding.replyMissed} onCheckedChange={(v) => void rebind({ replyMissed: v }, v ? 'Missed messages are answered' : 'Missed messages are only stored')} disabled={busy} aria-label="Reply to messages missed while the server was down" data-testid="reply-missed" />
						</div>
						{#if binding.replyMissed}
							<label class="flex w-64 flex-col gap-1">
								<span class="text-xs font-medium">Only if they are at most this many minutes old</span>
								<Input type="number" min="1" max="720" bind:value={missedMinutes} aria-label="Missed message window in minutes" aria-invalid={!!missedProblem} onchange={() => { if (!missedProblem) void rebind({ missedWindowMinutes: Number(missedMinutes) }, 'Saved'); }} disabled={busy} data-testid="missed-window" />
								{#if missedProblem}<span class="text-xs text-destructive-text">{missedProblem}</span>{/if}
							</label>
						{/if}
					</div>
				{/if}
			</section>

			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="People defaults" data-testid="settings-people">
				<div>
					<h2 class="text-sm font-medium">People</h2>
					<p class="text-xs text-muted-foreground">What applies to somebody the team has not given a role. A chat can be marked a trusted group on its own page.</p>
				</div>
				<div class="flex flex-wrap items-end gap-3">
					<label class="flex min-w-48 flex-1 flex-col gap-1">
						<span class="text-xs font-medium">Role of somebody who is not in the directory or linked</span>
						<NativeSelect value={settings.defaultRole} onchange={(e) => void savePeople({ defaultRole: (e.currentTarget as HTMLSelectElement).value as Role })} aria-label="Default role" disabled={busy}>
							{#each ROLES as r (r.value)}<NativeSelectOption value={r.value}>{r.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex w-44 flex-col gap-1">
						<span class="text-xs font-medium">Approvals expire after (hours)</span>
						<Input inputmode="decimal" bind:value={ttl} aria-label="Approval expiry in hours" aria-invalid={!!ttlProblem} onchange={() => { if (!ttlProblem) void savePeople({ approvalTtlHours: Number(ttl) }); }} disabled={busy} />
					</label>
				</div>
				{#if ttlProblem}<span class="text-xs text-destructive-text">{ttlProblem}</span>{/if}
				<label class="flex items-start gap-2 text-sm">
					<input type="checkbox" class="mt-0.5" checked={settings.directInstructions} onchange={(e) => void savePeople({ directInstructions: (e.currentTarget as HTMLInputElement).checked })} disabled={busy} aria-label="Direct instructions run without a second confirmation" />
					<span>
						<span class="font-medium">An owner's or admin's own request needs no second "ya"</span>
						<span class="block text-xs text-muted-foreground">When an owner or admin asks in the chat to post or tag (in that same chat, tagging people they named), it runs at once. Posts the agent decides on its own, other chats and destructive actions still ask; anybody can still be refused by their role.</span>
					</span>
				</label>
			</section>

			<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Defaults for chats" data-testid="settings-defaults">
				<div>
					<h2 class="text-sm font-medium">Defaults for chats</h2>
					<p class="text-xs text-muted-foreground">What a chat does when it sets nothing itself. Every chat can change each of these on its own page.</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Answers when</span>
						<NativeSelect bind:value={wake} aria-label="Default wake">
							<NativeSelectOption value="">Product default (when mentioned)</NativeSelectOption>
							{#each WAKE_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Reply delivery</span>
						<NativeSelect bind:value={delivery} aria-label="Default delivery">
							<NativeSelectOption value="">Product default (reply in chat)</NativeSelectOption>
							{#each DELIVERY_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Keep messages (days)</span>
						<Input type="number" min="1" max="3650" placeholder="Product default" bind:value={retention} aria-invalid={!!retentionProblem} />
						{#if retentionProblem}<span class="text-xs text-destructive-text">{retentionProblem}</span>{/if}
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Record every message</span>
						<NativeSelect bind:value={observe} aria-label="Default observe">
							<NativeSelectOption value="">Product default (store everything)</NativeSelectOption>
							<NativeSelectOption value="on">Store every message (sealed)</NativeSelectOption>
							<NativeSelectOption value="off">Only what addresses the agent</NativeSelectOption>
						</NativeSelect>
					</label>
				</div>
				<div class="flex justify-end"><Button size="sm" onclick={() => void saveDefaults()} disabled={busy || !!retentionProblem} data-testid="save-defaults">Save defaults</Button></div>
			</section>
		{/if}

		<section class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4" aria-label="Connection" data-testid="settings-connection">
			<div class="min-w-0 flex-1">
				<h2 class="text-sm font-medium">Connection</h2>
				<p class="text-xs text-muted-foreground">{account ? 'Sign in to the account again, or restart it.' : 'Give the bot a new token, or restart polling.'} Queued messages and settings stay.</p>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button size="sm" variant="outline" onclick={() => (reconnectOpen = true)} disabled={busy}>{account ? 'Sign in again' : 'Reconnect with a new token'}</Button>
				{#if binding}<Button size="sm" variant="outline" onclick={() => void restart()} disabled={busy}>Restart</Button>{/if}
			</div>
		</section>

		{#if binding}
			<section class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 p-4" aria-label="Danger zone" data-testid="danger-zone">
				<div class="min-w-0 flex-1">
					<h2 class="text-sm font-medium text-destructive-text">Unbind</h2>
					<p class="text-xs text-muted-foreground">{account ? 'The agent stops using the account and the session is closed.' : 'The agent stops answering and polling stops.'} Chats, linked accounts and stored messages stay.</p>
				</div>
				<Button size="sm" variant="destructive" onclick={() => (unbindOpen = true)} disabled={busy} data-testid="unbind">Unbind</Button>
			</section>
		{/if}
	</PageBody>
</div>

<ConnectFlowDialog bind:open={reconnectOpen} connectionId={conn.id} label={conn.label} signIn={account} next={account ? 'The account starts again by itself.' : 'The bot starts again by itself.'} onDone={() => void cs.load()} />
<ConfirmDialog bind:open={unbindOpen} title={account ? 'Unbind this account?' : 'Unbind this bot?'} description={account ? 'The agent stops using the account and the session is closed. Chosen chats and stored messages stay.' : 'The agent stops answering on this bot and polling stops. Chats, linked accounts and stored messages stay.'} confirmLabel="Unbind" onConfirm={unbind} />
