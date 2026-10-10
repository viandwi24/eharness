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

	// One text field at most: it is the denial guidance in `deny` mode, the note in `note` mode.
	let mode = $state<'choose' | 'deny' | 'note'>('choose');
	let text = $state('');
	let field = $state<HTMLInputElement | null>(null);

	function open(next: 'deny' | 'note'): void {
		mode = next;
		text = '';
		void Promise.resolve().then(() => field?.focus());
	}
	function close(): void {
		mode = 'choose';
		text = '';
	}
	function send(choice: ApprovalChoice): void {
		if (busy) return;
		onAnswer(buildAnswer(choice, mode === 'choose' ? '' : text));
	}

	// Scoped to the card (focus inside it): 1 Approve, 2 Always allow, 3 Deny, Enter approve, Esc deny with feedback.
	function onkeydown(e: KeyboardEvent): void {
		if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
		const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (mode === 'choose') open('deny');
			else close();
			return;
		}
		if (typing) {
			if (e.key === 'Enter') {
				e.preventDefault();
				send(mode === 'deny' ? 'deny' : 'approve');
			}
			return;
		}
		if (e.target instanceof HTMLButtonElement && e.key === 'Enter') return; // the focused button decides
		if (mode !== 'choose') return;
		if (e.key === 'Enter' || e.key === '1') {
			e.preventDefault();
			send('approve');
		} else if (e.key === '2' && canRemember) {
			e.preventDefault();
			send('remember');
		} else if (e.key === '3') {
			e.preventDefault();
			open('deny');
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="flex flex-col gap-2" role="group" aria-label="Answer" data-testid="approval-actions" {onkeydown}>
	{#if mode === 'choose'}
		<div class="flex flex-wrap items-center gap-2">
			<Button size="sm" disabled={busy} onclick={() => send('approve')}>Approve <Kbd class="ml-1 h-4 min-w-4 text-[10px]">1</Kbd></Button>
			{#if canRemember}
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
			{#if canNote}
				<Button variant="ghost" size="sm" disabled={busy} class="text-muted-foreground" onclick={() => open('note')}>Add note</Button>
			{/if}
			<Button variant="outline" size="sm" disabled={busy} class="ml-auto" onclick={() => open('deny')}>
				Deny <Kbd class="ml-1 h-4 min-w-4 text-[10px]">3</Kbd>
			</Button>
		</div>
	{:else}
		<Input
			bind:ref={field}
			bind:value={text}
			class="h-8"
			aria-label={mode === 'deny' ? 'Tell the agent what to do instead' : 'Note for the agent'}
			placeholder={mode === 'deny' ? 'Tell the agent what to do instead (optional)' : 'Add a note for the agent (optional)'}
		/>
		<div class="flex flex-wrap items-center gap-2">
			{#if mode === 'deny'}
				<Button variant="destructive" size="sm" disabled={busy} onclick={() => send('deny')}>Deny <Kbd class="ml-1 h-4 min-w-4 text-[10px]">Enter</Kbd></Button>
			{:else}
				<Button size="sm" disabled={busy} onclick={() => send('approve')}>Approve with note <Kbd class="ml-1 h-4 min-w-4 text-[10px]">Enter</Kbd></Button>
			{/if}
			<Button variant="ghost" size="sm" disabled={busy} onclick={close}>Back <Kbd class="ml-1 h-4 min-w-4 text-[10px]">Esc</Kbd></Button>
		</div>
	{/if}
</div>
