<script lang="ts">
	import { onMount } from 'svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { api, fieldErrors } from '#lib/api/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { CONFLICT_TEXT, isVersionConflict } from '#lib/conflict.js';
	import { bodyFromForm, checkFromForm, emptyProgramForm, formFromProgram, REPORT_OPTIONS, validateProgramForm, warningsOf, type Program, type ProgramForm, type ProgramShape, type ProgramWarning } from '#lib/programs/form.js';
	import DeliverablesFields from './DeliverablesFields.svelte';
	import ScheduleFields from './ScheduleFields.svelte';
	import EffectiveGrant from './EffectiveGrant.svelte';
	import ToolPicker from './ToolPicker.svelte';
	import { problemNames, uniqueWarnings, type EffectiveGrant as Grant } from '#lib/programs/grant.js';

	let {
		agentId = '',
		worker = false,
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
		/** A new program starts as a worker of the queued tasks of its agent. */
		worker?: boolean;
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
	let form = $state<ProgramForm>(program ? formFromProgram(program) : proposed ? formFromProgram(proposed) : { ...emptyProgramForm(), worker });
	// svelte-ignore state_referenced_locally
	let pickedAgent = $state(program?.agentId ?? proposed?.agentId ?? agentId);
	let errors = $state<Record<string, string>>({});
	let formError = $state('');

	onMount(() => void agentsStore.load());

	// What the program cannot do as configured (tools its agent never has, a budget below one model call):
	// the server checks the form while the client types, and the warnings sit next to the fields.
	let warnings = $state<ProgramWarning[]>([]);
	// svelte-ignore state_referenced_locally
	let grant = $state<Grant | null>(program?.grant ?? null);
	let authorityErrors = $state<string[]>([]);
	$effect(() => {
		let request;
		try {
			request = checkFromForm(form, pickedAgent || proposed?.agentId || '');
		} catch {
			request = undefined;
		}
		if (!request) {
			warnings = [];
			return;
		}
		let stale = false;
		const timer = setTimeout(() => {
			api.post('/programs/check', { body: request })
				.then((r) => {
					if (stale) return;
					warnings = r.warnings;
					grant = r.grant;
					authorityErrors = r.errors;
				})
				.catch(() => {
					if (!stale) {
						warnings = [];
						authorityErrors = [];
					}
				});
		}, 400);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	});
	$effect(() => {
		valid = !!form.name.trim() && !!form.brief.trim() && (!!pickedAgent || !!proposed) && authorityErrors.length === 0;
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		errors = validateProgramForm(form);
		formError = '';
		if (authorityErrors.length) {
			formError = 'Fix what this program may use before saving: ' + authorityErrors[0];
			return;
		}
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

{#snippet warn(fields: string[])}
	{#each uniqueWarnings(warningsOf(warnings, ...fields), authorityErrors) as w (w.message)}
		<p class="rounded-md border border-warning/40 bg-warning-soft px-2 py-1.5 text-xs text-warning-text" role="status" data-testid="program-warning">{w.message}</p>
	{/each}
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
		<Input bind:value={form.name} placeholder="Draft the weekly summary" aria-invalid={!!errors.name} />
		{#if errors.name}<span class="text-xs text-destructive-text">{errors.name}</span>{/if}
	</label>
	<label class="flex flex-col gap-1">
		<span class="font-medium">Brief</span>
		<Textarea bind:value={form.brief} rows={5} placeholder={'What to do, and the steps.\n1. Read /library/notes/items.md\n2. For each item without a summary, write /library/reports/<item>.md'} aria-invalid={!!errors.brief} />
		{#if errors.brief}<span class="text-xs text-destructive-text">{errors.brief}</span>{/if}
	</label>

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

	<fieldset class="flex flex-col gap-3 rounded-lg border border-border p-3">
		<legend class="px-1 font-medium">What it is allowed to do</legend>
		<p class="text-xs text-muted-foreground">
			It works on its own while nobody is watching, so anything not allowed here is refused, never asked.
		</p>
		<div class="grid gap-3 sm:grid-cols-2">
			{@render lines('read', 'May read', '/library/notes/**', 'Library folders or files, one per line.')}
			{@render lines('write', 'May write', '/library/reports/**', 'Library folders or files; what it may write it may also read.')}
		</div>
		<ToolPicker agentId={pickedAgent || proposed?.agentId || ''} bind:tools={form.tools} bind:connectors={form.connectors} />
		{@render warn(['authority.tools'])}
		{#each authorityErrors as message (message)}
			<p class="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive-text" role="alert" data-testid="authority-error">{message}</p>
		{/each}
		<EffectiveGrant {grant} skip={problemNames(warnings, authorityErrors).all} always title="Effective grant: what each run can really do" />
	</fieldset>

	<details class="rounded-lg border border-border px-3 py-2" data-testid="program-advanced">
		<summary class="cursor-pointer text-[13px] font-medium">Advanced: limits, decisions, files, budget, results</summary>
		<div class="mt-3 flex flex-col gap-4">
			{@render lines('forbidden', 'Never allowed', 'Edit(/library/reports/final/**)', 'Blocked even inside what is allowed above.')}
			{@render lines('gates', 'Needs your decision', 'Publishing anything\nSpending more than the budget', 'Things the program must not do on its own; it reports them instead.')}
			<label class="flex flex-col gap-1">
				<span class="font-medium">When to stop and ask</span>
				<Textarea bind:value={form.escalation} rows={2} placeholder="Stop and report when a source is missing or something looks wrong." />
			</label>

			<DeliverablesFields bind:rows={form.deliverables} {errors} />

			<fieldset class="flex flex-col gap-2 rounded-lg border border-border p-3">
				<legend class="px-1 font-medium">Work queue</legend>
				<label class="flex items-start gap-2">
					<input type="checkbox" bind:checked={form.worker} class="mt-0.5" />
					<span>
						Work through the queued tasks of this agent
						<span class="block text-xs text-muted-foreground">Optional. Each run takes the next queued tasks (highest priority, then nearest due date) and works them under the permissions above. Most work needs no worker program: tasks assigned to an agent start by themselves.</span>
					</span>
				</label>
				{#if form.worker}
					<label class="flex flex-col gap-1 sm:w-48">
						<span class="text-xs text-muted-foreground">Tasks per run</span>
						<Input bind:value={form.maxTasks} inputmode="numeric" aria-invalid={!!errors.maxTasks} />
						{#if errors.maxTasks}<span class="text-xs text-destructive-text">{errors.maxTasks}</span>{/if}
					</label>
				{/if}
			</fieldset>

			<fieldset class="flex flex-col gap-2">
				<legend class="mb-1 font-medium">Spending limit</legend>
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
				<label class="flex flex-col gap-1 sm:w-64">
					<span class="text-xs text-muted-foreground">Longest answer per step (tokens, optional)</span>
					<Input bind:value={form.maxOutputTokens} inputmode="numeric" placeholder="sized from the limit" aria-invalid={!!errors.maxOutputTokens} />
					{#if errors.maxOutputTokens}<span class="text-xs text-destructive-text">{errors.maxOutputTokens}</span>{:else}<span class="text-xs text-muted-foreground">Each step reserves its worst case against the limit before it runs, so a small limit needs a small cap.</span>{/if}
				</label>
				{@render warn(['budget.perRunUsd', 'budget.perDayUsd'])}
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
		</div>
	</details>

	{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}
</form>
