<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { heldText, loadPause, pauseStore, pauseWorkspace } from '#lib/stores/pause.svelte.js';

	/** "Pause all": what is held, with the live counts, and the three choices. */
	let { open = $bindable(false) }: { open: boolean } = $props();

	let holdChannels = $state(true);
	let answerHeldOnResume = $state(false);
	let stopRunning = $state(false);
	let note = $state('');

	// the counts are read when the dialog opens, never from an old copy
	$effect(() => {
		if (open) {
			holdChannels = true;
			answerHeldOnResume = false;
			stopRunning = false;
			note = '';
			pauseStore.error = null;
			void loadPause();
		}
	});

	const held = $derived(pauseStore.view?.held);

	async function pause(): Promise<void> {
		if (await pauseWorkspace({ note, holdChannels, answerHeldOnResume, stopRunning })) {
			open = false;
			toast.success('Everything automatic is paused');
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Pause everything automatic?</Dialog.Title>
			<Dialog.Description>
				Nothing changes status: Resume brings back exactly what is active now, and anything you paused one by one stays paused. Your own chats, "Run now" and approvals keep working. Backups and health checks keep running.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-4 text-sm">
			<div>
				<p class="mb-1 text-xs font-medium text-muted-foreground">Will be held</p>
				<p data-testid="pause-held">{held ? heldText(held) : 'Loading…'}</p>
				<p class="mt-1 text-xs text-muted-foreground">Their slots are skipped while paused, not replayed later. Queued tasks wait and start after Resume.</p>
			</div>
			<label class="flex items-start gap-2">
				<Checkbox class="mt-0.5" bind:checked={holdChannels} aria-label="Also stop answering chat channels" />
				<span>
					Also stop answering chat channels
					<span class="block text-xs text-muted-foreground">
						{#if holdChannels && answerHeldOnResume}
							Messages are still received and kept. After Resume, each conversation gets one answer to the ones that addressed the agent.
						{:else}
							Messages are still received and kept; they are not answered later.
						{/if}
					</span>
				</span>
			</label>
			{#if holdChannels}
				<label class="ml-6 flex items-start gap-2">
					<Checkbox class="mt-0.5" bind:checked={answerHeldOnResume} aria-label="Answer them after Resume" data-testid="pause-answer-held" />
					<span>
						Answer them after Resume
						<span class="block text-xs text-muted-foreground">Messages that addressed the agent, up to 12 hours old, are answered once per conversation, oldest first.</span>
					</span>
				</label>
			{/if}
			<label class="flex items-start gap-2">
				<Checkbox class="mt-0.5" bind:checked={stopRunning} aria-label="Stop work that is running now" />
				<span>
					Stop work that is running now
					<span class="block text-xs text-muted-foreground" data-testid="pause-running">
						{#if stopRunning}
							{held?.runningTurns ?? 0} running now will be stopped.
						{:else}
							Unchecked: work running now ({held?.runningTurns ?? 0}) finishes first.
						{/if}
					</span>
				</span>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium text-muted-foreground">Note (optional)</span>
				<Input bind:value={note} maxlength={500} placeholder="Deploying an update" aria-label="Note" />
			</label>
			{#if pauseStore.error}<p class="text-sm text-destructive-text" role="alert">{pauseStore.error}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
			<Button onclick={pause} disabled={pauseStore.busy}>{pauseStore.busy ? 'Pausing…' : 'Pause'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
