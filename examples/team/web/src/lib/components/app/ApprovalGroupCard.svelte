<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { toast } from 'svelte-sonner';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import type { Approval } from '#lib/api/client.js';
	import { answerFailureText } from '#lib/approval/outcome.js';
	import { friendlyTitle, readableInput, summarizeApproval } from '#lib/approval/summary.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { ALLOW_SCOPES, DEFAULT_ALLOW_SCOPE, type AllowScope } from '#lib/approval/answer.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { cn } from '#lib/utils.js';
	import { live } from '#lib/stores/live.svelte.js';

	/**
	 * Parallel approvals of the same tool as ONE card: each call can be approved or denied on its own,
	 * or all together. "Always allow" grants the tool once (for the rest of the session) and approves the others.
	 */
	let {
		items,
		toolName,
		onOpenTask,
		onAnswered
	}: { items: Approval[]; toolName: string; onOpenTask?: (taskId: string) => void; onAnswered?: () => void } = $props();

	let busy = $state(false);
	let scope = $state<AllowScope>(DEFAULT_ALLOW_SCOPE);
	let open = $state<Record<string, boolean>>({});
	const agentName = $derived(items[0]?.agentName ?? '');
	const taskId = $derived(items[0]?.taskId ?? null);

	async function answerAll(make: (index: number) => Parameters<typeof live.answer>[1]): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			// One after the other: the turn continues only when the last of the batch is answered.
			for (const [i, a] of [...items].entries()) await live.answer(a, make(i));
			onAnswered?.();
		} catch (e) {
			const text = answerFailureText(e);
			if (text) toast.error(text);
		} finally {
			busy = false;
		}
	}
	async function answerOne(a: Approval, approved: boolean): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await live.answer(a, { approved });
			onAnswered?.();
		} catch (e) {
			const text = answerFailureText(e);
			if (text) toast.error(text);
		} finally {
			busy = false;
		}
	}
	const approveAll = (): Promise<void> => answerAll(() => ({ approved: true }));
	const alwaysAllow = (): Promise<void> => answerAll((i) => (i === 0 ? { approved: true, remember: 'session', scope } : { approved: true }));
	const denyAll = (): Promise<void> => answerAll(() => ({ approved: false }));

	// Scoped to the dock card (focus inside it): 1 Approve all, 2 Always allow, 3 Deny all.
	function onkeydown(e: KeyboardEvent): void {
		if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.target instanceof HTMLButtonElement && e.key === 'Enter') return;
		const act = { '1': approveAll, '2': alwaysAllow, '3': denyAll }[e.key];
		if (act) {
			e.preventDefault();
			void act();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<Surface
	class="flex max-h-[min(50vh,30rem)] flex-col gap-2 p-3 text-sm"
	data-testid="approval-group"
	role="group"
	aria-label="{items.length} pending approvals: {toolName}"
	tabindex={-1}
	{onkeydown}
>
	<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
		<span class="font-medium">{agentName}</span>
		<span class="text-xs text-muted-foreground" data-testid="group-count">{items.length} pending: {toolName}</span>
		{#if taskId && onOpenTask}
			<button class="ml-auto text-xs text-info-text underline underline-offset-4" onclick={() => onOpenTask(taskId)}>Open task</button>
		{/if}
	</div>

	<ul class="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto rounded-md bg-muted" data-testid="group-items">
		{#each items as a (a.id)}
			{@const raw = summarizeApproval(a.toolName, a.input).raw}
			<li class="flex flex-col gap-1 px-2 py-1.5" data-testid="group-item">
				<div class="flex items-start gap-2">
					<div class="min-w-0 flex-1">
						<p class="text-[13px] break-words">{friendlyTitle(a.toolName, a.input, false)}</p>
						{#if readableInput(a.toolName, a.input)}
							<p class="text-xs text-muted-foreground break-words" data-testid="group-item-summary">{readableInput(a.toolName, a.input)}</p>
						{/if}
					</div>
					<div class="flex shrink-0 items-center gap-1">
						<Button size="xs" disabled={busy} onclick={() => void answerOne(a, true)}>Approve</Button>
						<Button size="xs" variant="outline" disabled={busy} onclick={() => void answerOne(a, false)}>Deny</Button>
					</div>
				</div>
				{#if raw}
					<button
						type="button"
						class="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						aria-expanded={open[a.id] === true}
						onclick={() => (open[a.id] = !open[a.id])}
					>
						<CaretRightIcon class={cn('size-3 transition-transform', open[a.id] && 'rotate-90')} /> Details
					</button>
					{#if open[a.id]}
						<pre class="max-h-40 overflow-auto rounded-md bg-card p-2 font-mono text-[11.5px] whitespace-pre-wrap">{raw}</pre>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>

	<div class="flex shrink-0 flex-wrap items-center gap-2" data-testid="group-actions">
		<Button size="sm" disabled={busy} onclick={() => void approveAll()}>
			Approve all ({items.length}) <Kbd class="ml-1 h-4 min-w-4 text-[10px]">1</Kbd>
		</Button>
		<Button variant="outline" size="sm" disabled={busy} title="Allow this tool without asking (scope picked next to it); the {items.length} waiting are approved" onclick={() => void alwaysAllow()}>
			Always allow <span class="max-w-32 truncate">{toolName}</span> <Kbd class="ml-1 h-4 min-w-4 text-[10px]">2</Kbd>
		</Button>
		<NativeSelect bind:value={scope} size="sm" aria-label="Always allow for" title="How far Always allow reaches" disabled={busy}>
			{#each ALLOW_SCOPES as s (s.value)}<NativeSelectOption value={s.value}>{s.label}</NativeSelectOption>{/each}
		</NativeSelect>
		<Button variant="outline" size="sm" disabled={busy} onclick={() => void denyAll()}>
			Deny all <Kbd class="ml-1 h-4 min-w-4 text-[10px]">3</Kbd>
		</Button>
	</div>
</Surface>
