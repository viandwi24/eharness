<script lang="ts">
	import { untrack } from 'svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/**
	 * A destructive confirmation that waits for the action: an optional extra choice (`option`)
	 * and, for the worst ones, typing a word (`typeToConfirm`). `onConfirm` returns an error or null.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Delete',
		option,
		optionChecked = $bindable(false),
		typeToConfirm,
		onConfirm
	}: {
		open?: boolean;
		title: string;
		description: string;
		confirmLabel?: string;
		option?: string;
		optionChecked?: boolean;
		typeToConfirm?: string;
		onConfirm: () => Promise<string | null>;
	} = $props();

	let typed = $state('');
	let error = $state('');
	let busy = $state(false);

	$effect(() => {
		if (open)
			untrack(() => {
				typed = '';
				error = '';
			});
	});

	async function go(): Promise<void> {
		busy = true;
		error = '';
		try {
			const e = await onConfirm();
			if (e) error = e;
			else open = false;
		} finally {
			busy = false;
		}
	}
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content elevation="floating">
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description>{description}</AlertDialog.Description>
		</AlertDialog.Header>
		{#if option}
			<label class="flex items-start gap-2 text-sm">
				<Checkbox checked={optionChecked} onCheckedChange={(v) => (optionChecked = v === true)} class="mt-0.5" />
				<span>{option}</span>
			</label>
		{/if}
		{#if typeToConfirm}
			<div class="flex flex-col gap-1.5">
				<label for="confirm-typed" class="text-sm">Type <code class="rounded bg-muted px-1 font-mono text-xs">{typeToConfirm}</code> to confirm</label>
				<Input id="confirm-typed" bind:value={typed} autocomplete="off" class="font-mono text-sm" />
			</div>
		{/if}
		{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={busy}>Cancel</AlertDialog.Cancel>
			<Button variant="destructive" disabled={busy || (!!typeToConfirm && typed.trim() !== typeToConfirm)} onclick={() => void go()}>{#if busy}<Spinner />{/if}{confirmLabel}</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
