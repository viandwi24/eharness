<script lang="ts">
	import type { UIMessage } from 'ai';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Message, MessageAvatar, MessageContent, MessageHeader } from '#lib/components/ai/message/index.js';
		import CompactionPart from './CompactionPart.svelte';
	import EventPart from './EventPart.svelte';
	import FilePart from './FilePart.svelte';
	import InstructionCard from './InstructionCard.svelte';
	import InputPart from './InputPart.svelte';
	import NoticePart from './NoticePart.svelte';
	import { hasVisibleParts, isInstructionMessage, messageKind, type PartView, viewModel, wasStopped } from './map.js';
	import ReasoningPart from './ReasoningPart.svelte';
	import SourcePart from './SourcePart.svelte';
	import SubagentPart from './SubagentPart.svelte';
	import TextPart from './TextPart.svelte';
	import UserText from './UserText.svelte';
	import ToolGroup from './ToolGroup.svelte';
	import ToolPart from './ToolPart.svelte';
	import { isActivityTool, type ToolView, writtenFiles } from './activity.js';
	import FileCard from './FileCard.svelte';
	import ArtifactChatCard from '#lib/components/artifacts/ArtifactChatCard.svelte';
	import ArtifactToolPart from '#lib/components/artifacts/ArtifactToolPart.svelte';
	import RunPythonPart from '#lib/components/artifacts/RunPythonPart.svelte';
	import { setMessageEnv } from '#lib/artifacts/context.js';
	import { messageText, scanFences } from '#lib/artifacts/fences.js';
	import type { ApprovalStanding } from '#lib/approval/chip.js';

	type Block =
		| { type: 'view'; view: PartView }
		| { type: 'files'; views: Extract<PartView, { kind: 'file' }>[] }
		| { type: 'sources'; views: Extract<PartView, { kind: 'source' }>[] }
		| { type: 'tools'; views: ToolView[] };

	let {
		message,
		agent,
		showHeader = true,
		standing,
		onFocusDock,
		onOpenSession,
		scratch = false,
		live = true,
		instruction = false
	}: {
		message: UIMessage;
		/** Author of an assistant message (multi-agent header). `id` seeds the avatar. */
		agent?: { id: string; name: string; color?: string };
		/** Show the avatar + name line; the chat hides it for follow-up messages of the same author. */
		showHeader?: boolean;
		/** Where an approval stands (waiting in the dock, answered here or elsewhere); drives the status chip of a tool row. */
		standing?: (approvalId: string) => ApprovalStanding;
		/** "Waiting for your approval" was clicked: bring the dock's card into view. */
		onFocusDock?: (approvalId: string) => void;
		onOpenSession?: (sessionId: string) => void;
		/** The message is from a test run: its files live in a scratch area, not in the library. */
		scratch?: boolean;
		/** Something may still stream into this message; false for settled history. */
		live?: boolean;
		/** Old-history fallback: this is the first message of a task session, so it is the system's prompt. A server flag (`metadata.app.instruction`) decides on its own. */
		instruction?: boolean;
	} = $props();

	const views = $derived(viewModel(message, live));
	// Fences of the message: a mermaid / svg / html block finds its index here and opens in the panel by it.
	setMessageEnv({
		get messageId() {
			return message.id;
		},
		fences: () => scanFences(messageText(message))
	});
	const hasArtifactCard = $derived(views.some((v) => v.kind === 'artifact'));
	const kind = $derived(messageKind(message));
	const isInstruction = $derived(isInstructionMessage(message, instruction));

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
	const stopped = $derived(!live && wasStopped(message));

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
		{#if message.role === 'user' && isInstruction}<InstructionCard text={v.text} />{:else if message.role === 'user'}<UserText text={v.text} />{:else}<TextPart text={v.text} />{/if}
	{:else if v.kind === 'reasoning'}
		<ReasoningPart text={v.text} streaming={v.streaming} durationMs={v.durationMs} />
	{:else if v.kind === 'tool'}
		{#if v.isSubagent}
			<SubagentPart view={v} {onOpenSession} />
		{:else if v.toolName === 'artifact_create'}
			<ArtifactToolPart view={v} hasCard={hasArtifactCard} {standing} {onFocusDock} />
		{:else if v.toolName === 'run_python'}
			<RunPythonPart view={v} {standing} {onFocusDock} />
		{:else}
			<ToolPart view={v} {standing} {onFocusDock} />
		{/if}
	{:else if v.kind === 'artifact'}
		<ArtifactChatCard id={v.id} kind={v.artifactKind} title={v.title} version={v.version} />
	{:else if v.kind === 'subagentRun'}
		<SubagentPart view={v} {onOpenSession} />
	{:else if v.kind === 'input'}
		<InputPart view={v} />
	{/if}
{/snippet}

{#if kind === 'eh.event' || kind === 'eh.compaction' || kind === 'eh.notice'}
	<!-- Kind messages are divider rows, not bubbles. -->
	{#each views as v (v.key)}
		{#if v.kind === 'event'}<EventPart name={v.name} text={v.text} />{:else if v.kind === 'compaction'}<CompactionPart summary={v.summary} tokens={v.tokens} trigger={v.trigger} />{:else if v.kind === 'notice'}<NoticePart level={v.level} text={v.text} code={v.code} />{/if}
	{/each}
{:else if visible}
	<Message from={message.role === 'user' ? 'user' : 'assistant'}>
		{#if message.role !== 'user' && agent && showHeader}
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
					{#if b.views.length === 1}<ToolPart view={b.views[0]} {standing} {onFocusDock} />{:else}<ToolGroup views={b.views} {standing} {onFocusDock} />{/if}
					{#each fileCards.get(i) ?? [] as f (f.path)}<FileCard file={f} {scratch} />{/each}
				{:else}
					{@render part(b.view)}
				{/if}
			{/each}
			{#if stopped}<div class="text-xs text-muted-foreground">Stopped before it finished</div>{/if}
		</MessageContent>
	</Message>
{/if}
