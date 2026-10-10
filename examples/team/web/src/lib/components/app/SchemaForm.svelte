<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as RadioGroup from '#lib/components/ui/radio-group/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { controlOf, GROUP_LABEL, groupFields, isVisible, secretOfField, type FormField, type FormValues, type RecordRow } from '#lib/providers/form.js';

	/**
	 * A form rendered from a generic field list (the `fields` of `GET /providers`, the `FormField`
	 * of `eharness/providers`): text, password (secrets), number, select / radio enums, switches,
	 * key-value editors (secret values), JSON, groups with "Advanced" collapsed, `showWhen`.
	 * It only edits `values`; `buildSettings` (providers/form.ts) turns them into a request body.
	 * Reused for any configurable thing (provider profiles today, connectors later).
	 */
	let {
		fields,
		values = $bindable({}),
		current,
		errors = {},
		idPrefix = 'sf',
		disabled = false
	}: {
		fields: FormField[];
		values: FormValues;
		/** The stored settings, redacted: secrets are `{ set, hint }` and show "keep current". */
		current?: Record<string, unknown>;
		/** Messages by field path. */
		errors?: Record<string, string>;
		idPrefix?: string;
		disabled?: boolean;
	} = $props();

	const groups = $derived(groupFields(fields));
	const visible = (f: FormField): boolean => isVisible(f, values);
	const id = (f: FormField): string => `${idPrefix}-${f.path.replaceAll('.', '-')}`;

	function rows(f: FormField): RecordRow[] {
		const v = values[f.path];
		return Array.isArray(v) ? v : [];
	}
	function addRow(f: FormField): void {
		values[f.path] = [...rows(f), { key: '', value: '', stored: false }];
	}
	function removeRow(f: FormField, i: number): void {
		values[f.path] = rows(f).filter((_, n) => n !== i);
	}

	function passwordPlaceholder(f: FormField): string {
		const s = secretOfField(current, f.path);
		if (s?.set) return `${s.hint ?? 'Saved'}: leave empty to keep the current value`;
		return f.placeholder ?? '';
	}

	// "Advanced" opens by itself when something in it has a value or an error
	const advancedFilled = (list: FormField[]): boolean =>
		list.some((f) => !!errors[f.path] || (Array.isArray(values[f.path]) ? (values[f.path] as RecordRow[]).length > 0 : f.group === 'advanced' && values[f.path] !== '' && values[f.path] !== false && values[f.path] !== undefined && values[f.path] !== f.default));
	let advancedOpen = $state<boolean | undefined>(undefined);
</script>

