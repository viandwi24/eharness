<script lang="ts">
	import { goto } from '$app/navigation';
	import { api, ApiError } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import SchemaForm from '#lib/components/app/SchemaForm.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { type BrowserAdapter, type BrowserProfile, parseDomains } from '#lib/browser/model.js';
	import { buildSettings, initialValues, type FormValues } from '#lib/providers/form.js';

	/** Name, allowed domains, the adapter form (edit) and delete. */
	let { profile, adapter, onChange, onDeleted }: { profile: BrowserProfile; adapter: BrowserAdapter | undefined; onChange: (p: BrowserProfile) => void; onDeleted: () => void } = $props();

	const fields = $derived(adapter?.forms[profile.mode]?.fields ?? []);
	let name = $state('');
	let domains = $state('');
	let values = $state<FormValues>({});
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let confirmDelete = $state(false);
	let loadedFor = '';

	// reset the draft when another profile (or its saved version) arrives
	$effect(() => {
		const key = `${profile.id}:${profile.updatedAt}`;
		if (key === loadedFor) return;
		loadedFor = key;
		name = profile.name;
		domains = (profile.allowDomains ?? []).join('\n');
		values = initialValues(fields, profile.settings);
		errors = {};
	});

	async function save(): Promise<void> {
		const built = buildSettings(fields, values, profile.settings, 'edit');
		if (!built.ok) {
			errors = built.errors;
			return;
		}
		errors = {};
		busy = true;
		try {
			const p = await api.patch('/browser/profiles/{id}', { params: { id: profile.id }, body: { name: name.trim(), allowDomains: parseDomains(domains), settings: built.settings } });
			onChange(p);
			toast.success('Saved');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save');
		} finally {
			busy = false;
		}
	}
	async function remove(): Promise<void> {
		try {
			await api.delete('/browser/profiles/{id}', { params: { id: profile.id } });
			toast.success('Profile deleted');
			onDeleted();
			void goto('/browser');
		} catch (e) {
			toast.error(e instanceof ApiError && e.status === 409 ? 'An agent connection still uses this profile. Remove it there first.' : e instanceof Error ? e.message : 'Could not delete');
		}
	}
</script>

<section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Settings" data-testid="browser-settings">
	<h2 class="text-sm font-medium">Settings</h2>
	<label class="flex flex-col gap-1"><span class="text-xs font-medium">Name</span><Input bind:value={name} maxlength={80} /></label>
	<label class="flex flex-col gap-1">
		<span class="text-xs font-medium">Allowed domains</span>
		<Textarea bind:value={domains} rows={3} placeholder={'example.com\n*.example.org'} data-testid="allow-domains" />
		<span class="text-xs text-muted-foreground">One per line. Empty: any public site.</span>
	</label>
	{#if fields.length > 0}<SchemaForm {fields} bind:values current={profile.settings} {errors} idPrefix="bp" />{/if}
	<div class="flex justify-between gap-2">
		<Button size="sm" variant="ghost" class="text-destructive-text" onclick={() => (confirmDelete = true)} data-testid="delete-profile">Delete…</Button>
		<Button size="sm" disabled={busy || name.trim() === ''} onclick={() => void save()} data-testid="save-profile">Save</Button>
	</div>
</section>

<ConfirmDialog bind:open={confirmDelete} title="Delete {profile.name}?" description="This stops its browser and deletes its saved logins. It cannot be undone." onConfirm={remove} />
