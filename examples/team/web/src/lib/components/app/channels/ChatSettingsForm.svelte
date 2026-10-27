<script lang="ts">
	import { untrack } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import {
		connectionText,
		cannotPost,
		DELIVERY_OPTIONS,
		formChanged,
		formOfChat,
		MAX_OVERLAY,
		quietText,
		wakeHint,
		originText,
		policyBody,
		proactiveError,
		retentionError,
		WAKE_OPTIONS,
		type ChannelChat,
		type PolicyForm
	} from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// The settings of one chat or topic. The form edits what this node sets itself: every field can
	// inherit from the node above it, the connection or the defaults, and says where the value in
	// force comes from.
	let {
		connectionId,
		connectionLabel = 'This connection',
		chat,
		titleOf,
		onChange
	}: { connectionId: string; connectionLabel?: string; chat: ChannelChat; titleOf: (nodeId: string) => string; onChange: (chat: ChannelChat) => void } = $props();

	let form = $state<PolicyForm>(untrack(() => formOfChat(chat)));
	let saving = $state(false);
	const base = $derived(formOfChat(chat));
	const dirty = $derived(formChanged(form, base));
	const retentionProblem = $derived(retentionError(form.retention));
	const proactiveProblem = $derived(proactiveError(form));
	// follow the server while the form is untouched
	$effect(() => {
		const b = base;
		untrack(() => {
			if (!formChanged(form, b)) form = { ...b };
		});
	});

	const origin = (key: Parameters<typeof originText>[1]): string => originText(chat, key, titleOf);
	const inheritLabel = (what: string): string => `Same as above: ${what}`;
	const agents = $derived(agentsStore.state.agents.filter((a) => a.archivedAt === null || a.id === form.agentId));
	const agentName = (agentId: string): string => agentsStore.state.agents.find((a) => a.id === agentId)?.name ?? agentId;

	async function save(): Promise<void> {
		if (retentionProblem || proactiveProblem) return;
		saving = true;
		try {
			const saved = await api.patch('/channels/connections/{id}/chats/{chatId}/policy', { params: { id: connectionId, chatId: chat.id }, body: policyBody(form) });
			toast.success('Settings saved');
			onChange(saved);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the settings');
		} finally {
			saving = false;
		}
	}

	async function clearAll(): Promise<void> {
		saving = true;
		try {
			const saved = await api.delete('/channels/connections/{id}/chats/{chatId}/policy', { params: { id: connectionId, chatId: chat.id } });
			toast.success('Back to the inherited settings');
			onChange(saved);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not clear the settings');
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex flex-col gap-4 text-sm" data-testid="chat-settings">
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
	<div class="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2" data-testid="feed">
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Agent for this chat <span class="font-normal text-muted-foreground">· {origin('agentId')}</span></span>
			<NativeSelect bind:value={form.agentId} aria-label="Agent for this chat">
				<NativeSelectOption value="">{inheritLabel(chat.effective.agentId ? agentName(chat.effective.agentId) : 'the connection agent')}</NativeSelectOption>
				{#each agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
			</NativeSelect>
			<span class="text-xs text-muted-foreground">Its instructions decide what it does with this chat (write them on the agent page). Give it its own agent to process a chat differently.</span>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Feed for its agent <span class="font-normal text-muted-foreground">· {origin('feed')}</span></span>
			<NativeSelect bind:value={form.feed} aria-label="Feed for its agent">
				<NativeSelectOption value="">{inheritLabel(chat.effective.feed ? 'a feed' : 'not a feed')}</NativeSelectOption>
				<NativeSelectOption value="on">A feed: every message is input</NativeSelectOption>
				<NativeSelectOption value="off">Not a feed</NativeSelectOption>
			</NativeSelect>
			<span class="text-xs text-muted-foreground">The agent reads every message here (also what this account posts itself) and never answers here. It acts with its tools on its own permissions: post or copy to other chats, keep notes in library files or tables, as its instructions say.</span>
		</label>
		{#if form.feed === 'on' || (form.feed === '' && chat.effective.feed)}
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium">Copies from here <span class="font-normal text-muted-foreground">· {origin('copyTrial')}</span></span>
				<NativeSelect bind:value={form.copyTrial} aria-label="Copies from here">
					<NativeSelectOption value="">{inheritLabel(chat.effective.copyTrial ? 'trial' : 'sent')}</NativeSelectOption>
					<NativeSelectOption value="on">Trial: only recorded, nothing sent</NativeSelectOption>
					<NativeSelectOption value="off">Sent for real</NativeSelectOption>
				</NativeSelect>
				<span class="text-xs text-muted-foreground">In trial the agent decides as usual and each decision is kept (the copy records, and whatever it logs); check them, then switch to sent.</span>
			</label>
		{/if}
	</div>
	<div class="grid gap-3 sm:grid-cols-2" data-testid="essentials">
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Agent may be used here <span class="font-normal text-muted-foreground">· {origin('enabled')}</span></span>
			<NativeSelect bind:value={form.allowed} aria-label="Allow the agent here">
				<NativeSelectOption value="">{inheritLabel(chat.effective.allowed ? 'allowed' : 'not allowed')}</NativeSelectOption>
				<NativeSelectOption value="on">Allowed</NativeSelectOption>
				<NativeSelectOption value="off">Not allowed (nothing is stored)</NativeSelectOption>
			</NativeSelect>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Answers when <span class="font-normal text-muted-foreground">· {origin('wake')}</span></span>
			<NativeSelect bind:value={form.wake} aria-label="When the agent wakes">
				<NativeSelectOption value="">{inheritLabel(WAKE_OPTIONS.find((o) => o.value === chat.effective.wake)?.label ?? chat.effective.wake)}</NativeSelectOption>
				{#each WAKE_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
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
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Trusted group <span class="font-normal text-muted-foreground">· {origin('defaultRole')}</span></span>
			<NativeSelect bind:value={form.defaultRole} aria-label="Trusted internal group">
				<NativeSelectOption value="">{inheritLabel(chat.effective.defaultRole === 'member' ? 'trusted (members)' : 'not trusted (guests)')}</NativeSelectOption>
				<NativeSelectOption value="member">Trusted: unknown people here are members</NativeSelectOption>
				<NativeSelectOption value="guest">Not trusted: unknown people are guests</NativeSelectOption>
			</NativeSelect>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Reply delivery <span class="font-normal text-muted-foreground">· {origin('delivery')}</span></span>
			<NativeSelect bind:value={form.delivery} aria-label="How answers are delivered">
				<NativeSelectOption value="">{inheritLabel(DELIVERY_OPTIONS.find((o) => o.value === chat.effective.delivery)?.label ?? chat.effective.delivery)}</NativeSelectOption>
				{#each DELIVERY_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
			</NativeSelect>
		</label>
	</div>
	<p class="text-xs text-muted-foreground">Owners and admins are set on the People tab. Anybody without a role is a guest, unless this chat is a trusted group.</p>
	<section class="flex flex-col gap-4 border-t border-border pt-4" data-testid="more-settings">
		<h3 class="text-xs font-medium">More settings: history, tone, unasked posts</h3>
		<div class="flex flex-col gap-4">
			<div class="grid gap-3 sm:grid-cols-2">
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Keep messages (days) <span class="font-normal text-muted-foreground">· {origin('retentionDays')}</span></span>
			<Input type="number" min="1" max="3650" placeholder="Same as above ({chat.effective.retentionDays})" bind:value={form.retention} aria-invalid={!!retentionProblem} />
			{#if retentionProblem}<span class="text-xs text-destructive-text">{retentionProblem}</span>{/if}
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Record every message <span class="font-normal text-muted-foreground">· {origin('observe')}</span></span>
			<NativeSelect bind:value={form.observe} aria-label="Store every message">
				<NativeSelectOption value="">{inheritLabel(chat.effective.observe ? 'store everything' : 'only what addresses the agent')}</NativeSelectOption>
				<NativeSelectOption value="on">Store every message (sealed)</NativeSelectOption>
				<NativeSelectOption value="off">Only what addresses the agent</NativeSelectOption>
			</NativeSelect>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium">Conversation <span class="font-normal text-muted-foreground">· {origin('sessionScope')}</span></span>
			<NativeSelect bind:value={form.sessionScope} aria-label="Session scope">
				<NativeSelectOption value="">{inheritLabel(chat.effective.sessionScope === 'room' ? 'shared with the whole room' : 'separate for this place')}</NativeSelectOption>
				<NativeSelectOption value="node">Separate for this place</NativeSelectOption>
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
		<label class="flex flex-col gap-1 sm:col-span-2">
			<span class="text-xs font-medium">Tone for this place <span class="font-normal text-muted-foreground">· {origin('personaOverlay')}</span></span>
			<Textarea bind:value={form.personaOverlay} rows={2} maxlength={MAX_OVERLAY} aria-label="Persona overlay" placeholder={chat.effective.personaOverlay ? `Inherited: ${chat.effective.personaOverlay}` : 'Tone, language or length for this place, e.g. “Answer in English, three sentences at most.”'} />
			<span class="text-xs text-muted-foreground">{form.personaOverlay.length} / {MAX_OVERLAY}. Tone, language and length only: it cannot give the agent tools or loosen a rule. Inherited by the topics below; empty = inherit.</span>
		</label>
			</div>
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
			<Input type="number" min="0" max="20" placeholder="Same as above ({chat.effective.proactive.maxMentions})" bind:value={form.maxMentions} />
		</label>
		{#if proactiveProblem}<span class="text-xs text-destructive-text sm:col-span-2">{proactiveProblem}</span>{/if}
	</fieldset>
		</div>
	</section>
	<p class="text-xs text-muted-foreground">
		{wakeHint(form.wake, chat.effective.wake)}
	</p>
	<div class="flex justify-end gap-2">
		<Button size="sm" variant="ghost" disabled={saving || chat.policy === null} onclick={() => void clearAll()}>Use the settings above</Button>
		<Button size="sm" variant="ghost" disabled={!dirty || saving} onclick={() => (form = { ...base })}>Reset</Button>
		<Button size="sm" disabled={!dirty || saving || !!retentionProblem || !!proactiveProblem} onclick={() => void save()} data-testid="chat-save">Save</Button>
	</div>
</div>
