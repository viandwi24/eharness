<script lang="ts">
	import FlowFooter from './FlowFooter.svelte';
	import LinkedText from './LinkedText.svelte';
	import SchemaForm from '#lib/components/app/SchemaForm.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { canResend, formPayload, friendlyError, friendlyFields, repeatsDialogTitle, withoutStoredSecrets } from '#lib/connectors/flow-view.js';
	import type { FlowView } from '#lib/api/index.js';
	import { initialValues, type FormValues } from '#lib/providers/form.js';

	let {
		view,
		busy,
		canBack,
		onSubmit,
		onBack,
		onCancel,
		onResend,
		afterFailure = false
	}: {
		view: Extract<FlowView, { type: 'form' }>;
		busy: boolean;
		canBack: boolean;
		onSubmit: (data: Record<string, unknown>) => void;
		onBack: () => void;
		onCancel: () => void;
		onResend?: () => void;
		/** This form comes back after an attempt failed: a secret it carried was refused, so it starts empty. */
		afterFailure?: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	const shown = afterFailure ? withoutStoredSecrets(view.values) : view.values;

	// the component is keyed by viewId: a new view (server-side errors) starts from the values it carries
	// svelte-ignore state_referenced_locally
	let values = $state<FormValues>(initialValues(view.fields, shown));
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
		{#if view.description}<p class="text-[13px] text-muted-foreground"><LinkedText text={view.description} /></p>{/if}
	</div>
	<SchemaForm fields={friendlyFields(view.fields)} bind:values current={shown} {errors} idPrefix="cf" disabled={busy} />
	{#if onResend && canResend(view)}<div><Button type="button" variant="link" size="sm" class="h-auto px-0" onclick={onResend} disabled={busy} data-testid="flow-resend">Send the code again</Button></div>{/if}
	{#if view.message}<p class="text-sm text-destructive-text" role="alert">{view.message}</p>{/if}
	<FlowFooter>
		<Button type="button" variant="ghost" onclick={onCancel} disabled={busy}>Cancel</Button>
		{#if canBack}<Button type="button" variant="outline" onclick={onBack} disabled={busy}>Back</Button>{/if}
		<Button type="submit" disabled={busy}>{#if busy}<Spinner class="size-4" />{/if}{view.submitLabel}</Button>
	</FlowFooter>
</form>
