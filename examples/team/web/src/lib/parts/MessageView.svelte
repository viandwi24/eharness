<script lang="ts">
	import type { UIMessage } from 'ai';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Message, MessageAvatar, MessageContent, MessageHeader } from '#lib/components/ai/message/index.js';
	import ApprovalPart, { type ApprovalAnswer } from './ApprovalPart.svelte';
	import CompactionPart from './CompactionPart.svelte';
	import EventPart from './EventPart.svelte';
	import FilePart from './FilePart.svelte';
	import InputPart from './InputPart.svelte';
	import { hasVisibleParts, messageKind, type PartView, viewModel } from './map.js';
	import ReasoningPart from './ReasoningPart.svelte';
	import SourcePart from './SourcePart.svelte';
	import SubagentPart from './SubagentPart.svelte';
	import TextPart from './TextPart.svelte';
	import ToolGroup from './ToolGroup.svelte';
	import ToolPart from './ToolPart.svelte';
	import { isActivityTool, type ToolView, writtenFiles } from './activity.js';
	import FileCard from './FileCard.svelte';

	type Block =
		| { type: 'view'; view: PartView }
		| { type: 'files'; views: Extract<PartView, { kind: 'file' }>[] }
		| { type: 'sources'; views: Extract<PartView, { kind: 'source' }>[] }
		| { type: 'tools'; views: ToolView[] };

	let {
		message,
		agent,
		onApproval,
		onOpenSession
	}: {
		message: UIMessage;
		/** Author of an assistant message (multi-agent header). `id` seeds the avatar. */
		agent?: { id: string; name: string; color?: string };
		onApproval?: (answer: ApprovalAnswer) => void;
		onOpenSession?: (sessionId: string) => void;
	} = $props();

	const views = $derived(viewModel(message));
	const kind = $derived(messageKind(message));

	// Consecutive files / sources / plain tool calls collapse into one block.
	const blocks = $derived.by((): Block[] => {
		const out: Block[] = [];
		for (const v of views) {
			const last = out.at(-1);
			if (v.kind === 'file') {
				if (last?.type === 'files') last.views.push(v);
				else out.push({ type: 'files', views: [v] });
			} else if (v.kind === 'source') {
				if (last?.type === 'sources') last.views.push(v);
				else out.push({ type: 'sources', views: [v] });
			} else if (isActivityTool(v)) {
				if (last?.type === 'tools') last.views.push(v);
				else out.push({ type: 'tools', views: [v] });
			} else out.push({ type: 'view', view: v });
		}
		return out;
	});

	const visible = $derived(hasVisibleParts(views));

	// One file card per path and message: under the last tool group that wrote it, labelled with
	// the first action (a file created and then edited is "Created").
	const fileCards = $derived.by(() => {
		const at = new Map<number, ReturnType<typeof writtenFiles>>();
		const first = new Map<string, { block: number; file: ReturnType<typeof writtenFiles>[number] }>();
		blocks.forEach((b, i) => {
			if (b.type !== 'tools') return;
			for (const f of writtenFiles(b.views)) first.set(f.path, { block: i, file: first.get(f.path)?.file ?? f });
		});
		for (const { block, file } of first.values()) at.set(block, [...(at.get(block) ?? []), file]);
		return at;
	});
</script>

{#snippet part(v: PartView)}
	{#if v.kind === 'text'}
		{#if message.role === 'user'}<span class="whitespace-pre-wrap">{v.text}</span>{:else}<TextPart text={v.text} />{/if}
	{:else if v.kind === 'reasoning'}
		<ReasoningPart text={v.text} streaming={v.streaming} durationMs={v.durationMs} />
	{:else if v.kind === 'tool'}
		{#if v.isSubagent}
			<SubagentPart view={v} {onOpenSession} />
		{:else}
			<ToolPart view={v} />
		{/if}
	{:else if v.kind === 'approval'}
		<ApprovalPart view={v} {onApproval} />
	{:else if v.kind === 'subagentRun'}
		<SubagentPart view={v} {onOpenSession} />
	{:else if v.kind === 'input'}
		<InputPart view={v} />
	{/if}
{/snippet}

{#if kind === 'eh.event' || kind === 'eh.compaction'}
	<!-- Kind messages are divider rows, not bubbles. -->
	{#each views as v (v.key)}
		{#if v.kind === 'event'}<EventPart name={v.name} text={v.text} />{:else if v.kind === 'compaction'}<CompactionPart summary={v.summary} />{/if}
	{/each}
{:else if visible}
	<Message from={message.role === 'user' ? 'user' : 'assistant'}>
		{#if message.role !== 'user' && agent}
			<MessageHeader>
				<MessageAvatar><AgentAvatar seed={agent.id} color={agent.color} size={22} /></MessageAvatar>
				{agent.name}
			</MessageHeader>
		{/if}
		<MessageContent class="flex flex-col gap-2.5">
			{#each blocks as b, i (b.type === 'view' ? b.view.key : `${b.type}:${i}`)}
				{#if b.type === 'files'}
					<FilePart views={b.views} />
				{:else if b.type === 'sources'}
					<SourcePart views={b.views} />
				{:else if b.type === 'tools'}
					{#if b.views.length === 1}<ToolPart view={b.views[0]} />{:else}<ToolGroup views={b.views} />{/if}
					{#each fileCards.get(i) ?? [] as f (f.path)}<FileCard file={f} />{/each}
				{:else}
					{@render part(b.view)}
				{/if}
			{/each}
		</MessageContent>
	</Message>
{/if}
