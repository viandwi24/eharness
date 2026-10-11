<script lang="ts">
	import { onMount } from 'svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { api, fieldErrors } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { CONFLICT_TEXT, isVersionConflict } from '#lib/conflict.js';
	import { buildSpec, CATCH_UP_OPTIONS, defaultScheduleForm, parseSpec, type ScheduleForm } from '#lib/routines/schedule.js';
	import ScheduleFields from './ScheduleFields.svelte';

	type Routine = components['schemas']['Routine'];

	let {
		agentId = '',
		routine,
		formId = 'routine-form',
		saving = $bindable(false),
		valid = $bindable(false),
		onSaved
	}: {
		/** Preset agent for a new routine; with none the form shows an agent picker. */
		agentId?: string;
		routine?: Routine | undefined;
		formId?: string;
		saving?: boolean;
		valid?: boolean;
		onSaved?: (r: Routine) => void;
	} = $props();

	let name = $state('');
	let prompt = $state('');
	let schedule = $state<ScheduleForm>(defaultScheduleForm());
	let sessionMode = $state<'dm' | 'task'>('dm');
	let overlap = $state<'skip' | 'queue'>('skip');
	let catchUp = $state('null');
	let maxFailures = $state(3);
	let errors = $state<Record<string, string>>({});
	let formError = $state('');

	// svelte-ignore state_referenced_locally
	let pickedAgent = $state(routine?.agentId ?? agentId);
	// svelte-ignore state_referenced_locally
	name = routine?.name ?? '';
	// svelte-ignore state_referenced_locally
	prompt = routine?.prompt ?? '';
	// svelte-ignore state_referenced_locally
	schedule = routine ? parseSpec(routine.schedule) : defaultScheduleForm();
	// svelte-ignore state_referenced_locally
	sessionMode = routine?.sessionMode ?? 'dm';
	// svelte-ignore state_referenced_locally
	overlap = routine?.overlap ?? 'skip';
	// svelte-ignore state_referenced_locally
	catchUp = String(routine?.catchUpWindowMs ?? null);
	// svelte-ignore state_referenced_locally
	maxFailures = routine?.maxFailures ?? 3;

	onMount(() => void agentsStore.load());
	$effect(() => {
		valid = !!name.trim() && !!prompt.trim() && !!pickedAgent;
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		errors = {};
		formError = '';
		let spec;
		try {
			spec = buildSpec(schedule);
		} catch (err) {
			errors = { schedule: err instanceof Error ? err.message : String(err) };
			return;
		}
		const common = {
			name: name.trim(),
			prompt: prompt.trim(),
			schedule: spec,
			sessionMode,
			overlap,
			catchUpWindowMs: catchUp === 'null' ? null : Number(catchUp),
			maxFailures: Math.max(1, Math.floor(maxFailures) || 1)
		};
		saving = true;
		try {
			const saved = routine
				? await api.patch('/routines/{id}', { params: { id: routine.id }, body: { ...common, version: routine.version } })
				: await api.post('/routines', { body: { agentId: pickedAgent, ...common } });
			toast.success(routine ? 'Routine saved' : 'Routine created');
			onSaved?.(saved);
		} catch (err) {
			errors = fieldErrors(err);
			formError = isVersionConflict(err) ? CONFLICT_TEXT : err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<form id={formId} class="flex flex-col gap-4 text-sm" onsubmit={submit}>
			{#if !routine}
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
				<Input bind:value={name} placeholder="Morning briefing" aria-invalid={!!errors.name} />
				{#if errors.name}<span class="text-xs text-destructive-text">{errors.name}</span>{/if}
			</label>

			<ScheduleFields bind:schedule error={errors.schedule ?? errors['schedule.expr'] ?? errors['schedule.tz'] ?? ''} />

			<label class="flex flex-col gap-1">
				<span class="font-medium">Prompt</span>
				<Textarea bind:value={prompt} rows={4} placeholder="Summarise what changed overnight and list what needs me." aria-invalid={!!errors.prompt} />
				{#if errors.prompt}<span class="text-xs text-destructive-text">{errors.prompt}</span>{/if}
			</label>

			<div class="grid gap-3 sm:grid-cols-2">
				<label class="flex flex-col gap-1">
					<span class="font-medium">Where it runs</span>
					<NativeSelect bind:value={sessionMode}>
						<NativeSelectOption value="dm">In the agent chat</NativeSelectOption>
						<NativeSelectOption value="task">As a task on the board</NativeSelectOption>
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="font-medium">If the last run is still going</span>
					<NativeSelect bind:value={overlap}>
						<NativeSelectOption value="skip">Skip this run</NativeSelectOption>
						<NativeSelectOption value="queue">Queue behind it</NativeSelectOption>
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="font-medium">Catch-up after downtime</span>
					<NativeSelect bind:value={catchUp}>
						{#each CATCH_UP_OPTIONS as o (String(o.value))}
							<NativeSelectOption value={String(o.value)}>{o.label}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</label>
				<label class="flex flex-col gap-1">
					<span class="font-medium">Pause after failures</span>
					<Input type="number" min="1" max="20" bind:value={maxFailures} />
				</label>
			</div>

			{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}
</form>