{#snippet control(f: FormField)}
	{@const c = controlOf(f)}
	{@const err = errors[f.path]}
	{#if c === 'password'}
		<Input id={id(f)} type="password" autocomplete="new-password" bind:value={values[f.path] as never} placeholder={passwordPlaceholder(f)} {disabled} aria-invalid={!!err} />
	{:else if c === 'text'}
		<Input id={id(f)} bind:value={values[f.path] as never} placeholder={f.placeholder} {disabled} aria-invalid={!!err} />
	{:else if c === 'number'}
		<Input id={id(f)} type="number" inputmode="decimal" min={f.min} max={f.max} bind:value={values[f.path] as never} placeholder={f.placeholder} {disabled} aria-invalid={!!err} class="max-w-40" />
	{:else if c === 'textarea'}
		<Textarea id={id(f)} rows={4} bind:value={values[f.path] as never} placeholder={f.placeholder} {disabled} aria-invalid={!!err} />
	{:else if c === 'json'}
		<Textarea id={id(f)} rows={4} bind:value={values[f.path] as never} placeholder={f.placeholder ?? '{}'} {disabled} aria-invalid={!!err} class="font-mono text-xs" />
	{:else if c === 'select'}
		<NativeSelect id={id(f)} bind:value={values[f.path] as never} {disabled} class="w-full max-w-sm">
			{#if !f.required}<NativeSelectOption value="">Default</NativeSelectOption>{/if}
			{#each f.options ?? [] as o (String(o.value))}
				<NativeSelectOption value={String(o.value)}>{o.label}</NativeSelectOption>
			{/each}
		</NativeSelect>
	{:else if c === 'radio'}
		<RadioGroup.Root bind:value={values[f.path] as never} {disabled} class="flex flex-wrap gap-x-5 gap-y-2" aria-label={f.label}>
			{#each f.options ?? [] as o (String(o.value))}
				<label class="flex items-center gap-2 text-sm">
					<RadioGroup.Item value={String(o.value)} />
					{o.label}
				</label>
			{/each}
		</RadioGroup.Root>
	{:else if c === 'switch'}
		<Switch id={id(f)} bind:checked={values[f.path] as never} {disabled} aria-label={f.label} />
	{:else if c === 'keyvalue'}
		<div class="flex flex-col gap-2">
			{#each rows(f) as row, i (i)}
				<div class="flex items-center gap-2">
					<Input bind:value={row.key} placeholder="Name" aria-label="{f.label} name" {disabled} class="w-2/5 font-mono text-xs" />
					<Input
						bind:value={row.value}
						type={f.secretValues ? 'password' : 'text'}
						autocomplete="off"
						placeholder={row.stored ? 'Saved: leave empty to keep' : 'Value'}
						aria-label="{f.label} value"
						{disabled}
						class="min-w-0 flex-1 font-mono text-xs"
					/>
					<Button type="button" variant="ghost" size="icon-sm" onclick={() => removeRow(f, i)} {disabled} aria-label="Remove {row.key || 'row'}"><XIcon class="size-4" /></Button>
				</div>
			{/each}
			<div><Button type="button" variant="outline" size="sm" onclick={() => addRow(f)} {disabled}><PlusIcon class="size-3.5" />Add {f.secretValues ? 'header' : 'row'}</Button></div>
		</div>
	{/if}
{/snippet}

{#snippet fieldBlock(f: FormField)}
	{@const c = controlOf(f)}
	<Field.Field data-invalid={!!errors[f.path]} orientation={c === 'switch' ? 'horizontal' : 'vertical'}>
		{#if c === 'switch'}
			<Field.Content>
				<Field.Label for={id(f)}>{f.label}</Field.Label>
				{#if f.description}<Field.Description>{f.description}</Field.Description>{/if}
			</Field.Content>
			{@render control(f)}
		{:else}
			<Field.Label for={id(f)}>
				{f.label}{#if f.required}<span class="text-muted-foreground" title="Required"> *</span>{/if}
			</Field.Label>
			{@render control(f)}
			{#if f.description || f.envHint}
				<Field.Description>
					{f.description ?? ''}{#if f.envHint}{f.description ? ' ' : ''}<span class="font-mono">{f.envHint}</span> supplies it in the environment.{/if}
				</Field.Description>
			{/if}
		{/if}
		{#if errors[f.path]}<Field.Error>{errors[f.path]}</Field.Error>{/if}
	</Field.Field>
{/snippet}

<Field.Group>
	{#each groups as g (g.group)}
		{@const shown = g.fields.filter(visible)}
		{#if shown.length > 0}
			{#if g.group === 'advanced'}
				<Collapsible.Root open={advancedOpen ?? advancedFilled(g.fields)} onOpenChange={(o) => (advancedOpen = o)}>
					<Collapsible.Trigger class="group/adv flex h-8 items-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
						<CaretRightIcon class="size-3.5 transition-transform group-data-[state=open]/adv:rotate-90" />
						{GROUP_LABEL.advanced}
					</Collapsible.Trigger>
					<Collapsible.Content class="mt-3 flex flex-col gap-5">
						{#each shown as f (f.path)}{@render fieldBlock(f)}{/each}
					</Collapsible.Content>
				</Collapsible.Root>
			{:else}
				<div class="flex flex-col gap-5">
					{#each shown as f (f.path)}{@render fieldBlock(f)}{/each}
				</div>
			{/if}
		{/if}
	{/each}
</Field.Group>
