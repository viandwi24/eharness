<script lang="ts">
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import SidebarSimpleIcon from 'phosphor-svelte/lib/SidebarSimple';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import {
		Conversation,
		ConversationContent,
		ConversationItem,
		ConversationScrollButton
	} from '#lib/components/ai/conversation/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { agents } from '#lib/mock.js'; // MOCK: only to resolve fixture message authors
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { fixtureMessages } from '#lib/parts/fixtures.js';
	import MessageView from '#lib/parts/MessageView.svelte';
	import ChatComposer from './ChatComposer.svelte';

	let {
		agentId,
		onTogglePanel
	}: { agentId: string; onTogglePanel: () => void } = $props();

	const agent = $derived(agentsStore.find(agentId));
	$effect(() => {
		if (!agentsStore.find(agentId)) void agentsStore.get(agentId).catch(() => {});
	});
</script>

<section class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
	<header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
		<Button href="/" variant="ghost" size="icon-sm" class="md:hidden" aria-label="Back to agents">
			<CaretLeftIcon class="size-4" />
		</Button>
		{#if agent}
			<AgentAvatar seed={agent.id} color={agent.color} size={32} label={agent.name} />
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm font-medium">{agent.name}</div>
				<div class="truncate text-xs text-muted-foreground">{agent.description}</div>
			</div>
		{:else}
			<div class="flex-1 text-sm text-muted-foreground">Unknown agent</div>
		{/if}
		<Button variant="ghost" size="icon-sm" aria-label="Agent actions"><DotsThreeIcon class="size-4" /></Button>
		<Button variant="ghost" size="icon-sm" aria-label="Toggle context panel" onclick={onTogglePanel}>
			<SidebarSimpleIcon class="size-4" />
		</Button>
	</header>

	<Conversation class="min-h-0 flex-1">
		<ConversationContent class="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
			{#each fixtureMessages as f (f.message.id)}
				{@const author = agents.find((a) => a.id === f.agentId)}
				<ConversationItem messageId={f.message.id}>
					<MessageView
						message={f.message}
						agent={author ? { id: author.id, name: author.name } : undefined}
						onApproval={(a) => console.debug('approval', a)}
						onOpenSession={(id) => console.debug('open session', id)}
					/>
				</ConversationItem>
			{/each}
		</ConversationContent>
		<ConversationScrollButton />
	</Conversation>

	<div class="mx-auto w-full max-w-3xl shrink-0 p-3">
		<ChatComposer onSend={() => {}} />
	</div>
</section>
