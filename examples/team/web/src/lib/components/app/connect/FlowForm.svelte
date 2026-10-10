<script lang="ts">
	import FlowFooter from './FlowFooter.svelte';
	import SchemaForm from '#lib/components/app/SchemaForm.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formPayload, friendlyError, repeatsDialogTitle } from '#lib/connectors/flow-view.js';
	import type { FlowView } from '#lib/api/index.js';
	import { initialValues, type FormValues } from '#lib/providers/form.js';

	let {
		view,
		busy,
		canBack,
		onSubmit,
		onBack,
		onCancel
	}: {
		view: Extract<FlowView, { type: 'form' }>;
		busy: boolean;
		canBack: boolean;
		onSubmit: (data: Record<string, unknown>) => void;
		onBack: () => void;
		onCancel: () => void;
	} = $props();

	// the component is keyed by viewId: a new view (server-side errors) starts from the values it carries
	// svelte-ignore state_referenced_locally
	let values = $state<FormValues>(initialValues(view.fields, view.values));
	let local = $state<Record<string, string>>({});
	const errors = $derived(Object.fromEntries(Object.entries({ ...(view.errors ?? {}), ...local }).map(([k, v]) => [k, friendlyError(v)])));

	function submit(e: SubmitEvent): void {
		e.preventDefault();
		const r = formPayload(view.fields, values, view.values);
		if (!r.ok) {
			local = r.errors;
			return;
		}
		local = {};
		onSubmit(r.data);
	}
</script>

<form class="flex flex-col gap-4" onsubmit={submit}>
	<div class="flex flex-col gap-1">
		{#if !repeatsDialogTitle(view.title)}<h3 class="text-sm font-medium">{view.title}</h3>{/if}
		{#if view.description}<p class="text-[13px] text-muted-foreground">{view.description}</p>{/if}
	</div>
	<SchemaForm fields={view.fields} bind:values current={view.values} {errors} idPrefix="cf" disabled={busy} />
	{#if view.message}<p class="text-sm text-destructive-text" role="alert">{view.message}</p>{/if}
	<FlowFooter>
		<Button type="button" variant="ghost" onclick={onCancel} disabled={busy}>Cancel</Button>
		{#if canBack}<Button type="button" variant="outline" onclick={onBack} disabled={busy}>Back</Button>{/if}
		<Button type="submit" disabled={busy}>{#if busy}<Spinner class="size-4" />{/if}{view.submitLabel}</Button>
	</FlowFooter>
</form>
