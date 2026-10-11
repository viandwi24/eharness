<script lang="ts">
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { fromLocalInput, SCHEDULE_PRESETS, timezones, toLocalInput, WEEKDAYS, type ScheduleForm } from '#lib/routines/schedule.js';

	/** The schedule fields shared by routines and programs; `buildSpec` turns the form into the API shape. */
	let { schedule = $bindable(), error = '' }: { schedule: ScheduleForm; error?: string } = $props();

	const zones = $derived(timezones(schedule.tz));
	const usesTz = $derived(schedule.kind !== 'every' && schedule.kind !== 'once');
</script>

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
	{#if error}
		<span class="text-xs text-destructive-text">{error}</span>
	{/if}
</fieldset>
