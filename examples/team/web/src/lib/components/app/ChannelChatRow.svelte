<script lang="ts">
	import { untrack } from 'svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import {
		botGone,
		connectionText,
		cannotPost,
		chatSummary,
		DELIVERY_OPTIONS,
		formChanged,
		formOfChat,
		KIND_LABEL,
		quietText,
		wakeHint,
		originText,
		policyBody,
		proactiveError,
		retentionError,
		WAKE_OPTIONS,
		type ChatBranch,
		type PolicyForm
	} from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';
	import Self from './ChannelChatRow.svelte';

	// One place of a connection (a chat, a channel or a forum topic) and, below it, its children.
	// The form edits what this node sets itself: every field can inherit from the node above it,
	// the connection or the defaults, and says where the value in force comes from.
	let {
		connectionId,
		connectionLabel = 'This connection',
		branch,
		titleOf,
		depth = 0,
		onChange
	}: { connectionId: string; connectionLabel?: string; branch: ChatBranch; titleOf: (nodeId: string) => string; depth?: number; onChange: () => void } = $props();

	const chat = $derived(branch.chat);
	let open = $state(false);
	let form = $state<PolicyForm>(untrack(() => formOfChat(branch.chat)));
	let saving = $state(false);
	const base = $derived(formOfChat(chat));
	const dirty = $derived(formChanged(form, base));
	const retentionProblem = $derived(retentionError(form.retention));
	const proactiveProblem = $derived(proactiveError(form));
	const nested = $derived(depth > 0);
	// follow the server while the form is untouched
	$effect(() => {
		const b = base;
		untrack(() => {
			if (!formChanged(form, b) || !open) form = { ...b };
		});
	});

	const origin = (key: Parameters<typeof originText>[1]): string => originText(chat, key, titleOf);
	const inheritLabel = (what: string): string => `Inherit (${what})`;

	async function save(): Promise<void> {
		if (retentionProblem || proactiveProblem) return;
		saving = true;
		try {
			await api.patch('/channels/connections/{id}/chats/{chatId}/policy', { params: { id: connectionId, chatId: chat.id }, body: policyBody(form) });
			toast.success('Settings saved');
			onChange();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the settings');
		} finally {
			saving = false;
		}
	}

	async function clearAll(): Promise<void> {
		saving = true;
		try {
			await api.delete('/channels/connections/{id}/chats/{chatId}/policy', { params: { id: connectionId, chatId: chat.id } });
			toast.success('Back to the inherited settings');
			onChange();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not clear the settings');
		} finally {
			saving = false;
		}
	}
</script>

