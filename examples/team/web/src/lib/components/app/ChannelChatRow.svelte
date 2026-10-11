<script lang="ts">
	import { untrack } from 'svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import {
		botGone,
		botStatusLabel,
		cannotPost,
		chatSummary,
		DELIVERY_OPTIONS,
		formChanged,
		formOfChat,
		KIND_LABEL,
		policyBody,
		retentionError,
		WAKE_OPTIONS,
		type ChannelChat,
		type Delivery,
		type PolicyForm,
		type Wake
	} from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// One known chat: its summary, and the policy form (allowlist, wake, delivery, retention) with
	// a per-topic wake for forum groups.
	let { connectionId, chat, onChange }: { connectionId: string; chat: ChannelChat; onChange: () => void } = $props();

	let open = $state(false);
	let form = $state<PolicyForm>(untrack(() => formOfChat(chat)));
	let saving = $state(false);
	const base = $derived(formOfChat(chat));
	const dirty = $derived(formChanged(form, base));
	const retentionProblem = $derived(retentionError(form.retention));
	// follow the server while the form is untouched
	$effect(() => {
		const b = base;
		untrack(() => {
			if (!formChanged(form, b) || !open) form = { ...b };
		});
	});

	async function save(): Promise<void> {
		if (retentionProblem) return;
		saving = true;
		try {
			await api.patch('/channels/connections/{id}/chats/{chatId}/policy', { params: { id: connectionId, chatId: chat.chatId }, body: policyBody(form) });
			toast.success(form.allowed ? 'Chat policy saved' : 'Chat taken out of the allowlist');
			onChange();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the policy');
		} finally {
			saving = false;
		}
	}

	async function topicWake(topic: string, value: string): Promise<void> {
		try {
			if (value === '') {
				await api.delete('/channels/connections/{id}/chats/{chatId}/policy', { params: { id: connectionId, chatId: chat.chatId }, query: { topic } });
			} else {
				await api.patch('/channels/connections/{id}/chats/{chatId}/policy', { params: { id: connectionId, chatId: chat.chatId }, query: { topic }, body: { wake: value as Wake } });
			}
			onChange();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the topic');
		}
	}
</script>

<li class="rounded-lg border border-border" data-testid="chat-row">
	<button class="flex w-full min-w-0 items-center gap-3 p-3 text-left" onclick={() => (open = !open)} aria-expanded={open}>
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 items-center gap-2">
				<span class="truncate text-sm font-medium">{chat.title}</span>
				<Badge variant="secondary">{KIND_LABEL[chat.kind]}</Badge>
				{#if chat.forum}<Badge variant="secondary">Topics</Badge>{/if}
				{#if botGone(chat)}<Badge variant="destructive">Bot {botStatusLabel(chat.botStatus).toLowerCase()}</Badge>{/if}
			</div>
			<p class="truncate text-xs text-muted-foreground">{chatSummary(chat)}</p>
		</div>
		<CaretDownIcon class="size-4 shrink-0 text-muted-foreground transition-transform {open ? 'rotate-180' : ''}" />
	</button>
	{#if open}
		<div class="flex flex-col gap-4 border-t border-border p-3 text-sm">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<span>Bot: {botStatusLabel(chat.botStatus)}</span>
				{#if chat.username}<span>@{chat.username}</span>{/if}
				<span>Last heard {formatTime(chat.lastSeen)}</span>
				<span class="font-mono">{chat.chatId}</span>
			</div>
			{#if cannotPost(chat)}
				<p class="text-xs text-warning-text">The bot cannot post here (no rights). It can read, but replies will fail until it is allowed to send messages.</p>
			{/if}
			<label class="flex items-center justify-between gap-3">
				<span>
					<span class="font-medium">Allow the agent here</span>
					<span class="block text-xs text-muted-foreground">Off: the chat is ignored and nothing is stored.</span>
				</span>
				<Switch bind:checked={form.allowed} aria-label="Allow the agent in this chat" />
			</label>
			<div class="grid gap-3 sm:grid-cols-3">
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Wakes</span>
					<NativeSelect bind:value={form.wake} disabled={!form.allowed} aria-label="When the agent wakes">
						{#each WAKE_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Replies</span>
					<NativeSelect bind:value={form.delivery} disabled={!form.allowed} aria-label="How answers are delivered">
						{#each DELIVERY_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium">Keep messages (days)</span>
					<Input type="number" min="1" max="3650" placeholder="30" bind:value={form.retention} disabled={!form.allowed} aria-invalid={!!retentionProblem} />
					{#if retentionProblem}<span class="text-xs text-destructive-text">{retentionProblem}</span>{/if}
				</label>
			</div>
			<p class="text-xs text-muted-foreground">
				{WAKE_OPTIONS.find((o) => o.value === form.wake)?.hint} {DELIVERY_OPTIONS.find((o) => o.value === (form.delivery as Delivery))?.hint}
			</p>
			{#if chat.topics.length > 0}
				<div class="flex flex-col gap-2">
					<h4 class="text-xs font-medium">Topics</h4>
					{#each chat.topics as t (t.id)}
						<div class="flex items-center justify-between gap-3">
							<span class="min-w-0 truncate text-sm">{t.name}</span>
							<NativeSelect value={t.policy?.wake ?? ''} onchange={(e) => void topicWake(t.id, (e.currentTarget as HTMLSelectElement).value)} disabled={!chat.effective.allowed} class="h-8 w-44 text-xs" aria-label="Wake in topic {t.name}">
								<NativeSelectOption value="">Like the chat</NativeSelectOption>
								{#each WAKE_OPTIONS as o (o.value)}<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>{/each}
							</NativeSelect>
						</div>
					{/each}
				</div>
			{/if}
			<div class="flex justify-end gap-2">
				<Button size="sm" variant="ghost" disabled={!dirty || saving} onclick={() => (form = { ...base })}>Reset</Button>
				<Button size="sm" disabled={!dirty || saving || !!retentionProblem} onclick={() => void save()} data-testid="chat-save">Save</Button>
			</div>
		</div>
	{/if}
</li>
