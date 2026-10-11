<script lang="ts">
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimple';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { attachedPath, type SampleForm } from '#lib/rehearsal/model.js';

	/**
	 * The sample data of a rehearsal or a test case: library files to copy, text files to attach, the
	 * task a worker program works on, and whether the run may read the rest of the library.
	 */
	let { form = $bindable(), worker = false, errors = {} }: { form: SampleForm; worker?: boolean; errors?: Record<string, string> } = $props();

	const MAX_FILE_BYTES = 400_000;
	let picker = $state<HTMLInputElement | null>(null);

	async function attach(e: Event): Promise<void> {
		const input = e.currentTarget as HTMLInputElement;
		for (const file of Array.from(input.files ?? [])) {
			if (file.size > MAX_FILE_BYTES) {
				toast.error(`${file.name} is over 400 KB: attach a smaller sample.`);
				continue;
			}
			form.files = [...form.files, { path: attachedPath(file.name), content: await file.text() }];
		}
		input.value = '';
	}
</script>

<fieldset class="flex flex-col gap-3 rounded-lg border border-border p-3" data-testid="sample-fields">
	<legend class="px-1 font-medium">Sample data</legend>
	<p class="text-xs text-muted-foreground">
		The run works on a scratch copy: whatever it writes stays in the test run and never reaches your library. Give it something to chew on.
	</p>

	{#if worker}
		<div class="flex flex-col gap-2 rounded-md border border-border/70 p-2.5">
			<span class="text-xs font-medium">The task it works on</span>
			<p class="text-xs text-muted-foreground">This program takes tasks from the work queue. The sample task is a draft: nothing is queued on the board.</p>
			<Input bind:value={form.taskTitle} placeholder="Script: the lighthouse" aria-label="Task title" aria-invalid={!!errors.taskTitle} />
			{#if errors.taskTitle}<span class="text-xs text-destructive-text">{errors.taskTitle}</span>{/if}
			<Textarea bind:value={form.taskBrief} rows={3} placeholder="What to do, what the result looks like." aria-label="Task brief" />
			<Textarea bind:value={form.taskInputs} rows={2} placeholder="/library/production/videos.md" class="font-mono text-xs" aria-label="Task inputs" aria-invalid={!!errors.taskInputs} />
			{#if errors.taskInputs}<span class="text-xs text-destructive-text">{errors.taskInputs}</span>{:else}<span class="text-xs text-muted-foreground">Library paths the task starts from, one per line.</span>{/if}
		</div>
	{/if}

	<label class="flex flex-col gap-1">
		<span class="text-xs font-medium">Library files to copy in</span>
		<Textarea bind:value={form.copy} rows={3} placeholder={'/library/data/community/\n/library/videos/titles.md'} class="font-mono text-xs" aria-invalid={!!errors.copy} />
		{#if errors.copy}<span class="text-xs text-destructive-text">{errors.copy}</span>{:else}<span class="text-xs text-muted-foreground">Files or folders (ending with /), one per line. They are copied into the test run at the same paths.</span>{/if}
	</label>

	<div class="flex flex-col gap-2">
		<span class="text-xs font-medium">Attached files</span>
		{#each form.files as file, i (i)}
			<div class="flex flex-col gap-1.5 rounded-md border border-border/70 p-2">
				<div class="flex gap-2">
					<Input bind:value={file.path} class="font-mono text-xs" aria-label="Path of the attached file" />
					<Button type="button" variant="ghost" size="icon" aria-label="Remove file" onclick={() => (form.files = form.files.filter((_, j) => j !== i))}><TrashIcon class="size-4" /></Button>
				</div>
				<Textarea bind:value={file.content} rows={3} class="font-mono text-xs" aria-label="Content of the attached file" />
			</div>
		{/each}
		{#if errors.files}<span class="text-xs text-destructive-text">{errors.files}</span>{/if}
		<div class="flex flex-wrap gap-2">
			<input bind:this={picker} type="file" multiple accept="text/*,.md,.csv,.json,.jsonl,.txt" class="hidden" onchange={attach} />
			<Button type="button" variant="outline" size="sm" onclick={() => picker?.click()}><UploadSimpleIcon class="size-4" /> Attach files</Button>
			<Button type="button" variant="outline" size="sm" onclick={() => (form.files = [...form.files, { path: '/library/rehearsal-input/sample.md', content: '' }])}><PlusIcon class="size-4" /><FileTextIcon class="size-4" /> Paste text</Button>
		</div>
	</div>

	<label class="flex items-start gap-2">
		<input type="checkbox" bind:checked={form.onlySample} class="mt-0.5" />
		<span class="text-xs">
			Only the sample data is visible
			<span class="block text-muted-foreground">Off: the run can also read the rest of your real library (it still cannot change it). On: it sees only the files above.</span>
		</span>
	</label>
</fieldset>
