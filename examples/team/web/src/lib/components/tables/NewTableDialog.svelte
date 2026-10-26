<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { TYPE_LABELS } from '#lib/tables/grid.js';
	import { COLUMN_TYPES, schemaOf, TABLE_NAME } from '#lib/tables/tables.js';
	import { columnSlug, type QuickColumn, tableSlug, TEMPLATES } from '#lib/tables/templates.js';
	import { cn } from '#lib/utils.js';

	/** "New table": a template, a friendly name (its id follows), a description and a few fields. */
	let { open = $bindable(false), taken = [] }: { open?: boolean; taken?: string[] } = $props();

	let template = $state('blank');
	let display = $state('');
	let slug = $state('');
	let editSlug = $state(false);
	let description = $state('');
	let columns = $state<QuickColumn[]>([]);
	let error = $state('');
	let busy = $state(false);
	let nameEl = $state<HTMLInputElement | null>(null);
	// what a template filled in, so picking another template replaces only that, never typed text
	let autoName = '';
	let autoDescription = '';

	const id = $derived(editSlug ? slug : tableSlug(display));
	const idProblem = $derived(!id ? '' : !TABLE_NAME.test(id) ? 'Use lowercase letters, digits and _, starting with a letter.' : taken.includes(id) ? 'A table with this name exists.' : '');

	function pick(tid: string, focus = true): void {
		const t = TEMPLATES.find((x) => x.id === tid);
		if (!t) return;
		template = tid;
		// keep what the person typed; fill only what is empty or was filled by a template
		if (!display.trim() || display === autoName) display = autoName = t.name;
		if (!description.trim() || description === autoDescription) description = autoDescription = t.description;
		columns = t.columns.map((c) => ({ ...c }));
		if (focus) void tick().then(() => nameEl?.focus());
	}

	$effect(() => {
		if (open)
			untrack(() => {
				display = '';
				slug = '';
				editSlug = false;
				description = '';
				autoName = '';
				autoDescription = '';
				error = '';
				pick('blank', false);
			});
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = '';
		if (!id) {
			error = 'Give the table a name.';
			return;
		}
		if (idProblem) {
			error = idProblem;
			return;
		}
		const s = schemaOf(
			columns.map((c) => ({ name: columnSlug(c.name), type: c.type, required: c.required, indexed: false, default: c.default ?? '' })),
			false
		);
		if (!s.ok) {
			error = s.errors.join('. ');
			return;
		}
		busy = true;
		try {
			const t = await api.post('/tables', { body: { name: id, ...(description.trim() ? { description: description.trim() } : {}), ...(s.schema.columns.length ? { schema: s.schema } : {}) } });
			open = false;
			toast.success(`Table “${t.name}” created`);
			void goto(`/tables/${encodeURIComponent(t.name)}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the table';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		elevation="floating"
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			nameEl?.focus();
		}}
		class="[&>*]:min-w-0 max-h-[92dvh] overflow-y-auto sm:max-w-xl">
		<form class="flex flex-col gap-5" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>New table</Dialog.Title>
				<Dialog.Description>Pick a starting point. You can change everything later.</Dialog.Description>
			</Dialog.Header>

			<div class="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Template">
				{#each TEMPLATES as t (t.id)}
					<button
						type="button"
						role="radio"
						aria-checked={template === t.id}
						class={cn(
							'flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
							template === t.id ? 'border-brand bg-brand-soft' : 'border-border hover:bg-accent'
						)}
						onclick={() => pick(t.id)}
					>
						<span class="text-sm font-medium">{t.label}</span>
						<span class="text-xs leading-snug text-muted-foreground">{t.hint}</span>
					</button>
				{/each}
			</div>

			<Field.Field data-invalid={!!idProblem}>
				<Field.Label for="nt-name">Name</Field.Label>
				<Input id="nt-name" bind:ref={nameEl} bind:value={display} placeholder="e.g. Customer contacts" autocomplete="off" aria-invalid={!!idProblem} />
				{#if editSlug}
					<div class="flex items-center gap-2">
						<span class="shrink-0 text-xs text-muted-foreground">Table ID</span>
						<Input bind:value={slug} class="h-7 font-mono text-xs" aria-label="Table ID" autocomplete="off" />
					</div>
				{:else if id}
					<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
						Agents and scripts use <code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{id}</code>
						<button
							type="button"
							class="inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
							onclick={() => {
								slug = id;
								editSlug = true;
							}}><PencilSimpleIcon class="size-3" /> Change</button
						>
					</p>
				{/if}
				{#if idProblem}<Field.Error>{idProblem}</Field.Error>{/if}
			</Field.Field>

			<Field.Field>
				<Field.Label for="nt-desc">Description <span class="font-normal text-muted-foreground">(optional)</span></Field.Label>
				<Input id="nt-desc" bind:value={description} placeholder="What goes in this table — helps agents use it well" autocomplete="off" />
			</Field.Field>

			<div class="flex flex-col gap-2">
				<div class="flex items-baseline justify-between">
					<span class="text-sm font-medium">Fields</span>
					<span class="text-xs text-muted-foreground">Rows can also hold other fields</span>
				</div>
				{#if columns.length}
					<div class="flex flex-col gap-1.5">
						{#each columns as c, i (i)}
							<div class="grid grid-cols-[minmax(0,1fr)_8.5rem_auto_auto] items-center gap-2">
								<Input bind:value={c.name} placeholder="Field name" aria-label="Field name" class="h-8 text-sm" autocomplete="off" onblur={() => (c.name = columnSlug(c.name))} />
								<NativeSelect bind:value={c.type} size="sm" aria-label="Type of {c.name || 'the field'}" class="w-full">
									{#each COLUMN_TYPES as t (t)}<NativeSelectOption value={t}>{TYPE_LABELS[t]}</NativeSelectOption>{/each}
								</NativeSelect>
								<label class="flex items-center gap-1.5 text-xs text-muted-foreground" title="Every row must have a value">
									<Checkbox checked={c.required} onCheckedChange={(v) => (c.required = v === true)} aria-label="{c.name || 'Field'} is required" />
									Required
								</label>
								<Button variant="ghost" size="icon-sm" aria-label="Remove {c.name || 'field'}" onclick={() => (columns = columns.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>
							</div>
						{/each}
					</div>
				{:else}
					<p class="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">No fields yet. Rows can hold anything; add fields to give them a type.</p>
				{/if}
				<div>
					<Button variant="ghost" size="sm" class="-ml-2" onclick={() => (columns = [...columns, { name: '', type: 'string', required: false }])}><PlusIcon class="size-4" /> Add field</Button>
				</div>
			</div>

			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" disabled={busy || !id || !!idProblem}>Create table</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
