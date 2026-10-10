<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiError, type Approval } from '#lib/api/client.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { live } from '#lib/stores/live.svelte.js';

	let {
		approval,
		onOpenTask,
		onAnswered
	}: { approval: Approval; onOpenTask?: (taskId: string) => void; onAnswered?: () => void } = $props();

	let reason = $state('');
	let note = $state('');
	let busy = $state(false);
	const preview = $derived.by(() => {
		if (approval.input === undefined || approval.input === null) return '';
		try {
			const s = typeof approval.input === 'string' ? approval.input : JSON.stringify(approval.input, null, 2);
			return s.length > 600 ? `${s.slice(0, 600)}…` : s;
		} catch {
			return '';
		}
	});
	const riskVariant = { read: 'success', write: 'warning', external: 'destructive', unknown: 'outline' } as const;

	async function run(body: Parameters<typeof live.answer>[1]): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await live.answer(approval, body);
			onAnswered?.();
		} catch (e) {
			toast.error(e instanceof ApiError && (e.status === 404 || e.status === 409) ? 'Already answered or no longer pending' : e instanceof Error ? e.message : 'Could not send the answer');
		} finally {
			busy = false;
		}
	}
	const decide = (approved: boolean): Promise<void> =>
		run({ approved, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
</script>

<div class="flex max-h-[min(45vh,28rem)] flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm" data-testid="approval-card">
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-medium">{approval.agentName}</span>
		<span class="font-mono text-xs text-muted-foreground">{approval.toolName}</span>
		{#if approval.kind === 'approval' && approval.risk}<Badge variant={riskVariant[approval.risk as keyof typeof riskVariant]}>{approval.risk}</Badge>{/if}
		{#if approval.taskId && onOpenTask}
			<button class="ml-auto text-xs text-info-text underline underline-offset-4" onclick={() => onOpenTask(approval.taskId!)}>Open task</button>
		{/if}
	</div>

	{#if approval.kind === 'approval'}
		<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" data-testid="card-body">
		{#if preview}<pre class="rounded-md bg-muted p-2 font-mono text-[11.5px] whitespace-pre-wrap">{preview}</pre>{/if}
		<Input bind:value={reason} placeholder="Reason (shown to the model if rejected)" aria-label="Reason" class="h-8" />
		<Input bind:value={note} placeholder="Note for the model (optional)" aria-label="Note" class="h-8" />
		</div>
		<div class="flex shrink-0 justify-end gap-2">
			<Button variant="outline" size="sm" disabled={busy} onclick={() => decide(false)}>Reject</Button>
			<Button size="sm" disabled={busy} onclick={() => decide(true)}>Approve</Button>
		</div>
	{/if}
</div>
