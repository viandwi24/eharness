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

	let { onSend }: { onSend: (message: PromptInputMessage) => void | Promise<void> } = $props();
</script>

<!-- Composer with attachments (PromptInput + Attachments). Sending is wired in a later milestone. -->
<PromptInput onSubmit={onSend} multiple globalDrop={false}>
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
			<PromptInputTextarea placeholder="Message the agent" />
		</PromptInputBody>
		<PromptInputFooter>
			<PromptInputTools>
				<PromptInputButton aria-label="Attach files" onclick={openFileDialog}>
					<PaperclipIcon class="size-4" />
				</PromptInputButton>
			</PromptInputTools>
			<PromptInputSubmit />
		</PromptInputFooter>
	{/snippet}
</PromptInput>