<li class="rounded-lg border border-border" data-testid={nested ? 'topic-row' : 'chat-row'}>
	<button class="flex w-full min-w-0 items-center gap-3 p-3 text-left" onclick={() => (open = !open)} aria-expanded={open}>
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 items-center gap-2">
				<span class="truncate text-sm font-medium">{chat.title}</span>
				<Badge variant="secondary">{nested ? 'Topic' : KIND_LABEL[chat.chatKind]}</Badge>
				{#if chat.container}<Badge variant="secondary">Topics</Badge>{/if}
				{#if chat.state === 'closed' || chat.state === 'archived'}<Badge variant="secondary">{chat.state === 'closed' ? 'Closed' : 'Archived'}</Badge>{/if}
				{#if botGone(chat)}<Badge variant="destructive">Not in this chat</Badge>{/if}
			</div>
			<p class="truncate text-xs text-muted-foreground">{chat.container && !chat.postable ? `Messages live in the topics below. ${chatSummary(chat)}` : chatSummary(chat)}</p>
		</div>
		<CaretDownIcon class="size-4 shrink-0 text-muted-foreground transition-transform {open ? 'rotate-180' : ''}" />
	</button>
	{#if open}
		<div class="flex flex-col gap-4 border-t border-border p-3 text-sm">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<span>Connection: {connectionText(connectionLabel, chat.member)}</span>
				{#if chat.username}<span>@{chat.username}</span>{/if}
				<span>Last heard {formatTime(chat.lastSeen)}</span>
				<span class="font-mono">{chat.nativeId}</span>
			</div>
			{#if cannotPost(chat)}
				<p class="text-xs text-warning-text">The connection cannot post here (no rights). It can read, but replies will fail until it is allowed to send messages.</p>
			{/if}
			{#if chat.container}
				<p class="text-xs text-muted-foreground">Settings set here apply to every topic below unless a topic sets its own.</p>
			{/if}
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Allow the agent <span class="font-normal text-muted-foreground">· {origin('enabled')}</span></span>
					<NativeSelect bind:value={form.allowed} aria-label="Allow the agent here">
						<NativeSelectOption value="">{inheritLabel(chat.effective.allowed ? 'allowed' : 'not allowed')}</NativeSelectOption>
						<NativeSelectOption value="on">Allowed</NativeSelectOption>
						<NativeSelectOption value="off">Not allowed (nothing is stored)</NativeSelectOption>
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Wakes <span class="font-normal text-muted-foreground">· {origin('wake')}</span></span>
					<NativeSelect bind:value={form.wake} aria-label="When the agent wakes">
						<NativeSelectOption value="">{inheritLabel(WAKE_OPTIONS.find((o) => o.value === chat.effective.wake)?.label ?? chat.effective.wake)}</NativeSelectOption>
						{#each WAKE_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Replies <span class="font-normal text-muted-foreground">· {origin('delivery')}</span></span>
					<NativeSelect bind:value={form.delivery} aria-label="How answers are delivered">
						<NativeSelectOption value="">{inheritLabel(DELIVERY_OPTIONS.find((o) => o.value === chat.effective.delivery)?.label ?? chat.effective.delivery)}</NativeSelectOption>
						{#each DELIVERY_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Keep messages (days) <span class="font-normal text-muted-foreground">· {origin('retentionDays')}</span></span>
					<Input type="number" min="1" max="3650" placeholder="Inherit ({chat.effective.retentionDays})" bind:value={form.retention} aria-invalid={!!retentionProblem} />
					{#if retentionProblem}<span class="text-xs text-destructive-text">{retentionProblem}</span>{/if}
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Full log <span class="font-normal text-muted-foreground">· {origin('observe')}</span></span>
					<NativeSelect bind:value={form.observe} aria-label="Store every message">
						<NativeSelectOption value="">{inheritLabel(chat.effective.observe ? 'store everything' : 'only what addresses the agent')}</NativeSelectOption>
						<NativeSelectOption value="on">Store every message (sealed)</NativeSelectOption>
						<NativeSelectOption value="off">Only what addresses the agent</NativeSelectOption>
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Session <span class="font-normal text-muted-foreground">· {origin('sessionScope')}</span></span>
					<NativeSelect bind:value={form.sessionScope} aria-label="Session scope">
						<NativeSelectOption value="">{inheritLabel(chat.effective.sessionScope === 'room' ? 'shared with the room' : 'its own')}</NativeSelectOption>
						<NativeSelectOption value="node">Its own session</NativeSelectOption>
						<NativeSelectOption value="room">Shared with the room</NativeSelectOption>
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1 sm:col-span-2">
					<span class="text-xs font-medium">When a message is deleted on the platform <span class="font-normal text-muted-foreground">· {origin('redactOnDelete')}</span></span>
					<NativeSelect bind:value={form.redactOnDelete} aria-label="Deleted messages">
						<NativeSelectOption value="">{inheritLabel(chat.effective.redactOnDelete ? 'drop the content' : 'keep it for audit until retention')}</NativeSelectOption>
						<NativeSelectOption value="off">Keep the content for audit until retention</NativeSelectOption>
						<NativeSelectOption value="on">Drop the content</NativeSelectOption>
					</NativeSelect>
				</label>
			</div>
			<fieldset class="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2" data-testid="people-fields">
				<legend class="px-1 text-xs font-medium">People and tone <span class="font-normal text-muted-foreground">· who counts as a member here, how long replies are</span></legend>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Trusted internal group <span class="font-normal text-muted-foreground">· {origin('defaultRole')}</span></span>
					<NativeSelect bind:value={form.defaultRole} aria-label="Trusted internal group">
						<NativeSelectOption value="">{inheritLabel(chat.effective.defaultRole === 'member' ? 'trusted: unknown people are members' : 'unknown people are guests')}</NativeSelectOption>
						<NativeSelectOption value="member">Trusted: unknown people here are members</NativeSelectOption>
						<NativeSelectOption value="guest">Not trusted: unknown people are guests</NativeSelectOption>
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Reply style <span class="font-normal text-muted-foreground">· {origin('replyStyle')}</span></span>
					<NativeSelect bind:value={form.replyStyle} aria-label="Reply style">
						<NativeSelectOption value="">{inheritLabel(chat.effective.replyStyle ?? 'the agent decides')}</NativeSelectOption>
						<NativeSelectOption value="brief">Brief</NativeSelectOption>
						<NativeSelectOption value="normal">Normal</NativeSelectOption>
						<NativeSelectOption value="detailed">Detailed</NativeSelectOption>
					</NativeSelect>
				</label>
				<p class="text-xs text-muted-foreground sm:col-span-2">Owners and admins are always set on the People tab. Anybody you have not given a role is a guest, unless this chat is a trusted internal group. You get a notification for each new unknown person.</p>
			</fieldset>
			<fieldset class="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2" data-testid="proactive-fields">
				<legend class="px-1 text-xs font-medium">Proactive posts <span class="font-normal text-muted-foreground">· what the agent says unasked (routines, heartbeat) · {origin('proactive')}</span></legend>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Allowed</span>
					<NativeSelect bind:value={form.proactive} aria-label="Proactive posts allowed">
						<NativeSelectOption value="">{inheritLabel(chat.effective.proactive.allowed ? 'allowed' : 'not allowed')}</NativeSelectOption>
						<NativeSelectOption value="on">Allowed</NativeSelectOption>
						<NativeSelectOption value="off">Not allowed</NativeSelectOption>
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">One digest instead of many pings</span>
					<NativeSelect bind:value={form.digest} aria-label="Digest">
						<NativeSelectOption value="">{inheritLabel(chat.effective.proactive.digest ? `digest every ${chat.effective.proactive.digestMinutes} min` : 'send at once')}</NativeSelectOption>
						<NativeSelectOption value="on">Digest</NativeSelectOption>
						<NativeSelectOption value="off">Send at once</NativeSelectOption>
					</NativeSelect>
				</label>
				<div class="flex items-end gap-2">
					<label class="flex flex-1 flex-col gap-1"><span class="text-xs font-medium">Quiet from (HH:MM)</span><Input placeholder={chat.effective.proactive.quietHours?.from ?? '22:00'} bind:value={form.quietFrom} aria-label="Quiet hours start" /></label>
					<label class="flex flex-1 flex-col gap-1"><span class="text-xs font-medium">to</span><Input placeholder={chat.effective.proactive.quietHours?.to ?? '07:00'} bind:value={form.quietTo} aria-label="Quiet hours end" /></label>
				</div>
				<p class="text-xs text-muted-foreground sm:col-span-2" data-testid="quiet-inherited">
					{#if quietText(chat.effective.proactive.quietHours)}Quiet hours in force: {quietText(chat.effective.proactive.quietHours)} · {origin('proactive')}. Leave both empty to inherit.{:else}No quiet hours are set. Leave both empty to inherit.{/if}
				</p>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Mentions per message</span>
					<Input type="number" min="0" max="20" placeholder="Inherit ({chat.effective.proactive.maxMentions})" bind:value={form.maxMentions} />
				</label>
				{#if proactiveProblem}<span class="text-xs text-destructive-text sm:col-span-2">{proactiveProblem}</span>{/if}
			</fieldset>
			<p class="text-xs text-muted-foreground">
				{wakeHint(form.wake, chat.effective.wake)}
			</p>
			<div class="flex justify-end gap-2">
				<Button size="sm" variant="ghost" disabled={saving || chat.policy === null} onclick={() => void clearAll()}>Inherit everything</Button>
				<Button size="sm" variant="ghost" disabled={!dirty || saving} onclick={() => (form = { ...base })}>Reset</Button>
				<Button size="sm" disabled={!dirty || saving || !!retentionProblem || !!proactiveProblem} onclick={() => void save()} data-testid="chat-save">Save</Button>
			</div>
		</div>
	{/if}
	{#if branch.children.length > 0}
		<ul class="flex flex-col gap-2 border-t border-border bg-muted/30 p-2 pl-5">
			{#each branch.children as child (child.chat.id)}
				<Self {connectionId} {connectionLabel} branch={child} {titleOf} depth={depth + 1} {onChange} />
			{/each}
		</ul>
	{/if}
</li>
