<script lang="ts">
	// A chat of a connection: the connection, then one of its chats (or a typed title/id).
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { Lookups } from '#lib/scripts/lookups.svelte.js';
	import type { ChatValue } from '#lib/scripts/recipes.js';

	let { value = $bindable({ connection: '', chat: '' }), lookups, id, allowAny = false }: { value?: ChatValue; lookups: Lookups; id: string; allowAny?: boolean } = $props();

	const L = $derived(lookups.state);
	const chats = $derived(L.chats[value.connection] ?? []);
	let typed = $state(false);

	$effect(() => {
		if (!value.connection && L.connections.length === 1) value = { ...value, connection: L.connections[0]!.value };
	});
	$effect(() => {
		if (value.connection) void lookups.chatsOf(value.connection);
	});
</script>

<div class="flex flex-wrap items-center gap-2">
	<NativeSelect id="{id}-connection" class="min-w-40 flex-1" aria-label="Connection" value={value.connection} onchange={(e) => (value = { connection: e.currentTarget.value, chat: '' })}>
		<NativeSelectOption value="">Connection…</NativeSelectOption>
		{#each L.connections as c (c.value)}<NativeSelectOption value={c.value}>{c.label}</NativeSelectOption>{/each}
	</NativeSelect>
	{#if typed || (value.connection && !chats.length)}
		<Input id="{id}-chat" class="min-w-40 flex-1" placeholder="Chat title or id" aria-label="Chat" value={value.chat} oninput={(e) => (value = { ...value, chat: e.currentTarget.value })} autocomplete="off" />
	{:else}
		<NativeSelect id="{id}-chat" class="min-w-40 flex-1" aria-label="Chat" disabled={!value.connection} value={value.chat} onchange={(e) => (value = { ...value, chat: e.currentTarget.value })}>
			<NativeSelectOption value="">{allowAny ? 'Any chat' : 'Chat…'}</NativeSelectOption>
			{#each chats as c (c.value)}<NativeSelectOption value={c.value}>{c.label}{c.hint === 'topic' ? ' (topic)' : ''}</NativeSelectOption>{/each}
		</NativeSelect>
	{/if}
	{#if value.connection && chats.length}
		<button type="button" class="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" onclick={() => (typed = !typed)}>{typed ? 'Pick from list' : 'Type it'}</button>
	{/if}
	{#if !L.connections.length && L.loaded}
		<p class="w-full text-xs text-muted-foreground">No chat connection yet. Connect one on the Channels page.</p>
	{/if}
</div>
