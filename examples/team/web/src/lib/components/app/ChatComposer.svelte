<script lang="ts" module>
	// Unsent text survives a remount of the composer (the chat route re-resolves its thread right after
	// opening an agent): keyed by agent and thread-less so it follows the person, cleared on send.
	const drafts = new Map<string, string>();
</script>

<script lang="ts">
	import PaperclipIcon from 'phosphor-svelte/lib/Paperclip';
	import {
		Attachment,
		AttachmentInfo,
		AttachmentPreview,
		AttachmentRemove,
		Attachments
	} from '#lib/components/ai/attachments/index.js';
	import {
		PromptInput,
		PromptInputBody,
		PromptInputButton,
		PromptInputFooter,
		PromptInputHeader,
		PromptInputSubmit,
		PromptInputTextarea,
		PromptInputTools,
		type PromptInputMessage
	} from '#lib/components/ai/prompt-input/index.js';

	import type { ChatStatus } from 'ai';
	import { toast } from 'svelte-sonner';
	import { UPLOAD_ACCEPT, UPLOAD_MAX_BYTES } from '#lib/chat/constants.js';
	import ChatToolsMenu from './ChatToolsMenu.svelte';
	import ContextMeter from './ContextMeter.svelte';
	import ModeSwitch from './ModeSwitch.svelte';
	import type { DeclineHint } from '#lib/approval/hint.js';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import { cn } from '#lib/utils.js';

	let {
		onSend,
		onStop,
		status,
		stopping = false,
		placeholder = 'Message the agent',
		agentId,
		threadId,
		decline
	}: {
		onSend: (message: PromptInputMessage) => void | Promise<void>;
		onStop?: () => void;
		status?: ChatStatus;
		/** A stop was sent and is not confirmed yet: the stop button waits. */
		stopping?: boolean;
		placeholder?: string;
		/** The agent of this DM chat: shows its permission mode switch (Shift+Tab cycles it). */
		agentId?: string;
		/** The chat thread: its own mode, connectors and context meter. */
		threadId?: string;
		/** Own approvals a new message would decline (shown while text is typed). */
		decline?: DeclineHint;
	} = $props();

	const draftKey = $derived(agentId ?? '');
	// svelte-ignore state_referenced_locally
	const initial = drafts.get(draftKey) ?? '';
	async function send(m: PromptInputMessage): Promise<void> {
		await onSend(m); // a throw keeps the text in the box and the draft
		drafts.delete(draftKey);
	}

	let declineOpen = $state(false);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	/** Put the cursor in the message box. */
	export function focus(): void {
		textarea?.focus({ preventScroll: true });
	}

	let modeSwitch = $state<ModeSwitch | undefined>();

	// Shift+Tab cycles Manual / Auto / Bypass instead of moving focus out of the composer.
	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Tab' && e.shiftKey && agentId && modeSwitch) {
			e.preventDefault();
			modeSwitch.cycle();
		}
	}
</script>

<!-- Composer: attachments are validated here (type, 10 MB) and uploaded by the owner on send. -->
<PromptInput
	onSubmit={send}
	initialInput={initial}
	onError={(e) => toast.error(e.message, { id: e.message.slice(0, 80) })}
	accept={UPLOAD_ACCEPT}
	maxFileSize={UPLOAD_MAX_BYTES}
	maxFiles={5}
	multiple
	globalDrop={false}
>
	{#snippet children({ files, remove, openFileDialog, textInput })}
		{#if files.length > 0}
			<PromptInputHeader>
				<Attachments variant="inline">
					{#each files as f (f.id)}
						<Attachment data={f} onRemove={() => remove(f.id)}>
							<AttachmentPreview />
							<AttachmentInfo />
							<AttachmentRemove />
						</Attachment>
					{/each}
				</Attachments>
			</PromptInputHeader>
		{/if}
		<PromptInputBody>
			<PromptInputTextarea bind:ref={textarea} {placeholder} onkeydown={onKeydown} oninput={(e: Event) => drafts.set(draftKey, (e.currentTarget as HTMLTextAreaElement).value)} class="min-h-12 px-3 pt-2.5 pb-1" />
		</PromptInputBody>
		{#if decline && textInput.trim()}
			<div class="px-3 pb-1 text-xs text-muted-foreground" data-testid="decline-hint" role="status">
				<button type="button" class="flex items-center gap-1 text-left hover:text-foreground" aria-expanded={declineOpen} onclick={() => (declineOpen = !declineOpen)}>
					<CaretRightIcon class={cn('size-3 shrink-0 transition-transform', declineOpen && 'rotate-90')} />
					<span>{decline.text}</span>
				</button>
				{#if declineOpen}
					<ul class="mt-1 ml-4 list-disc">
						{#each decline.names as n (n.toolName)}<li>{n.toolName}{n.count > 1 ? ` ×${n.count}` : ''}</li>{/each}
					</ul>
				{/if}
			</div>
		{/if}
		<PromptInputFooter class="px-1.5 pt-0.5 pb-1.5">
			<PromptInputTools>
				<PromptInputButton aria-label="Attach files" title="Attach files" onclick={openFileDialog}>
					<PaperclipIcon class="size-4" />
				</PromptInputButton>
				{#if agentId}<ChatToolsMenu {agentId} {threadId} />{/if}
				{#if agentId}<ModeSwitch bind:this={modeSwitch} {agentId} {threadId} />{/if}
			</PromptInputTools>
			<div class="flex items-center gap-1.5">
				{#if agentId}<ContextMeter {agentId} {threadId} />{/if}
				<PromptInputSubmit {status} {onStop} disabled={stopping} />
			</div>
		</PromptInputFooter>
	{/snippet}
</PromptInput>
