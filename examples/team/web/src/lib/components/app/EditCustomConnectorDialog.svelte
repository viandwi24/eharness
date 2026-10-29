<script lang="ts">
	import type { Connection, Connector } from '#lib/api/index.js';
	import SchemaForm from '#lib/components/app/SchemaForm.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { editPatch, editValues } from '#lib/connectors/edit.js';
	import type { FormValues } from '#lib/providers/form.js';

	/**
	 * Edit a saved custom connector: server URL, authentication, headers and the advanced options,
	 * from the connector's own field list. Stored secrets show as saved and are kept when left blank.
	 * Saving tests the connection again (the server lists the tools), unless a sign in is now needed.
	 */
	let {
		open = $bindable(false),
		connection,
		connector,
		onSaved
	}: {
		open?: boolean;
		connection: Connection | undefined;
		connector: Connector | undefined;
		/** Saved; the connection as it is now (status after the test). */
		onSaved?: (connection: Connection) => void;
	} = $props();

	let values = $state<FormValues>({});
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);
	const fields = $derived(connector?.fields ?? []);

	// fresh values every time the dialog opens
	let openedFor = $state<string | null>(null);
	$effect(() => {
		if (!open) {
			openedFor = null;
			return;
		}
		if (connection && openedFor !== connection.id) {
			openedFor = connection.id;
			values = editValues(fields, connection.settings);
			errors = {};
			formError = '';
		}
	});

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!connection) return;
		formError = '';
		const built = editPatch(fields, values, connection.settings);
		if (!built.ok) {
			errors = built.errors;
			return;
		}
		errors = {};
		saving = true;
		try {
			const next = await connectorsStore.update(connection.id, { settings: built.settings });
			open = false;
			if (next.status === 'needs-auth') toast.success(`${next.label} saved. Sign in to finish.`);
			else if (next.status === 'error') toast.error(`${next.label} saved, but the test failed${next.statusMessage ? `: ${next.statusMessage}` : '.'}`);
			else toast.success(`${next.label} saved and connected`);
			onSaved?.(next);
		} catch (err) {
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="gap-1 border-b border-border px-5 py-4 pr-12">
			<Dialog.Title>Edit {connection?.label ?? 'connector'}</Dialog.Title>
			<Dialog.Description>Change the server URL, how it signs in and its headers. Saved values stay unless you type new ones.</Dialog.Description>
		</Dialog.Header>
		<form class="flex min-h-0 flex-1 flex-col" onsubmit={save} novalidate data-testid="edit-connector">
			<div class="flex flex-col gap-4 overflow-y-auto px-5 py-4">
				{#if formError}<p class="text-sm text-destructive-text" role="alert">{formError}</p>{/if}
				<!-- rendered once the values are filled: the radio group may not bind to undefined -->
				{#if fields.length > 0 && connection !== undefined && openedFor === connection.id}
					<SchemaForm {fields} bind:values current={connection?.settings} {errors} idPrefix="ec" disabled={saving} />
				{/if}
			</div>
			<Dialog.Footer class="border-t border-border px-5 py-3">
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" disabled={saving || !connection}>
					{#if saving}<Spinner class="size-4" />Saving and testing…{:else}Save{/if}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
