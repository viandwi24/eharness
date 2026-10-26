<script lang="ts">
	import { goto } from '$app/navigation';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRight';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import ShareFatIcon from 'phosphor-svelte/lib/ShareFat';
	import ChatTextIcon from 'phosphor-svelte/lib/ChatText';
	import TableIcon from 'phosphor-svelte/lib/Table';
	import HashIcon from 'phosphor-svelte/lib/Hash';
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import RobotIcon from 'phosphor-svelte/lib/Robot';
	import CodeIcon from 'phosphor-svelte/lib/Code';
	import WebhooksLogoIcon from 'phosphor-svelte/lib/WebhooksLogo';
	import CheckSquareIcon from 'phosphor-svelte/lib/CheckSquare';
	import { api } from '#lib/api/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import ChatPicker from '#lib/components/scripts/ChatPicker.svelte';
	import MonacoEditor from '#lib/components/scripts/MonacoEditor.svelte';
	import TagInput from '#lib/components/scripts/TagInput.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { createLookups } from '#lib/scripts/lookups.svelte.js';
	import { describeTrigger, fromManifest } from '#lib/scripts/manifest-model.js';
	import { missingFields, type Recipe, RECIPES, type RecipeValues } from '#lib/scripts/recipes.js';
	import { SCRIPT_NAME } from '#lib/scripts/scripts.js';
	import { cn } from '#lib/utils.js';

	const lookups = createLookups();
	$effect(() => void lookups.load());

	const icons = { forward: ShareFatIcon, reply: ChatTextIcon, table: TableIcon, count: HashIcon, report: FileTextIcon, agent: RobotIcon, webhook: WebhooksLogoIcon, task: CheckSquareIcon, blank: CodeIcon } as const;

	let recipe = $state<Recipe | null>(null);
	let values = $state<RecipeValues>({});
	let name = $state('');
	let description = $state('');
	let descriptionTouched = $state(false);
	let saving = $state(false);
	let error = $state('');

	const built = $derived(recipe ? recipe.build(values) : null);
	const missing = $derived(recipe ? missingFields(recipe, values) : []);
	const triggerLines = $derived(built ? fromManifest(built.manifest).triggers.map(describeTrigger) : []);
	const grantLines = $derived.by(() => {
		if (!built) return [];
		const g = (built.manifest.grants ?? {}) as Record<string, unknown>;
		const out: string[] = [];
		for (const s of (g.send as { chat: string }[] | undefined) ?? []) out.push(`Send messages to ${s.chat || '?'}`);
		if (g.reply) out.push('Reply in the chat of the message');
		for (const t of (g.tablesWrite as string[] | undefined) ?? []) out.push(`Read and change table ${t || '?'}`);
		for (const t of (g.tablesRead as string[] | undefined) ?? []) out.push(`Read table ${t || '?'}`);
		for (const p of (g.libraryWrite as string[] | undefined) ?? []) out.push(`Write library files in ${p}`);
		for (const a of (g.wake as string[] | undefined) ?? []) out.push(`Wake agent ${a || '?'} (paid)`);
		return out;
	});
	const nameOk = $derived(SCRIPT_NAME.test(name.trim()) && name.trim() !== 'new');

	$effect(() => {
		if (built && !descriptionTouched) description = built.description;
	});

	function pick(r: Recipe): void {
		recipe = r;
		values = {};
		name = r.name;
		descriptionTouched = false;
		error = '';
		window.scrollTo({ top: 0 });
	}

	async function create(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!recipe || !built) return;
		error = '';
		if (!nameOk) {
			error = 'The name: lowercase letters, digits and -, starting with a letter.';
			return;
		}
		saving = true;
		try {
			const s = await api.post('/scripts', {
				body: { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), source: built.source, manifest: built.manifest, note: `from "${recipe.title}"` }
			});
			toast.success(`${s.name} created. Test it, then turn it on.`);
			void goto(`/scripts/${encodeURIComponent(s.name)}?test=1`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the script';
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="New script" description={recipe ? recipe.summary : 'Pick what it should do. You can change everything afterwards.'} breadcrumb={[{ label: 'Scripts', href: '/scripts' }]} backHref="/scripts" />

	<PageBody size="wide" class="gap-6">
		{#if !recipe}
			<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each RECIPES as r (r.id)}
					{@const Icon = icons[r.icon]}
					<button
						type="button"
						class={cn('group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none', r.id === 'blank' && 'border-dashed')}
						onclick={() => pick(r)}
					>
						<span class="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground"><Icon class="size-5" /></span>
						<span class="flex flex-col gap-1">
							<span class="text-sm font-semibold">{r.title}</span>
							<span class="text-xs leading-relaxed text-muted-foreground">{r.summary}</span>
						</span>
						<span class="mt-auto inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">Use this <ArrowRightIcon class="size-3" /></span>
					</button>
				{/each}
			</div>
			<p class="text-xs text-muted-foreground">Or ask an agent in a chat: “write a script that …”. It writes and tests it, and you approve it here.</p>
		{:else}
			<form class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" onsubmit={create}>
				<div class="flex flex-col gap-5">
					<button type="button" class="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onclick={() => (recipe = null)}><ArrowLeftIcon class="size-3" /> Other recipes</button>

					{#each recipe.fields as f (f.key)}
						<Field.Field>
							<Field.Label for="rf-{f.key}">{f.label}{'optional' in f && f.optional ? '' : ' *'}</Field.Label>
							{#if f.kind === 'chat'}
								<ChatPicker id="rf-{f.key}" {lookups} allowAny={recipe.id === 'reply'} bind:value={() => (values[f.key] as never) ?? { connection: '', chat: '' }, (v) => (values[f.key] = v)} />
							{:else if f.kind === 'words'}
								<TagInput id="rf-{f.key}" label={f.label} bind:values={() => (values[f.key] as string[]) ?? [], (v) => (values[f.key] = v)} placeholder="Type a word, press Enter" />
							{:else if f.kind === 'table'}
								<NativeSelect id="rf-{f.key}" class="w-64" value={(values[f.key] as string) ?? ''} onchange={(e) => (values[f.key] = e.currentTarget.value)}>
									<NativeSelectOption value="">Pick a table…</NativeSelectOption>
									{#each lookups.state.tables as t (t.value)}<NativeSelectOption value={t.value}>{t.label}</NativeSelectOption>{/each}
								</NativeSelect>
								{#if lookups.state.loaded && !lookups.state.tables.length}<Field.Description>No tables yet. <a class="underline underline-offset-4" href="/tables">Create one</a> first.</Field.Description>{/if}
							{:else if f.kind === 'agent'}
								<NativeSelect id="rf-{f.key}" class="w-64" value={(values[f.key] as string) ?? ''} onchange={(e) => (values[f.key] = e.currentTarget.value)}>
									<NativeSelectOption value="">Pick an agent…</NativeSelectOption>
									{#each lookups.state.agents as a (a.value)}<NativeSelectOption value={a.value}>{a.label}</NativeSelectOption>{/each}
								</NativeSelect>
							{:else if f.kind === 'time'}
								<Input id="rf-{f.key}" type="time" class="w-32" value={(values[f.key] as string) ?? '23:00'} oninput={(e) => (values[f.key] = e.currentTarget.value)} />
							{:else if f.multiline}
								<Textarea id="rf-{f.key}" rows={3} placeholder={f.placeholder} value={(values[f.key] as string) ?? ''} oninput={(e) => (values[f.key] = e.currentTarget.value)} />
							{:else}
								<Input id="rf-{f.key}" placeholder={f.placeholder} value={(values[f.key] as string) ?? ''} oninput={(e) => (values[f.key] = e.currentTarget.value)} autocomplete="off" />
							{/if}
							{#if f.help}<Field.Description>{f.help}</Field.Description>{/if}
						</Field.Field>
					{/each}

					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field data-invalid={!!name && !nameOk}>
							<Field.Label for="new-name">Name *</Field.Label>
							<Input id="new-name" bind:value={name} class="font-mono text-xs" autocomplete="off" />
							<Field.Description>lowercase-with-dashes</Field.Description>
						</Field.Field>
						<Field.Field>
							<Field.Label for="new-desc">Description</Field.Label>
							<Input id="new-desc" bind:value={description} oninput={() => (descriptionTouched = true)} autocomplete="off" />
						</Field.Field>
					</div>

					{#if triggerLines.length || grantLines.length}
						<div class="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
							{#if triggerLines.length}<p><span class="text-muted-foreground">Runs when:</span> {triggerLines.join('; ')}</p>{:else}<p class="text-muted-foreground">Runs only when you press Run now.</p>{/if}
							{#if grantLines.length}
								<div><span class="text-muted-foreground">Allowed to:</span><ul class="mt-1 list-disc pl-5">{#each grantLines as g (g)}<li>{g}</li>{/each}</ul></div>
							{/if}
						</div>
					{/if}

					{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
					<div class="flex flex-wrap items-center gap-3">
						<Button type="submit" disabled={saving || missing.length > 0 || !nameOk}>{#if saving}<Spinner class="size-4" />{/if} Create and test</Button>
						{#if missing.length}<span class="text-xs text-muted-foreground">Still needed: {missing.join(', ')}</span>{:else}<span class="text-xs text-muted-foreground">It starts switched off. Nothing runs until you turn it on.</span>{/if}
					</div>
				</div>

				<div class="flex min-w-0 flex-col gap-2">
					<span class="text-xs font-medium text-muted-foreground">The code it writes (editable after creating)</span>
					{#key recipe.id}
						<MonacoEditor path="file:///preview/{recipe.id}.ts" language="typescript" value={built?.source ?? ''} readOnly label="Code preview" class="h-[28rem] xl:h-[calc(100dvh-14rem)]" />
					{/key}
				</div>
			</form>
		{/if}
	</PageBody>
</div>
