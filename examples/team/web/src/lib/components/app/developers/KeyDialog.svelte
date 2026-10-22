<script lang="ts">
	import { untrack } from 'svelte';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import { api } from '#lib/api/index.js';
	import { copyText } from '#lib/clipboard.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { splitList, type ApiAgent, type ApiKeyView } from '#lib/developers/model.js';

	let {
		open = $bindable(false),
		key,
		agents,
		onSaved,
		onCreated
	}: { open?: boolean; key?: ApiKeyView | undefined; agents: ApiAgent[]; onSaved: () => void; onCreated?: (secret: string, view: ApiKeyView) => void } = $props();

	let name = $state('');
	let picked = $state<string[]>([]);
	let dailyCost = $state('');
	let rate = $state('');
	let origins = $state('');
	let expires = $state('');
	let saving = $state(false);
	let error = $state('');
	/** The key, once, after it was created. */
	let secret = $state('');

	const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			name = key?.name ?? '';
			picked = [...(key?.agents ?? [])];
			dailyCost = key?.dailyCostLimitUsd == null ? '' : String(key.dailyCostLimitUsd);
			rate = key?.rateLimitPerMin == null ? '' : String(key.rateLimitPerMin);
			origins = (key?.origins ?? []).join('\n');
			expires = key?.expiresAt == null ? '' : day(key.expiresAt);
			error = '';
			secret = '';
		});
	});

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		saving = true;
		error = '';
		const body = {
			name: name.trim(),
			agents: picked,
			dailyCostLimitUsd: dailyCost.trim() === '' ? null : Number(dailyCost),
			rateLimitPerMin: rate.trim() === '' ? null : Number(rate),
			origins: splitList(origins),
			// the end of the chosen day (UTC)
			expiresAt: expires === '' ? null : Date.parse(`${expires}T23:59:59Z`)
		};
		try {
			if (key) {
				await api.patch('/developer/keys/{id}', { params: { id: key.id }, body });
				toast.success('Key saved');
				open = false;
				onSaved();
			} else {
				const created = await api.post('/developer/keys', { body });
				secret = created.key;
				onCreated?.(created.key, created.view);
				onSaved();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not save the key';
		} finally {
			saving = false;
		}
	}

	function toggle(slug: string, on: boolean): void {
		picked = on ? [...picked, slug] : picked.filter((s) => s !== slug);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{secret ? 'Your new key' : key ? 'Edit key' : 'New API key'}</Dialog.Title>
			<Dialog.Description>{secret ? 'Copy it now. It is shown once; only a hash is stored.' : 'A key opens only the API agents you pick, within its limits.'}</Dialog.Description>
		</Dialog.Header>
		{#if secret}
			<div class="flex flex-col gap-3 px-5 py-4 text-sm" data-testid="new-key">
				<div class="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2">
					<code class="min-w-0 flex-1 break-all font-mono text-xs" data-testid="new-key-secret">{secret}</code>
					<Button type="button" size="sm" variant="outline" onclick={() => void copyText(secret).then(() => toast.success('Key copied'))}><CopyIcon class="size-4" /> Copy</Button>
				</div>
				<p class="text-xs text-muted-foreground">Keep it on your server. A key in browser code is visible to everyone who opens the page: give it origins and a low daily limit.</p>
			</div>
			<Dialog.Footer class="border-t border-border px-5 py-3"><Button type="button" onclick={() => (open = false)}>Done</Button></Dialog.Footer>
		{:else}
			<form id="api-key-form" onsubmit={save} class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-sm">
				<label class="flex flex-col gap-1">
					<span class="font-medium">Name</span>
					<Input bind:value={name} required maxlength={80} placeholder="Marketing site" data-testid="key-name" />
				</label>
				<div class="flex flex-col gap-1">
					<span class="font-medium">API agents it can call</span>
					{#if agents.length === 0}
						<p class="text-xs text-muted-foreground">Create an API agent first.</p>
					{:else}
						{#each agents as a (a.id)}
							<label class="flex cursor-pointer items-center gap-2 py-0.5">
								<Checkbox checked={picked.includes(a.slug)} onCheckedChange={(v) => toggle(a.slug, v === true)} aria-label={a.name} />
								<span>{a.name}</span><span class="font-mono text-xs text-muted-foreground">{a.slug}</span>
							</label>
						{/each}
					{/if}
				</div>
				<div class="grid grid-cols-2 gap-3">
					<label class="flex flex-col gap-1">
						<span class="font-medium">Daily cost limit (USD)</span>
						<Input type="number" min={0} step="0.01" bind:value={dailyCost} placeholder="No limit" />
					</label>
					<label class="flex flex-col gap-1">
						<span class="font-medium">Requests per minute</span>
						<Input type="number" min={1} step={1} bind:value={rate} placeholder="No limit" />
					</label>
				</div>
				<label class="flex flex-col gap-1">
					<span class="font-medium">Browser origins (CORS)</span>
					<Textarea bind:value={origins} rows={2} placeholder="https://www.example.com" class="font-mono text-xs" />
					<span class="text-xs text-muted-foreground">One per line. Empty: the key works from servers only; browsers are refused.</span>
				</label>
				<label class="flex flex-col gap-1">
					<span class="font-medium">Expires (optional)</span>
					<Input type="date" bind:value={expires} class="max-w-48" />
				</label>
				{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			</form>
			<Dialog.Footer class="border-t border-border px-5 py-3">
				<Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" form="api-key-form" disabled={saving || picked.length === 0} data-testid="key-save">{#if saving}<Spinner class="size-4" />{/if}{key ? 'Save' : 'Create key'}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
