<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { buildAnswer, type ApprovalAnswerBody, type ApprovalChoice } from '#lib/approval/answer.js';

	let {
		toolName,
		canRemember = true,
		canNote = true,
		busy = false,
		onAnswer
	}: {
		toolName: string;
		/** The answer path can carry `remember: 'session'` (POST /approvals). */
		canRemember?: boolean;
		/** The answer path can carry a `note` for an approval. */
		canNote?: boolean;
		busy?: boolean;
		onAnswer: (body: ApprovalAnswerBody) => void;
	} = $props();

	// Approve / Always allow / Deny answer at once. "Add note" opens one text field whose text goes
	// with the button picked next: a note for the agent on Approve, the reason on Deny.
	let noting = $state(false);
	let text = $state('');
	let field = $state<HTMLTextAreaElement | HTMLInputElement | null>(null);

	function openNote(): void {
		noting = true;
		text = '';
		void Promise.resolve().then(() => field?.focus());
	}
	function cancel(): void {
		noting = false;
		text = '';
	}
	function send(choice: ApprovalChoice): void {
		if (busy) return;
		onAnswer(buildAnswer(choice, noting ? text : ''));
	}

	// Scoped to the card (focus inside it): 1 Approve, 2 Always allow, 3 Deny, 4 Add note, Esc cancels the note.
	function onkeydown(e: KeyboardEvent): void {
		if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
		const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
		if (noting) {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				cancel();
			} else if (typing && e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				send('approve');
			}
			return;
		}
		if (typing || (e.target instanceof HTMLButtonElement && e.key === 'Enter')) return;
		const map: Record<string, () => void> = {
			'1': () => send('approve'),
			'2': () => canRemember && send('remember'),
			'3': () => send('deny'),
			'4': () => canNote && openNote(),
		};
		const act = map[e.key];
		if (act) {
			e.preventDefault();
			act();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="flex flex-col gap-2" role="group" aria-label="Answer" data-testid="approval-actions" {onkeydown}>
	{#if noting}
		<Input
			bind:ref={field}
			bind:value={text}
			class="h-8"
			aria-label="Note for the agent"
			placeholder="Note for the agent: sent with Approve, or as the reason with Deny"
		/>
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		<Button size="sm" disabled={busy} onclick={() => send('approve')}>
			Approve {#if !noting}<Kbd class="ml-1 h-4 min-w-4 text-[10px]">1</Kbd>{/if}
		</Button>
		{#if canRemember && !noting}
			<Button
				variant="outline"
				size="sm"
				disabled={busy}
				title="Allow this tool without asking for the rest of this session"
				onclick={() => send('remember')}
			>
				Always allow <span class="max-w-32 truncate font-mono text-[11.5px]">{toolName}</span>
				<Kbd class="ml-1 h-4 min-w-4 text-[10px]">2</Kbd>
			</Button>
		{/if}
		<Button variant={noting ? 'destructive' : 'outline'} size="sm" disabled={busy} onclick={() => send('deny')}>
			Deny {#if !noting}<Kbd class="ml-1 h-4 min-w-4 text-[10px]">3</Kbd>{/if}
		</Button>
		{#if noting}
			<Button variant="ghost" size="sm" disabled={busy} onclick={cancel}>Cancel <Kbd class="ml-1 h-4 min-w-4 text-[10px]">Esc</Kbd></Button>
		{:else if canNote}
			<Button variant="ghost" size="sm" disabled={busy} class="ml-auto text-muted-foreground" onclick={openNote}>
				Add note <Kbd class="ml-1 h-4 min-w-4 text-[10px]">4</Kbd>
			</Button>
		{/if}
	</div>
</div>
