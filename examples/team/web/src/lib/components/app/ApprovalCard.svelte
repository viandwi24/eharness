<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { toast } from 'svelte-sonner';
	import type { Approval } from '#lib/api/client.js';
	import { answerFailureText } from '#lib/approval/outcome.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { friendlyTitle, summarizeApproval } from '#lib/approval/summary.js';
	import ApprovalActions from './ApprovalActions.svelte';
	import { live } from '#lib/stores/live.svelte.js';

	let {
		approval,
		onOpenTask,
		onAnswered
	}: { approval: Approval; onOpenTask?: (taskId: string) => void; onAnswered?: () => void } = $props();

	let busy = $state(false);
	const summary = $derived(summarizeApproval(approval.toolName, approval.input));
	// The parameters always show in their own (darker) box, even when the title repeats one of them.
	const rows = $derived(summary.rows);
	const riskVariant = { read: 'success', write: 'warning', external: 'destructive', unknown: 'outline' } as const;

	async function run(body: Parameters<typeof live.answer>[1]): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await live.answer(approval, body);
			onAnswered?.();
		} catch (e) {
			const text = answerFailureText(e);
			if (text) toast.error(text);
		} finally {
			busy = false;
		}
	}
</script>

<Surface class="flex max-h-[min(45vh,28rem)] flex-col gap-2 p-3 text-sm" data-testid="approval-card" role="group" aria-label="Approval request" tabindex={-1}>
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-medium">{approval.agentName}</span>
		<span class="text-xs text-muted-foreground">wants to</span>
		{#if approval.kind === 'approval' && approval.risk}<Badge variant={riskVariant[approval.risk as keyof typeof riskVariant]}>{approval.risk}</Badge>{/if}
		{#if approval.taskId && onOpenTask}
			<button class="ml-auto text-xs text-info-text underline underline-offset-4" onclick={() => onOpenTask(approval.taskId!)}>Open task</button>
		{/if}
	</div>

	{#if approval.kind === 'approval'}
		<div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto" data-testid="card-body">
			<p class="font-medium break-words" data-testid="approval-title">{friendlyTitle(approval.toolName, approval.input, false)}</p>
			{#if rows.length}
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-muted p-2 text-[12.5px]">
					{#each rows as row (row.label)}
						<dt class="text-muted-foreground">{row.label}</dt>
						<dd class={['min-w-0 break-words whitespace-pre-wrap', row.mono && 'font-mono text-[11.5px]']}>{row.value}</dd>
					{/each}
				</dl>
			{/if}
			{#if summary.raw}
				<details class="text-xs text-muted-foreground">
					<summary class="cursor-pointer select-none">Details</summary>
					<pre class="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11.5px] whitespace-pre-wrap">{summary.raw}</pre>
				</details>
			{/if}
		</div>
		<div class="shrink-0">
			{#key approval.sessionId + approval.id}
				<ApprovalActions toolName={approval.toolName} {busy} onAnswer={(body) => void run(body)} />
			{/key}
		</div>
	{/if}
</Surface>
