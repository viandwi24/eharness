<script lang="ts">
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { DELIVERABLE_KINDS, emptyDeliverableRow, type DeliverableRow } from '#lib/programs/form.js';

	/** The files a run must leave in the library; the server checks them when the run ends. */
	let { rows = $bindable(), errors = {} }: { rows: DeliverableRow[]; errors?: Record<string, string> } = $props();
</script>

<fieldset class="flex flex-col gap-3 rounded-lg border border-border p-3" data-testid="deliverables-fields">
	<legend class="px-1 font-medium">Deliverables</legend>
	<p class="text-xs text-muted-foreground">
		Files each run must leave in the library. When the run ends the server checks them (the file exists, the headings are there, the JSON matches its schema). Anything wrong gets the agent one turn to fix it; after that the run is marked partial and you are asked. Path tokens: <code>{'{date}'}</code> <code>{'{slug}'}</code> <code>{'{runId}'}</code> <code>{'{program}'}</code>. Style and quality stay in the agent's skills.
	</p>
	{#each rows as row, i (i)}
		<div class="flex flex-col gap-2 rounded-md border border-border/70 p-2.5" data-testid="deliverable-row">
			<div class="flex gap-2">
				<Input bind:value={row.path} placeholder="/library/reports/{'{slug}'}/{'{date}'}.md" class="font-mono text-xs" aria-label="Path" aria-invalid={!!errors[`deliverables.${i}`]} />
				<NativeSelect bind:value={row.kind} aria-label="Kind" class="w-32 shrink-0">
					{#each DELIVERABLE_KINDS as k (k.value)}<NativeSelectOption value={k.value}>{k.label}</NativeSelectOption>{/each}
				</NativeSelect>
				<Button type="button" variant="ghost" size="icon" aria-label="Remove deliverable" onclick={() => (rows = rows.filter((_, j) => j !== i))}><TrashIcon class="size-4" /></Button>
			</div>
			{#if row.kind === 'markdown'}
				<label class="flex flex-col gap-1">
					<span class="text-xs text-muted-foreground">Required headings, one per line</span>
					<Textarea bind:value={row.sections} rows={2} placeholder={'Summary\nFindings'} class="text-xs" />
				</label>
			{:else if row.kind === 'json'}
				<label class="flex flex-col gap-1">
					<span class="text-xs text-muted-foreground">JSON Schema (optional)</span>
					<Textarea bind:value={row.schema} rows={4} placeholder={'{ "type": "object", "required": ["findings"] }'} class="font-mono text-xs" />
				</label>
			{/if}
			<label class="flex flex-col gap-1 sm:w-48">
				<span class="text-xs text-muted-foreground">Minimum length (characters, optional)</span>
				<Input bind:value={row.minChars} inputmode="numeric" />
			</label>
			{#if errors[`deliverables.${i}`]}<span class="text-xs text-destructive-text">{errors[`deliverables.${i}`]}</span>{/if}
		</div>
	{/each}
	<Button type="button" variant="outline" size="sm" class="self-start" onclick={() => (rows = [...rows, emptyDeliverableRow()])}><PlusIcon class="size-4" /> Add a deliverable</Button>
</fieldset>
