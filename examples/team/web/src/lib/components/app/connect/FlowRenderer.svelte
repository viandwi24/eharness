<script lang="ts">
	import type { Connection } from '#lib/api/index.js';
	import type { FlowSession } from '#lib/connectors/flow-core.js';
	import { canGoBack, flowEndedBadly, flowSucceeded } from '#lib/connectors/flow-view.js';
	import FlowChoose from './FlowChoose.svelte';
	import FlowConfirm from './FlowConfirm.svelte';
	import FlowDeviceCode from './FlowDeviceCode.svelte';
	import FlowError from './FlowError.svelte';
	import FlowForm from './FlowForm.svelte';
	import FlowOAuth from './FlowOAuth.svelte';
	import FlowStatus from './FlowStatus.svelte';

	/**
	 * Renders the current view of a connect flow by `type`, one component per kind. `cancel` ends the
	 * flow (`onClose`); a successful flow calls `onDone` from its Done button.
	 */
	let { session, onDone, onClose }: { session: FlowSession; onDone: (connection: Connection) => void; onClose: () => void } = $props();

	const st = $derived(session.state);
	const flow = $derived(st.flow);
	const view = $derived(flow?.view);
	// Back is offered on every step but the first
	let firstStep = $state<string | undefined>();
	$effect(() => {
		if (firstStep === undefined && view) firstStep = view.step;
	});
	const back = $derived(view ? canGoBack(view, firstStep) : false);
	const succeeded = $derived(flowSucceeded(flow, st.connection));

	const submit = (data?: Record<string, unknown>): Promise<void> => session.act('submit', data);
	const goBack = (): Promise<void> => session.act('back');
	async function cancel(): Promise<void> {
		await session.act('cancel');
		onClose();
	}
	function done(): void {
		if (st.connection) onDone(st.connection);
		onClose();
	}
</script>

<div class="flex flex-col gap-3">
	{#if st.error}<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-text" role="alert">{st.error}</p>{/if}
	{#if !view}
		{#if st.busy}
			<p class="py-6 text-center text-sm text-muted-foreground" role="status">Getting ready…</p>
		{:else}
			<div class="flex justify-end"><button type="button" class="text-sm underline" onclick={onClose}>Close</button></div>
		{/if}
	{:else if succeeded && view.type !== 'status'}
		<FlowStatus view={{ type: 'status', viewId: view.viewId, step: view.step, state: 'success', message: 'Agents can use it now.' }} accountLabel={st.connection?.accountLabel} onDone={done} onCancel={cancel} />
	{:else if flowEndedBadly(flow) && view.type !== 'error'}
		<FlowError view={{ type: 'error', viewId: view.viewId, step: view.step, message: 'This connection attempt ended.', retryable: false }} busy={false} canBack={false} onRetry={() => {}} onBack={() => {}} onCancel={onClose} />
	{:else}
		{#key view.viewId}
			{#if view.type === 'form'}
				<FlowForm {view} busy={st.busy} canBack={back} onSubmit={submit} onBack={goBack} onCancel={cancel} />
			{:else if view.type === 'oauth'}
				<FlowOAuth {session} {view} onCancel={cancel} />
			{:else if view.type === 'deviceCode'}
				<FlowDeviceCode {session} {view} onCancel={cancel} />
			{:else if view.type === 'choose'}
				<FlowChoose {view} busy={st.busy} canBack={back} onSubmit={submit} onBack={goBack} onCancel={cancel} />
			{:else if view.type === 'confirm'}
				<FlowConfirm {view} busy={st.busy} canBack={back} onConfirm={() => submit()} onBack={goBack} onCancel={cancel} />
			{:else if view.type === 'status'}
				<FlowStatus {view} accountLabel={st.connection?.accountLabel} onDone={done} onCancel={cancel} />
			{:else if view.type === 'error'}
				<FlowError {view} busy={st.busy} canBack={back} onRetry={() => session.act('retry')} onBack={goBack} onCancel={cancel} />
			{/if}
		{/key}
	{/if}
</div>
