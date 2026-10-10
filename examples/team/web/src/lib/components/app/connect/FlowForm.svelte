<script lang="ts">
	import SchemaForm from '#lib/components/app/SchemaForm.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formPayload } from '#lib/connectors/flow-view.js';
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
	const errors = $derived({ ...(view.errors ?? {}), ...local });

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
		<h3 class="text-sm font-semibold">{view.title}</h3>
		{#if view.description}<p class="text-sm text-muted-foreground">{view.description}</p>{/if}
	</div>
	<SchemaForm fields={view.fields} bind:values current={view.values} {errors} idPrefix="cf" disabled={busy} />
	{#if view.message}<p class="text-sm text-destructive-text" role="alert">{view.message}</p>{/if}
	<div class="flex flex-wrap justify-end gap-2">
		<Button type="button" variant="ghost" onclick={onCancel} disabled={busy}>Cancel</Button>
		{#if canBack}<Button type="button" variant="outline" onclick={onBack} disabled={busy}>Back</Button>{/if}
		<Button type="submit" disabled={busy}>{#if busy}<Spinner class="size-4" />{/if}{view.submitLabel}</Button>
	</div>
</form>
