<script lang="ts">
	import { untrack } from 'svelte';
	import { api, fieldErrors } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { bodyFromTaskForm, emptyTaskForm, PRIORITIES, type TaskForm, validateTaskForm } from '#lib/tasks/queue.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { closeTaskDialog, taskDialog } from '#lib/stores/dialogs.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	let form = $state<TaskForm>(emptyTaskForm());
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);

	$effect(() => {
		if (!taskDialog.open) return;
		untrack(() => {
			form = emptyTaskForm(taskDialog.agentId ?? '');
			errors = {};
			formError = '';
			void agentsStore.load();
		});
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		errors = validateTaskForm(form);
		formError = '';
		if (Object.keys(errors).length) return;
		saving = true;
		try {
			await api.post('/tasks', { body: bodyFromTaskForm(form) });
			toast.success(form.hold ? 'Task saved on hold' : 'Task assigned: it starts when the agent is free');
			closeTaskDialog();
			void live.loadTasks();
		} catch (err) {
			errors = fieldErrors(err);
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open={taskDialog.open}>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>New task</Dialog.Title>
			<Dialog.Description>
				The agent you pick starts on it right away (or as soon as it finishes its current task) with the tools and permissions it has in chat. You follow it on the board and review the result.
			</Dialog.Description>
		</Dialog.Header>
		<form id="new-task-form" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-sm" onsubmit={submit}>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Who does it</span>
				<NativeSelect bind:value={form.agentId} aria-invalid={!!errors.agentId}>
					<NativeSelectOption value="" disabled>Choose an agent…</NativeSelectOption>
					{#each agentsStore.state.agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
				</NativeSelect>
				{#if errors.agentId}<span class="text-xs text-destructive-text">{errors.agentId}</span>{/if}
			</label>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Title</span>
				<Input bind:value={form.title} placeholder="Weekly summary: March" aria-invalid={!!errors.title} />
				{#if errors.title}<span class="text-xs text-destructive-text">{errors.title}</span>{/if}
			</label>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Brief</span>
				<Textarea bind:value={form.brief} rows={5} placeholder={'What to do, what the result looks like, where to save it.'} />
				<span class="text-xs text-muted-foreground">The agent starts with an empty context: this is everything it knows. Markdown works.</span>
			</label>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Inputs</span>
				<Textarea bind:value={form.inputs} rows={2} placeholder="/library/notes/inputs.md" class="font-mono text-xs" aria-invalid={!!errors.inputs} />
				{#if errors.inputs}<span class="text-xs text-destructive-text">{errors.inputs}</span>{:else}<span class="text-xs text-muted-foreground">Library paths it starts from, one per line.</span>{/if}
			</label>
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="flex flex-col gap-1">
					<span class="font-medium">Priority</span>
					<NativeSelect bind:value={form.priority}>
						{#each PRIORITIES as p (p.value)}<NativeSelectOption value={p.value}>{p.label}</NativeSelectOption>{/each}
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="font-medium">Due</span>
					<Input type="date" bind:value={form.due} aria-invalid={!!errors.due} />
					{#if errors.due}<span class="text-xs text-destructive-text">{errors.due}</span>{/if}
				</label>
			</div>
			<div class="flex flex-col gap-2">
				<label class="flex items-start gap-2">
					<input type="checkbox" bind:checked={form.review} class="mt-0.5" />
					<span>Ask me to review the result<span class="block text-xs text-muted-foreground">It waits in Review until you accept it or send it back with a note.</span></span>
				</label>
				<label class="flex items-start gap-2">
					<input type="checkbox" bind:checked={form.hold} class="mt-0.5" data-testid="task-hold" />
					<span>Hold: do not start yet<span class="block text-xs text-muted-foreground">It waits in Queued until you press Start now.</span></span>
				</label>
			</div>
			<details class="rounded-lg border border-border px-3 py-2" data-testid="task-grants">
				<summary class="cursor-pointer text-[13px] font-medium">Extra permissions for this task (optional)</summary>
				<div class="mt-2 flex flex-col gap-3">
					<p class="text-xs text-muted-foreground">Normally the agent has what it has in chat: anything that needs approval asks you on the board. Pre-approve more here, only for this task.</p>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">Tools (one per line)</span>
						<Textarea bind:value={form.grantTools} rows={2} placeholder="add_comment" class="font-mono text-xs" />
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">May read (library paths)</span>
						<Textarea bind:value={form.grantRead} rows={2} placeholder="/library/research/**" class="font-mono text-xs" aria-invalid={!!errors.grantRead} />
						{#if errors.grantRead}<span class="text-xs text-destructive-text">{errors.grantRead}</span>{/if}
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium">May write (library paths)</span>
						<Textarea bind:value={form.grantWrite} rows={2} placeholder="/library/reports/**" class="font-mono text-xs" aria-invalid={!!errors.grantWrite} />
						{#if errors.grantWrite}<span class="text-xs text-destructive-text">{errors.grantWrite}</span>{/if}
					</label>
				</div>
			</details>
			{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}
		</form>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button type="button" variant="ghost" onclick={closeTaskDialog}>Cancel</Button>
			<Button type="submit" form="new-task-form" disabled={saving}>{saving ? 'Assigning…' : form.hold ? 'Save on hold' : 'Assign task'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
