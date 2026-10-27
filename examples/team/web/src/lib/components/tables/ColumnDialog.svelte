<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { TYPE_HINTS, TYPE_LABELS } from '#lib/tables/grid.js';
	import { COLUMN_NAME, COLUMN_TYPES, type ColumnDraft, emptyColumn } from '#lib/tables/tables.js';
	import { columnSlug } from '#lib/tables/templates.js';
	import { cn } from '#lib/utils.js';
	import TypeIcon from './TypeIcon.svelte';

	/**
	 * Add or edit one field of the schema. Renaming can move the values rows already have to the
	 * new name; changing the type never converts existing values.
	 */
	let {
		open = $bindable(false),
		initial = null,
		taken = [],
		rowCount = 0,
		onSubmit
	}: {
		open?: boolean;
		/** null adds a field; a draft edits that field (or adds a field seen only in rows). */
		initial?: (ColumnDraft & { isNew?: boolean }) | null;
		taken?: string[];
		rowCount?: number;
		onSubmit: (draft: ColumnDraft, o: { oldName: string | null; move: boolean }) => Promise<string | null>;
	} = $props();

	let d = $state<ColumnDraft>(emptyColumn());
	let move = $state(true);
	let error = $state('');
	let busy = $state(false);

	const editing = $derived(!!initial && !initial.isNew);
	const oldName = $derived(editing && initial ? initial.name : null);
	const renamed = $derived(oldName !== null && d.name.trim() !== '' && columnSlug(d.name) !== oldName);
	const retyped = $derived(editing && initial ? initial.type !== d.type : false);

	$effect(() => {
		if (open)
			untrack(() => {
				d = initial ? { ...initial } : emptyColumn();
				move = true;
				error = '';
			});
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = '';
		const name = columnSlug(d.name);
		if (!COLUMN_NAME.test(name)) {
			error = 'Give the field a name: letters, digits and _, starting with a letter.';
			return;
		}
		if (name !== oldName && taken.includes(name)) {
			error = `There is already a field called ${name}.`;
			return;
		}
		busy = true;
		try {
			const problem = await onSubmit({ ...d, name }, { oldName, move: renamed && move });
			if (problem) error = problem;
			else open = false;
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="[&>*]:min-w-0 max-h-[92dvh] overflow-y-auto sm:max-w-lg">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>{editing ? `Edit field “${oldName}”` : initial?.isNew ? `Add “${initial.name}” to the schema` : 'Add a field'}</Dialog.Title>
				<Dialog.Description>Fields give rows a shape: a type, a default and a required check.</Dialog.Description>
			</Dialog.Header>

			<Field.Field>
				<Field.Label for="col-name">Name</Field.Label>
				<Input id="col-name" bind:value={d.name} placeholder="e.g. email" autocomplete="off" onblur={() => (d.name = columnSlug(d.name))} />
				{#if renamed && rowCount > 0}
					<label class="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
						<Checkbox checked={move} onCheckedChange={(v) => (move = v === true)} class="mt-px" />
						<span>Move the values rows already have from <code class="font-mono">{oldName}</code> to <code class="font-mono">{columnSlug(d.name)}</code>. Otherwise they stay under the old name. Agents and scripts that use the old name need updating.</span>
					</label>
				{/if}
			</Field.Field>

			<div class="flex flex-col gap-2">
				<span class="text-sm font-medium">Type</span>
				<div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Type">
					{#each COLUMN_TYPES as t (t)}
						<button
							type="button"
							role="radio"
							aria-checked={d.type === t}
							class={cn(
								'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
								d.type === t ? 'border-brand bg-brand-soft' : 'border-border hover:bg-accent'
							)}
							onclick={() => {
								if (d.type !== t) d.default = '';
								d.type = t;
							}}
						>
							<TypeIcon type={t} class="size-4 text-muted-foreground" />
							<span class="flex min-w-0 flex-col">
								<span class="text-sm font-medium">{TYPE_LABELS[t]}</span>
								<span class="truncate text-xs text-muted-foreground">{TYPE_HINTS[t]}</span>
							</span>
						</button>
					{/each}
				</div>
				{#if retyped && rowCount > 0}<p class="text-xs text-warning-text">Existing values are not converted: the new type applies to values written from now on.</p>{/if}
			</div>

			<Field.Field>
				<Field.Label for="col-default">Default value <span class="font-normal text-muted-foreground">(optional)</span></Field.Label>
				{#if d.type === 'boolean'}
					<NativeSelect id="col-default" bind:value={d.default}>
						<NativeSelectOption value="">No default</NativeSelectOption>
						<NativeSelectOption value="true">Checked</NativeSelectOption>
						<NativeSelectOption value="false">Unchecked</NativeSelectOption>
					</NativeSelect>
				{:else if d.type === 'date'}
					<Input id="col-default" type="date" bind:value={d.default} />
				{:else}
					<Input
						id="col-default"
						bind:value={d.default}
						inputmode={d.type === 'number' ? 'decimal' : undefined}
						placeholder={d.type === 'json' ? '["a", "b"]' : d.type === 'number' ? '0' : 'Used when a new row leaves it empty'}
						class={d.type === 'json' ? 'font-mono text-xs' : ''}
						autocomplete="off"
					/>
				{/if}
			</Field.Field>

			<Field.Field>
				<Field.Label for="col-desc">Description <span class="font-normal text-muted-foreground">(optional)</span></Field.Label>
				<Input id="col-desc" bind:value={d.description} placeholder="What it means — agents read this" autocomplete="off" />
			</Field.Field>

			<div class="flex flex-col gap-3 rounded-lg border border-border p-3">
				<label class="flex items-center justify-between gap-3 text-sm">
					<span class="flex flex-col"><span>Required</span><span class="text-xs text-muted-foreground">New and changed rows must have a value.</span></span>
					<Switch bind:checked={d.required} />
				</label>
				<label class="flex items-center justify-between gap-3 text-sm">
					<span class="flex flex-col"><span>Indexed</span><span class="text-xs text-muted-foreground">Faster filters and sorts on big tables.</span></span>
					<Switch bind:checked={d.indexed} disabled={d.unique === true} />
				</label>
				{#if d.type === 'string' || d.type === 'number' || d.type === 'date'}
					<label class="flex items-center justify-between gap-3 text-sm">
						<span class="flex flex-col"><span>Unique</span><span class="text-xs text-muted-foreground">No two rows share a value (empty does not count). Upserts use it as the key.</span></span>
						<Switch checked={d.unique === true} onCheckedChange={(v) => { d.unique = v; if (v) d.indexed = true; }} />
					</label>
				{/if}
			</div>

			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" disabled={busy}>{#if busy}<Spinner />{/if}{editing ? 'Save field' : 'Add field'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
