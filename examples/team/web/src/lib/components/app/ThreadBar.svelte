<script lang="ts">
	import { goto } from '$app/navigation';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import ArchiveIcon from 'phosphor-svelte/lib/Archive';
	import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwise';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { toast } from 'svelte-sonner';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { timeAgo } from '#lib/time.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { threadsStore } from '#lib/stores/threads.svelte.js';
	import { cleanTitle, pickThread, splitThreads, threadHref, threadSourceBadge, threadTitle } from '#lib/threads/model.js';
	import type { Thread } from '#lib/api/client.js';

	/**
	 * The chat threads of one agent (all equal): a switcher with the list, "New chat", and rename /
	 * archive of the open one. Channel conversations will show up in the same list with a source badge.
	 */
	let { agentId, current, disabled = false }: { agentId: string; current: Thread | undefined; disabled?: boolean } = $props();

	let listOpen = $state(false);
	let showArchived = $state(false);
	let renaming = $state(false);
	let renameText = $state('');
	let busy = $state(false);

	const threads = $derived(threadsStore.threadsOf(agentId));
	const parts = $derived(splitThreads(threads));

	$effect(() => {
		void live.state.revs.threads; // a chat was created, renamed or moved (any tab)
		const id = agentId;
		void threadsStore.load(id).catch(() => {});
	});

	const fail = (e: unknown, fallback: string): void => void toast.error(e instanceof Error ? e.message : fallback);

	function open(t: Thread): void {
		listOpen = false;
		void goto(threadHref(agentId, t.id));
	}

	async function newChat(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const t = await threadsStore.create(agentId);
			listOpen = false;
			await goto(threadHref(agentId, t.id));
		} catch (e) {
			fail(e, 'Could not start a new chat');
		} finally {
			busy = false;
		}
	}

	function startRename(): void {
		if (!current) return;
		renameText = threadTitle(current);
		renaming = true;
	}
	async function rename(): Promise<void> {
		const title = cleanTitle(renameText);
		if (!current || !title) return;
		try {
			await threadsStore.rename(agentId, current.id, title);
			renaming = false;
		} catch (e) {
			fail(e, 'Could not rename the chat');
		}
	}

	async function archive(t: Thread): Promise<void> {
		try {
			await threadsStore.archive(agentId, t.id);
			if (current?.id === t.id) {
				const next = pickThread(splitThreads(threadsStore.threadsOf(agentId)).open, null);
				if (next) await goto(threadHref(agentId, next.id));
				else await newChat();
			}
		} catch (e) {
			fail(e, 'Could not archive the chat');
		}
	}
	async function restore(t: Thread): Promise<void> {
		try {
			await threadsStore.restore(agentId, t.id);
			open(t);
		} catch (e) {
			fail(e, 'Could not restore the chat');
		}
	}
</script>

{#snippet row(t: Thread)}
	{@const badge = threadSourceBadge(t)}
	<button
		type="button"
		class="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring {t.id === current?.id ? 'bg-accent' : ''}"
		data-testid="thread-row"
		onclick={() => open(t)}
	>
		<span class="min-w-0 flex-1 truncate">{threadTitle(t)}</span>
		{#if t.seed}<Badge variant="secondary" class="shrink-0 text-[10px]">{t.seed.kind}</Badge>{/if}
		{#if badge}<Badge variant="outline" class="shrink-0 text-[10px]" data-testid="thread-source">{badge}</Badge>{/if}
		<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{timeAgo(t.lastMessageAt ?? t.updatedAt)}</span>
	</button>
{/snippet}

<div class="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3" data-testid="thread-bar">
	<Popover.Root bind:open={listOpen}>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="ghost" size="sm" class="min-w-0 max-w-[60%] justify-start gap-1.5 px-2" aria-label="Chats" data-testid="thread-switcher">
					<span class="truncate text-sm">{current ? threadTitle(current) : 'Chat'}</span>
					<CaretDownIcon class="size-3.5 shrink-0" />
				</Button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content elevation="floating" align="start" class="flex max-h-[70svh] w-[min(92vw,26rem)] flex-col gap-0.5 overflow-y-auto p-1.5" aria-label="Chats">
			{#each parts.open as t (t.id)}{@render row(t)}{/each}
			{#if parts.open.length === 0}<p class="px-2 py-3 text-center text-sm text-muted-foreground">No chats yet.</p>{/if}
			{#if parts.archived.length > 0}
				<button type="button" class="mt-1 px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground" onclick={() => (showArchived = !showArchived)}>
					{showArchived ? 'Hide' : 'Show'} archived ({parts.archived.length})
				</button>
				{#if showArchived}
					{#each parts.archived as t (t.id)}
						<div class="flex items-center gap-1">
							<div class="min-w-0 flex-1 opacity-70">{@render row(t)}</div>
							<Button variant="ghost" size="icon-xs" aria-label="Restore chat" title="Restore" onclick={() => void restore(t)}><ArrowCounterClockwiseIcon class="size-3.5" /></Button>
						</div>
					{/each}
				{/if}
			{/if}
		</Popover.Content>
	</Popover.Root>
	<Button variant="ghost" size="sm" class="gap-1 px-2" disabled={busy || disabled} onclick={() => void newChat()} data-testid="new-chat">
		<PlusIcon class="size-3.5" /> New chat
	</Button>
	<div class="ml-auto">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon-xs" aria-label="Chat actions" disabled={!current}><DotsThreeIcon class="size-4" weight="bold" /></Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content elevation="floating" align="end" class="w-44">
				<DropdownMenu.Item onSelect={startRename}><PencilSimpleIcon /> Rename</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => current && void archive(current)}><ArchiveIcon /> Archive</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</div>

<Dialog.Root bind:open={renaming}>
	<Dialog.Content elevation="floating" class="sm:max-w-sm">
		<Dialog.Header><Dialog.Title>Rename chat</Dialog.Title></Dialog.Header>
		<form
			class="flex flex-col gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				void rename();
			}}
		>
			<Input bind:value={renameText} maxlength={80} aria-label="Chat name" />
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (renaming = false)}>Cancel</Button>
				<Button type="submit" disabled={!cleanTitle(renameText)}>Save</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
