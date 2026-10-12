<script lang="ts">
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { approvalOutcome, messageMarks, messageSender, type LogMessage } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// The stored messages of one conversation, oldest first. The agent writes markdown; what people
	// wrote stays as typed. The log is decrypted on the server for whoever holds the web token.
	let { items }: { items: LogMessage[] } = $props();
</script>

<ol class="flex flex-col gap-2" data-testid="log-list">
	{#each items as m (m.id)}
		<li class="flex flex-col gap-1 rounded-lg border border-border p-3 {m.self ? 'bg-muted/40' : ''}" data-testid="log-message">
			<div class="flex min-w-0 flex-wrap items-center gap-2 text-xs">
				<span class="truncate font-medium">{messageSender(m)}</span>
				{#each messageMarks(m) as mark (mark)}<Badge variant={mark === 'Deleted' ? 'destructive' : mark === 'Woke the agent' ? 'success' : 'secondary'}>{mark}</Badge>{/each}
				<span class="ml-auto shrink-0 text-muted-foreground">{formatTime(m.at)}</span>
			</div>
			{#if m.replyTo}<p class="border-l-2 border-border pl-2 text-xs text-muted-foreground">In reply to {m.replyTo.senderName ?? 'a message'}{m.replyTo.text ? `: ${m.replyTo.text}` : ''}</p>{/if}
			{#if m.self && m.text && !m.deletedAt}
				<div class="text-sm break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap"><MessageResponse content={m.text} class="text-sm" /></div>
			{:else}
				<p class="text-sm break-words whitespace-pre-wrap {m.deletedAt ? 'text-muted-foreground line-through' : ''}">{m.text || (m.attachments.length ? '' : '(no text)')}</p>
			{/if}
			{#if m.attachments.length > 0}<p class="text-xs text-muted-foreground">{m.attachments.length} attachment{m.attachments.length === 1 ? '' : 's'}: {m.attachments.map((a) => a.name ?? a.mediaType ?? 'file').join(', ')}</p>{/if}
			{#if m.approval}<p class="text-xs text-muted-foreground" data-testid="approval-outcome">{m.approval.toolName}: {approvalOutcome(m.approval)}</p>{/if}
			{#if m.edits && m.edits.length > 0}
				<div class="text-xs text-muted-foreground">
					<p class="font-medium">Earlier versions ({m.edits.length})</p>
					<ul class="mt-1 flex flex-col gap-1">{#each m.edits as edit (edit.at)}<li class="break-words whitespace-pre-wrap">{formatTime(edit.at)}: {edit.text}</li>{/each}</ul>
				</div>
			{/if}
		</li>
	{/each}
</ol>
