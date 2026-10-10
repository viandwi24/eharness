<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiError, type Approval } from '#lib/api/client.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { live } from '#lib/stores/live.svelte.js';

	let { approval, onOpenTask }: { approval: Approval; onOpenTask?: (taskId: string) => void } = $props();

	let reason = $state('');
	let note = $state('');
	let busy = $state(false);
	// Question state: one entry per question.
	type Ans = { selected: string[]; other: string };
	let answers = $state<Ans[]>([]);
	$effect(() => {
		if (approval.kind === 'question' && answers.length !== (approval.questions?.length ?? 0)) {
			answers = (approval.questions ?? []).map(() => ({ selected: [], other: '' }));
		}
	});

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
		} catch (e) {
			toast.error(e instanceof ApiError && (e.status === 404 || e.status === 409) ? 'Already answered or no longer pending' : e instanceof Error ? e.message : 'Could not send the answer');
		} finally {
			busy = false;
		}
	}
	const decide = (approved: boolean): Promise<void> =>
		run({ approved, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
	const submitAnswers = (): Promise<void> =>
		run({
			answers: answers.map((a) => ({
				...(a.selected.length ? { selected: a.selected } : {}),
				...(a.other.trim() ? { other: a.other.trim() } : {})
			}))
		});
	function toggle(i: number, label: string, multi: boolean): void {
		const a = answers[i];
		if (!a) return;
		if (multi) a.selected = a.selected.includes(label) ? a.selected.filter((x) => x !== label) : [...a.selected, label];
		else a.selected = [label];
	}
</script>

<div class="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm" data-testid="approval-card">
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-medium">{approval.agentName}</span>
		<span class="font-mono text-xs text-muted-foreground">{approval.toolName}</span>
		{#if approval.kind === 'approval' && approval.risk}<Badge variant={riskVariant[approval.risk as keyof typeof riskVariant]}>{approval.risk}</Badge>{/if}
		{#if approval.kind === 'question'}<Badge variant="info">question</Badge>{/if}
		{#if approval.taskId && onOpenTask}
			<button class="ml-auto text-xs text-info-text underline underline-offset-4" onclick={() => onOpenTask(approval.taskId!)}>Open task</button>
		{/if}
	</div>

	{#if approval.kind === 'approval'}
		{#if preview}<pre class="max-h-32 overflow-auto rounded-md bg-muted p-2 font-mono text-[11.5px] whitespace-pre-wrap">{preview}</pre>{/if}
		<Input bind:value={reason} placeholder="Reason (shown to the model if rejected)" aria-label="Reason" class="h-8" />
		<Input bind:value={note} placeholder="Note for the model (optional)" aria-label="Note" class="h-8" />
		<div class="flex justify-end gap-2">
			<Button variant="outline" size="sm" disabled={busy} onclick={() => decide(false)}>Reject</Button>
			<Button size="sm" disabled={busy} onclick={() => decide(true)}>Approve</Button>
		</div>
	{:else}
		{#each approval.questions ?? [] as q, i (i)}
			<fieldset class="flex flex-col gap-1.5">
				<legend class="mb-1 text-[13px] font-medium">{q.header ? `${q.header}: ` : ''}{q.question}</legend>
				{#each q.options as o (o.label)}
					<label class="flex cursor-pointer items-start gap-2 text-[13px]">
						<input
							type={q.multiSelect ? 'checkbox' : 'radio'}
							name="q{approval.id}-{i}"
							class="mt-1"
							checked={answers[i]?.selected.includes(o.label)}
							onchange={() => toggle(i, o.label, q.multiSelect)}
						/>
						<span>{o.label}{#if o.description}<span class="block text-xs text-muted-foreground">{o.description}</span>{/if}</span>
					</label>
				{/each}
				{#if answers[i]}<Input bind:value={answers[i].other} placeholder="Other" aria-label="Other answer" class="h-8" />{/if}
			</fieldset>
		{/each}
		<div class="flex justify-end gap-2">
			<Button variant="outline" size="sm" disabled={busy} onclick={() => run({ answers: null })}>Dismiss</Button>
			<Button size="sm" disabled={busy} onclick={submitAnswers}>Send answer</Button>
		</div>
	{/if}
</div>
