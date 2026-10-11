<script lang="ts">
	import { onMount } from 'svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { api, fieldErrors } from '#lib/api/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { CONFLICT_TEXT, isVersionConflict } from '#lib/conflict.js';
	import { bodyFromForm, emptyProgramForm, formFromProgram, REPORT_OPTIONS, validateProgramForm, type Program, type ProgramForm, type ProgramShape } from '#lib/programs/form.js';
	import ScheduleFields from './ScheduleFields.svelte';

	let {
		agentId = '',
		program,
		proposed,
		onApply,
		formId = 'program-form',
		saving = $bindable(false),
		valid = $bindable(false),
		onSaved
	}: {
		/** Preset agent for a new program; with none the form shows an agent picker. */
		agentId?: string;
		program?: Program | undefined;
		/** A program an agent proposed (Decision Center): the form edits it and hands the result to `onApply` instead of saving. */
		proposed?: ProgramShape | undefined;
		onApply?: (form: ProgramForm) => void;
		formId?: string;
		saving?: boolean;
		valid?: boolean;
		onSaved?: (p: Program) => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let form = $state<ProgramForm>(program ? formFromProgram(program) : proposed ? formFromProgram(proposed) : emptyProgramForm());
	// svelte-ignore state_referenced_locally
	let pickedAgent = $state(program?.agentId ?? agentId);
	let errors = $state<Record<string, string>>({});
	let formError = $state('');

	onMount(() => void agentsStore.load());
	$effect(() => {
		valid = !!form.name.trim() && !!form.brief.trim() && (!!pickedAgent || !!proposed);
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		errors = validateProgramForm(form);
		formError = '';
		if (Object.keys(errors).length) return;
		let body;
		try {
			body = bodyFromForm(form);
		} catch (err) {
			errors = { schedule: err instanceof Error ? err.message : String(err) };
			return;
		}
		if (onApply) {
			onApply(form);
			return;
		}
		saving = true;
		try {
			const saved = program
				? await api.patch('/programs/{id}', { params: { id: program.id }, body: { ...body, version: program.version } })
				: await api.post('/programs', { body: { agentId: pickedAgent, ...body } });
			toast.success(program ? 'Program saved' : 'Program created');
			onSaved?.(saved);
		} catch (err) {
			errors = fieldErrors(err);
			formError = isVersionConflict(err) ? CONFLICT_TEXT : err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet lines(field: 'tools' | 'connectors' | 'read' | 'write' | 'gates' | 'forbidden', label: string, placeholder: string, hint: string)}
	<label class="flex flex-col gap-1">
		<span class="font-medium">{label}</span>
		<Textarea bind:value={form[field]} rows={3} {placeholder} class="font-mono text-xs" aria-invalid={!!errors[field]} />
		{#if errors[field]}<span class="text-xs text-destructive-text">{errors[field]}</span>{:else}<span class="text-xs text-muted-foreground">{hint}</span>{/if}
	</label>
{/snippet}

<form id={formId} class="flex flex-col gap-4 text-sm" onsubmit={submit}>
	{#if !program && !proposed}
		<label class="flex flex-col gap-1">
			<span class="font-medium">Agent</span>
			<NativeSelect bind:value={pickedAgent} aria-invalid={!!errors.agentId}>
				<NativeSelectOption value="" disabled>Choose an agent…</NativeSelectOption>
				{#each agentsStore.state.agents as a (a.id)}
					<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>
				{/each}
			</NativeSelect>
			{#if errors.agentId}<span class="text-xs text-destructive-text">{errors.agentId}</span>{/if}
		</label>
	{/if}
	<label class="flex flex-col gap-1">
		<span class="font-medium">Name</span>
		<Input bind:value={form.name} placeholder="Draft scripts for new video titles" aria-invalid={!!errors.name} />
		{#if errors.name}<span class="text-xs text-destructive-text">{errors.name}</span>{/if}
	</label>
	<label class="flex flex-col gap-1">
		<span class="font-medium">Brief</span>
		<Textarea bind:value={form.brief} rows={5} placeholder={'What to do, and the steps.\n1. Read /library/videos/titles.md\n2. For each title without a script, write /library/reports/<title>.md'} aria-invalid={!!errors.brief} />
		{#if errors.brief}<span class="text-xs text-destructive-text">{errors.brief}</span>{/if}
	</label>

	<fieldset class="flex flex-col gap-3 rounded-lg border border-border p-3">
		<legend class="px-1 font-medium">Authority</legend>
		<p class="text-xs text-muted-foreground">
			What this program may do while nobody is watching. It is enforced for every run: anything not listed here is refused, never asked.
		</p>
		{@render lines('tools', 'Tools', 'web_fetch\nWebFetch(domain:example.com)', 'One tool name or rule per line.')}
		{@render lines('connectors', 'Connectors', 'github', 'Connector or connection ids: every tool of them is allowed.')}
		<div class="grid gap-3 sm:grid-cols-2">
			{@render lines('read', 'Read paths', '/library/videos/**', 'Library globs, one per line.')}
			{@render lines('write', 'Write paths', '/library/reports/**', 'Library globs; writable paths can be read too.')}
		</div>
		{@render lines('forbidden', 'Forbidden', 'Edit(/library/reports/final/**)', 'Never allowed, even inside the authority above.')}
	</fieldset>

	<fieldset class="flex flex-col gap-3 rounded-lg border border-border p-3">
		<legend class="px-1 font-medium">Decisions</legend>
		{@render lines('gates', 'Needs your decision', 'Publishing anything\nSpending more than the budget', 'Actions the program must not do on its own; it reports them instead.')}
		<label class="flex flex-col gap-1">
			<span class="font-medium">Escalation</span>
			<Textarea bind:value={form.escalation} rows={2} placeholder="Stop and report when a title looks harmful or the source is missing." />
		</label>
	</fieldset>

	<fieldset class="flex flex-col gap-2">
		<legend class="mb-1 font-medium">Budget</legend>
		<div class="grid gap-3 sm:grid-cols-2">
			<label class="flex flex-col gap-1">
				<span class="text-xs text-muted-foreground">Per run (USD)</span>
				<Input bind:value={form.perRunUsd} inputmode="decimal" placeholder="no limit" aria-invalid={!!errors.perRunUsd} />
				{#if errors.perRunUsd}<span class="text-xs text-destructive-text">{errors.perRunUsd}</span>{/if}
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs text-muted-foreground">Per day (USD)</span>
				<Input bind:value={form.perDayUsd} inputmode="decimal" placeholder="no limit" aria-invalid={!!errors.perDayUsd} />
				{#if errors.perDayUsd}<span class="text-xs text-destructive-text">{errors.perDayUsd}</span>{/if}
			</label>
		</div>
	</fieldset>

	<fieldset class="flex flex-col gap-2">
		<legend class="mb-1 font-medium">When it runs</legend>
		<NativeSelect bind:value={form.triggerKind} aria-label="Trigger">
			<NativeSelectOption value="manual">Only when I run it</NativeSelectOption>
			<NativeSelectOption value="schedule">On a schedule</NativeSelectOption>
		</NativeSelect>
		{#if form.triggerKind === 'schedule'}
			<ScheduleFields bind:schedule={form.schedule} error={errors.schedule ?? errors['trigger.spec.expr'] ?? errors['trigger.spec.tz'] ?? ''} />
		{/if}
	</fieldset>

	<label class="flex flex-col gap-1">
		<span class="font-medium">Where the result goes</span>
		<NativeSelect bind:value={form.report}>
			{#each REPORT_OPTIONS as o (o.value)}
				<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>
			{/each}
		</NativeSelect>
		<span class="text-xs text-muted-foreground">{REPORT_OPTIONS.find((o) => o.value === form.report)?.hint}</span>
	</label>

	{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}
</form>
