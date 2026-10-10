<script lang="ts">
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import FlowRenderer from '#lib/components/app/connect/FlowRenderer.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { Connection } from '#lib/api/index.js';
	import { isFinished } from '#lib/connectors/flow-core.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { newFlowSession } from '#lib/connectors/flow.svelte.js';

	/**
	 * The connect flow of a connector in a modal (Claude-style): a server-driven flow rendered by
	 * `FlowRenderer`. State is remounted on every open; closing while the flow runs cancels it.
	 */
	let {
		open = $bindable(false),
		definitionId,
		connectionId,
		scope = 'workspace',
		scopeId,
		label,
		defaultEnabled,
		flowId,
		signIn = false,
		onDone
	}: {
		open?: boolean;
		/** Connect a new connection of this connector… */
		definitionId?: string;
		/** …or re-authorize this connection (reconnect). */
		connectionId?: string;
		scope?: 'workspace' | 'agent';
		/** The agent id (agent scope). */
		scopeId?: string;
		label?: string;
		/** Workspace scope: available to all agents. */
		defaultEnabled?: boolean;
		/** Resume a flow that already exists (the OAuth redirect lands on `/connectors?flow=<id>`). */
		flowId?: string;
		/** A custom connector waiting for its sign in: "Sign in to <label>" instead of "Reconnect". */
		signIn?: boolean;
		/** Called with the saved connection when the flow finished successfully. */
		onDone?: (connection: Connection) => void;
	} = $props();

	const session = newFlowSession();
	let generation = $state(0);
	let started = false;

	const name = $derived((definitionId ? connectorsStore.connector(definitionId)?.name : undefined) ?? session.state.flow?.label ?? 'connector');
	const title = $derived(signIn ? `Sign in to ${label ?? name}` : connectionId ? `Reconnect ${label ?? name}` : `Connect ${name}`);

	$effect(() => {
		if (open && !started) {
			started = true;
			generation += 1;
			session.reset();
			if (flowId) void session.resume(flowId);
			else void session.start({ definitionId, connectionId, scope, scopeId, label, defaultEnabled });
		} else if (!open && started) {
			started = false;
			// closing mid-flow cancels it (best effort), then the session is cleared
			const flow = session.state.flow;
			if (flow && !isFinished(flow)) void session.act('cancel').catch(() => {}).finally(() => session.reset());
			else session.reset();
		}
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
		<Dialog.Header class="flex-row items-center gap-3 border-b border-border px-5 py-4 pr-12">
			<ConnectorIcon icon={definitionId ? connectorsStore.connector(definitionId)?.icon : undefined} size="sm" />
			<div class="min-w-0">
				<Dialog.Title class="truncate text-[15px]">{title}</Dialog.Title>
				<Dialog.Description class="text-xs">Only takes a moment. Nothing is shared until you finish.</Dialog.Description>
			</div>
		</Dialog.Header>
		<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
			{#key generation}
				<FlowRenderer {session} onDone={(c) => onDone?.(c)} onClose={() => (open = false)} />
			{/key}
		</div>
	</Dialog.Content>
</Dialog.Root>
