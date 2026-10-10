<script lang="ts">
	import { api, fieldErrors } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import {
		buildSpec,
		CATCH_UP_OPTIONS,
		defaultScheduleForm,
		fromLocalInput,
		parseSpec,
		SCHEDULE_PRESETS,
		timezones,
		toLocalInput,
		WEEKDAYS,
		type ScheduleForm,
		type ScheduleKind
	} from '#lib/routines/schedule.js';

	type Routine = components['schemas']['Routine'];

	let {
		open = $bindable(false),
		agentId,
		routine,
		onSaved
	}: { open: boolean; agentId: string; routine?: Routine | undefined; onSaved?: (r: Routine) => void } = $props();

	let name = $state('');
	let prompt = $state('');
	let schedule = $state<ScheduleForm>(defaultScheduleForm());
	let sessionMode = $state<'dm' | 'task'>('dm');
	let overlap = $state<'skip' | 'queue'>('skip');
	let catchUp = $state('null');
	let maxFailures = $state(3);
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);

	// Reset the form each time the dialog opens (for the routine being edited, or a blank one).
	$effect(() => {
		if (!open) return;
		name = routine?.name ?? '';
		prompt = routine?.prompt ?? '';
		schedule = routine ? parseSpec(routine.schedule) : defaultScheduleForm();
		sessionMode = routine?.sessionMode ?? 'dm';
		overlap = routine?.overlap ?? 'skip';
		catchUp = String(routine?.catchUpWindowMs ?? null);
		maxFailures = routine?.maxFailures ?? 3;
		errors = {};
		formError = '';
	});

	const zones = $derived(timezones(schedule.tz));
	const usesTz = $derived(schedule.kind !== 'every' && schedule.kind !== 'once');

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
				? await api.patch('/routines/{id}', { params: { id: routine.id }, body: common })
				: await api.post('/routines', { body: { agentId, ...common } });
			toast.success(routine ? 'Routine saved' : 'Routine created');
			open = false;
			onSaved?.(saved);
		} catch (err) {
			errors = fieldErrors(err);
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90svh] overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{routine ? 'Edit routine' : 'New routine'}</Dialog.Title>
			<Dialog.Description>The agent runs the prompt on a schedule, with a fresh context each time plus its memory.</Dialog.Description>
		</Dialog.Header>
		<form class="flex flex-col gap-3 text-sm" onsubmit={submit}>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Name</span>
				<Input bind:value={name} placeholder="Morning briefing" aria-invalid={!!errors.name} />
				{#if errors.name}<span class="text-xs text-destructive-text">{errors.name}</span>{/if}
			</label>

			<fieldset class="flex flex-col gap-2">
				<legend class="mb-1 font-medium">Schedule</legend>
				<NativeSelect bind:value={schedule.kind} aria-label="Schedule type">
					{#each SCHEDULE_PRESETS as p (p.id)}
						<NativeSelectOption value={p.id}>{p.label}</NativeSelectOption>
					{/each}
				</NativeSelect>
				{#if schedule.kind === 'daily' || schedule.kind === 'weekdays' || schedule.kind === 'weekly'}
					<div class="flex gap-2">
						{#if schedule.kind === 'weekly'}
							<NativeSelect value={String(schedule.weekday)} onchange={(e) => (schedule.weekday = Number(e.currentTarget.value))} aria-label="Weekday">
								{#each WEEKDAYS as d, i (d)}
									<NativeSelectOption value={String(i)}>{d}</NativeSelectOption>
								{/each}
							</NativeSelect>
						{/if}
						<Input type="time" bind:value={schedule.time} aria-label="Time" class="w-32" />
					</div>
				{:else if schedule.kind === 'every'}
					<label class="flex items-center gap-2">
						<span>Every</span>
						<Input type="number" min="1" bind:value={schedule.everyMinutes} class="w-24" aria-label="Minutes" />
						<span>minutes</span>
					</label>
				{:else if schedule.kind === 'custom'}
					<Input bind:value={schedule.expr} placeholder="0 9 * * 1-5" class="font-mono text-xs" aria-label="Cron expression" />
					<span class="text-xs text-muted-foreground">5 or 6 fields: minute hour day month weekday (second first with 6).</span>
				{:else if schedule.kind === 'once'}
					<Input
						type="datetime-local"
						value={toLocalInput(schedule.at)}
						onchange={(e) => (schedule.at = fromLocalInput(e.currentTarget.value))}
						aria-label="Run at"
					/>
				{/if}
				{#if usesTz}
					<label class="flex flex-col gap-1">
						<span class="text-xs text-muted-foreground">Timezone</span>
						<NativeSelect bind:value={schedule.tz} aria-label="Timezone">
							{#each zones as z (z)}
								<NativeSelectOption value={z}>{z}</NativeSelectOption>
							{/each}
						</NativeSelect>
					</label>
				{/if}
				{#if errors.schedule || errors['schedule.expr'] || errors['schedule.tz']}
					<span class="text-xs text-destructive-text">{errors.schedule ?? errors['schedule.expr'] ?? errors['schedule.tz']}</span>
				{/if}
			</fieldset>

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
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" disabled={saving || !name.trim() || !prompt.trim()}>{saving ? 'Saving…' : routine ? 'Save routine' : 'Create routine'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
