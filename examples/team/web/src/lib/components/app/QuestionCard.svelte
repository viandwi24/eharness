<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { ApiError, type Approval } from '#lib/api/client.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { live } from '#lib/stores/live.svelte.js';
	import * as Q from '#lib/questions/state.js';

	let {
		approval,
		onOpenTask,
		onAnswered
	}: { approval: Approval; onOpenTask?: (taskId: string) => void; onAnswered?: () => void } = $props();

	const questions = $derived((approval.questions ?? []) as Q.QuestionDef[]);
	// Re-initialised only when the question set itself changes.
	let qs = $state<Q.QState>(Q.initState([]));
	let key = '';
	$effect(() => {
		const k = JSON.stringify(questions);
		if (k !== key) {
			key = k;
			qs = Q.initState(questions);
		}
	});
	let busy = $state(false);
	let showNotes = $state<Record<number, boolean>>({});
	let warn = $state(false);
	let root: HTMLElement | undefined = $state();

	const review = $derived(Q.isReview(qs));
	const q = $derived(qs.questions[qs.step]);
	const uid = $derived(`q${approval.id}`);

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
	const dismiss = (): Promise<void> => run({ answers: null });
	function submit(): void {
		if (!Q.canSubmit(qs)) {
			warn = true;
			const first = Q.missing(qs)[0];
			if (first !== undefined) qs = Q.goTo({ ...qs, step: 0 }, first);
			return;
		}
		void run(Q.toAnswers(qs));
	}
	function goNext(): void {
		if (Q.canNext(qs)) {
			warn = false;
			qs = Q.next(qs);
		} else warn = true;
	}
	function goBack(): void {
		warn = false;
		qs = Q.back(qs);
	}
	function enter(): void {
		if (review || questions.length <= 1) submit();
		else goNext();
	}

	function onkeydown(e: KeyboardEvent): void {
		if (busy || e.altKey || e.ctrlKey || e.metaKey) return;
		const t = e.target as HTMLElement;
		const typing = t instanceof HTMLInputElement && t.type === 'text';
		if (e.key === 'Escape') {
			e.preventDefault();
			void dismiss();
		} else if (e.key === 'Enter') {
			if (t instanceof HTMLButtonElement) return; // let the focused button act
			e.preventDefault();
			enter();
		} else if (!typing && e.key === 'ArrowRight') {
			e.preventDefault();
			if (review) return;
			goNext();
		} else if (!typing && e.key === 'ArrowLeft') {
			e.preventDefault();
			goBack();
		} else if (!typing && !review && /^[1-9]$/.test(e.key)) {
			e.preventDefault();
			qs = Q.pick(qs, Number(e.key) - 1);
			warn = false;
		}
	}
	// Move focus to the card when the step changes so keys keep working. Depend on the step NUMBER
	// only: `qs` is replaced on every keystroke (Other / Note inputs), and reading `qs.step` here
	// would re-run this effect and steal focus from the input after each character.
	const step = $derived(qs.step);
	$effect(() => {
		void step;
		root?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
	bind:this={root}
	class="flex max-h-[min(45vh,28rem)] flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm"
	data-testid="question-card"
	aria-label="Question from {approval.agentName}"
	{onkeydown}
>
	<div class="flex shrink-0 flex-wrap items-center gap-2">
		<span class="font-medium">{approval.agentName}</span>
		<Badge variant="info">question</Badge>
		<span class="text-xs text-muted-foreground" aria-live="polite">
			{review ? `Review · ${questions.length} answers` : `Question ${qs.step + 1} of ${questions.length}`}
		</span>
		{#if approval.taskId && onOpenTask}
			<button class="ml-auto text-xs text-info-text underline underline-offset-4" onclick={() => onOpenTask(approval.taskId!)}>Open task</button>
		{/if}
	</div>

	{#if questions.length > 1}
		<div class="flex shrink-0 flex-wrap gap-1" role="tablist" aria-label="Questions">
			{#each questions as item, i (i)}
				<button
					type="button"
					role="tab"
					aria-selected={qs.step === i}
					class="rounded-md border px-2 py-0.5 text-xs {qs.step === i ? 'border-primary bg-primary/10 font-medium' : 'border-border text-muted-foreground'}"
					onclick={() => (qs = Q.goTo(qs, i))}
				>
					{Q.isAnswered(qs, i) ? '✓ ' : ''}{item.header || `Q${i + 1}`}
				</button>
			{/each}
			<button
				type="button"
				role="tab"
				aria-selected={review}
				class="rounded-md border px-2 py-0.5 text-xs {review ? 'border-primary bg-primary/10 font-medium' : 'border-border text-muted-foreground'}"
				onclick={() => (qs = Q.goTo(qs, questions.length))}
			>
				Review
			</button>
		</div>
	{/if}

	<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" data-testid="card-body">
	{#if !review && q}
		<fieldset class="flex flex-col gap-1.5" disabled={busy}>
			<legend class="mb-1 text-[13px] font-medium">{q.header && questions.length === 1 ? `${q.header}: ` : ''}{q.question}</legend>
			{#each q.options as o, n (o.label)}
				<label class="flex cursor-pointer items-start gap-2 text-[13px]">
					<input
						type={q.multiSelect ? 'checkbox' : 'radio'}
						name="{uid}-{qs.step}"
						class="mt-1"
						data-autofocus={n === 0 ? '' : undefined}
						checked={qs.picked[qs.step]?.includes(n)}
						onchange={() => ((qs = Q.pick(qs, n)), (warn = false))}
					/>
					<span>
						<span class="mr-1 font-mono text-xs text-muted-foreground">{n < 9 ? n + 1 : ''}</span>{o.label}
						{#if o.description}<span class="block text-xs text-muted-foreground">{o.description}</span>{/if}
					</span>
				</label>
			{/each}
			<Input
				value={qs.other[qs.step] ?? ''}
				oninput={(e: Event) => (qs = Q.setOther(qs, (e.currentTarget as HTMLInputElement).value))}
				placeholder="Other…"
				aria-label="Other answer"
				class="h-8"
			/>
			{#if showNotes[qs.step] || qs.notes[qs.step]}
				<Input
					value={qs.notes[qs.step] ?? ''}
					oninput={(e: Event) => (qs = Q.setNotes(qs, (e.currentTarget as HTMLInputElement).value))}
					placeholder="Note for the model (optional)"
					aria-label="Note"
					class="h-8"
				/>
			{:else}
				<button type="button" class="self-start text-xs text-muted-foreground underline underline-offset-4" onclick={() => (showNotes[qs.step] = true)}>Add a note</button>
			{/if}
			<span class="text-[11px] text-muted-foreground">{q.multiSelect ? 'Pick any, or none.' : 'Pick one or write your own to continue.'}</span>
		</fieldset>
	{:else}
		<ol class="flex flex-col gap-1.5" aria-label="Your answers">
			{#each questions as item, i (i)}
				<li class="text-[13px]">
					<button type="button" class="text-left" onclick={() => (qs = Q.goTo({ ...qs, step: 0 }, i))}>
						<span class="text-muted-foreground">{item.header || `Q${i + 1}`}: {item.question}</span>
						<span class="block font-medium {Q.isAnswered(qs, i) ? '' : 'text-muted-foreground italic'}">{Q.answerText(qs, i) || (Q.isRequired(qs, i) ? 'Not answered' : 'No answer')}</span>
					</button>
					{#if qs.notes[i]?.trim()}<span class="block text-xs text-muted-foreground">Note: {qs.notes[i]}</span>{/if}
				</li>
			{/each}
		</ol>
	{/if}

	{#if warn}<p class="text-xs text-destructive-text" role="alert">{review || !q ? 'Answer every required question first.' : 'Choose an option or write an answer to continue.'}</p>{/if}

	</div>

	<div class="flex shrink-0 items-center justify-end gap-2">
		<Button variant="ghost" size="sm" disabled={busy} onclick={dismiss}>Dismiss</Button>
		<Button variant="outline" size="sm" disabled={busy || qs.step === 0} onclick={goBack}>Back</Button>
		{#if review || questions.length <= 1}
			<Button size="sm" disabled={busy} onclick={submit} data-autofocus>Submit</Button>
		{:else}
			<Button size="sm" disabled={busy} onclick={goNext}>{Q.isLast(qs) ? 'Review' : 'Next'}</Button>
		{/if}
	</div>
</section>
