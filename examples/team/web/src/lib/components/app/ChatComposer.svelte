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

	let {
		onSend,
		onStop,
		status,
		placeholder = 'Message the agent'
	}: {
		onSend: (message: PromptInputMessage) => void | Promise<void>;
		onStop?: () => void;
		status?: ChatStatus;
		placeholder?: string;
	} = $props();
</script>

<!-- Composer: attachments are validated here (type, 10 MB) and uploaded by the owner on send. -->
<PromptInput
	onSubmit={onSend}
	onError={(e) => toast.error(e.message)}
	accept={UPLOAD_ACCEPT}
	maxFileSize={UPLOAD_MAX_BYTES}
	maxFiles={5}
	multiple
	globalDrop={false}
>
	{#snippet children({ files, remove, openFileDialog })}
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
			<PromptInputTextarea {placeholder} />
		</PromptInputBody>
		<PromptInputFooter>
			<PromptInputTools>
				<PromptInputButton aria-label="Attach files" onclick={openFileDialog}>
					<PaperclipIcon class="size-4" />
				</PromptInputButton>
			</PromptInputTools>
			<PromptInputSubmit {status} {onStop} />
		</PromptInputFooter>
	{/snippet}
</PromptInput>
