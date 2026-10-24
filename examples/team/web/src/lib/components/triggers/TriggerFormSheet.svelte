<script lang="ts">
	import { untrack } from 'svelte';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import ChatPicker from '#lib/components/triggers/ChatPicker.svelte';
	import EventTypePicker from '#lib/components/events/EventTypePicker.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { agentChoices } from '#lib/channels/model.js';
	import type { EventCatalog } from '#lib/events/events.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import {
		ACTION_KINDS,
		MAX_REGEX,
		MIN_SECRET,
		ROLES,
		WAKE_TARGETS,
		bodyFromForm,
		emptyForm,
		formFromTrigger,
		generateSecret,
		hasChannelType,
		hasMessageType,
		hasReactionType,
		parseList,
		validateForm,
		type ActionKind,
		type ActorRole,
		type Trigger,
		type TriggerForm,
		type WakeTarget
	} from '#lib/triggers/triggers.js';

	/** Create or edit a trigger: what it listens to, where, which events pass, and what it does. */
	let {
		open = $bindable(false),
		trigger = null,
		initial = null,
		catalog,
		programs,
		onSaved
	}: {
		open?: boolean;
		trigger?: Trigger | null;
		initial?: Partial<TriggerForm> | null;
		catalog: EventCatalog;
		programs: { id: string; name: string }[];
		onSaved: (t: Trigger) => void;
	} = $props();

	let form = $state<TriggerForm>(emptyForm());
	let actorsText = $state('');
	let wordsText = $state('');
	let emojiText = $state('');
	let cdValue = $state('0');
	let cdUnit = $state<'1' | '60' | '3600'>('1');
	let chatNames = $state<Record<string, string>>({});
	let saving = $state(false);
	let serverError = $state<string | null>(null);
	let showErrors = $state(false);
	let secretVisible = $state(false);

	const editing = $derived(trigger !== null);
	const errors = $derived(validateForm(form, { editing, hadSecret: trigger?.hasSecret ?? false }));
	const shownErrors = $derived(showErrors ? errors : ({} as Record<string, string>));
	const messageType = $derived(hasMessageType(form.eventTypes));
	const reactionType = $derived(hasReactionType(form.eventTypes));
	const channelType = $derived(hasChannelType(form.eventTypes, catalog.types));
	const fieldNames = $derived([...new Set(catalog.types.filter((t) => form.eventTypes.includes(t.type)).flatMap((t) => t.fields))]);
	const agents = $derived(agentChoices(agentsStore.state.agents));

	$effect(() => {
		if (!open) return;
		untrack(() => {
			form = trigger ? formFromTrigger(trigger) : { ...emptyForm(), ...(initial ?? {}) };
			actorsText = form.actors.join(', ');
			wordsText = form.textContains.join(', ');
			emojiText = form.emoji.join(' ');
			const sec = Number(form.cooldownSec) || 0;
			cdUnit = sec > 0 && sec % 3600 === 0 ? '3600' : sec > 0 && sec % 60 === 0 ? '60' : '1';
			cdValue = String(sec / Number(cdUnit));
			chatNames = {};
			serverError = null;
			showErrors = false;
			secretVisible = false;
			void agentsStore.load();
		});
	});

	function syncCooldown(): void {
		const n = Number(cdValue.trim() === '' ? 0 : cdValue);
		form.cooldownSec = Number.isFinite(n) ? String(Math.round(n * Number(cdUnit))) : 'x';
	}
	const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

	function generate(): void {
		form.secret = generateSecret();
		secretVisible = true;
	}
	async function copySecret(): Promise<void> {
		try {
			await navigator.clipboard.writeText(form.secret);
			toast.success('Secret copied');
		} catch {
			toast.error('Could not copy. Select the text and copy it.');
		}
	}

	async function save(): Promise<void> {
		showErrors = true;
		serverError = null;
		if (Object.keys(errors).length > 0) return;
		saving = true;
		try {
			const body = bodyFromForm(form);
			const saved = trigger ? await api.patch('/triggers/{id}', { params: { id: trigger.id }, body }) : await api.post('/triggers', { body });
			open = false;
			onSaved(saved);
		} catch (e) {
			serverError = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet err(key: string)}
	{#if shownErrors[key]}<p class="text-xs text-destructive-text" role="alert">{shownErrors[key]}</p>{/if}
{/snippet}

<Sheet.Root bind:open>
	<Sheet.Content side="right" showCloseButton={false} class="flex flex-col gap-0 p-0" style="width: min(44rem, 100vw); max-width: none">
		<header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
			<Sheet.Title class="mr-auto text-sm font-medium">{editing ? 'Edit trigger' : 'New trigger'}</Sheet.Title>
			<Button variant="ghost" size="icon-sm" aria-label="Close" onclick={() => (open = false)}><XIcon class="size-4" /></Button>
		</header>

		<form
			class="flex min-h-0 flex-1 flex-col"
			onsubmit={(e: Event) => {
				e.preventDefault();
				void save();
			}}
		>
			<div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
				<section class="flex flex-col gap-3">
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Name
						<Input bind:value={form.name} placeholder="For example: Tell me about new join requests" aria-invalid={!!shownErrors.name} class="text-[13px] text-foreground" />
					</label>
					{@render err('name')}
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Notes (optional)
						<Textarea bind:value={form.notes} rows={2} placeholder="Why this trigger exists" class="text-[13px] text-foreground" />
					</label>
				</section>

				<section class="flex flex-col gap-2">
					<h3 class="text-xs font-semibold text-muted-foreground">Listen to</h3>
					<p class="text-xs text-muted-foreground">The trigger runs when an event of one of these types happens and passes the filters below.</p>
					<div class="max-h-72 overflow-y-auto rounded-md border border-border p-1.5">
						<EventTypePicker types={catalog.types} bind:selected={form.eventTypes} hints id="form-type" />
					</div>
					{@render err('eventTypes')}
				</section>

				<section class="flex flex-col gap-3">
					<h3 class="text-xs font-semibold text-muted-foreground">Where</h3>
					{#if !channelType && form.eventTypes.length > 0}
						<p class="text-xs text-muted-foreground">Connections and chats apply to chat events only. App events happen everywhere in the app.</p>
					{/if}
					<div class="flex flex-col gap-1.5">
						<span class="text-xs text-muted-foreground">Connections (none chosen = any)</span>
						{#if catalog.connections.length === 0}
							<p class="text-xs text-muted-foreground">No chat connections yet.</p>
						{:else}
							<div class="flex flex-col rounded-md border border-border p-1">
								{#each catalog.connections as c (c.id)}
									<label class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
										<Checkbox checked={form.connectionIds.includes(c.id)} onCheckedChange={() => (form.connectionIds = toggleIn(form.connectionIds, c.id))} aria-label={c.label} />
										<span class="min-w-0 flex-1 truncate text-[13px]">{c.label}</span>
										<span class="text-xs text-muted-foreground">{c.platform}{c.transport === 'user' ? ' account' : c.transport === 'bot' ? ' bot' : ''}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>
					<div class="flex flex-col gap-1.5">
						<span class="text-xs text-muted-foreground">Chats (none chosen = any chat of the connections; a chat includes its topics)</span>
						<ChatPicker connections={catalog.connections} connectionIds={form.connectionIds} bind:selected={form.chatIds} bind:names={chatNames} />
					</div>
				</section>

				<section class="flex flex-col gap-3">
					<h3 class="text-xs font-semibold text-muted-foreground">Only when</h3>
					<div class="flex flex-col gap-1.5">
						<span class="text-xs text-muted-foreground">The person has the role</span>
						<div class="flex flex-wrap gap-x-4 gap-y-1">
							{#each ROLES as r (r)}
								<label class="flex cursor-pointer items-center gap-1.5 text-[13px]">
									<Checkbox checked={form.actorRoles.includes(r)} onCheckedChange={() => (form.actorRoles = toggleIn<ActorRole>(form.actorRoles, r))} aria-label={r} />{r}
								</label>
							{/each}
						</div>
					</div>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">The person is (platform id, @username or exact name; separate with commas)
						<Input
							value={actorsText}
							oninput={(e: Event) => {
								actorsText = (e.currentTarget as HTMLInputElement).value;
								form.actors = parseList(actorsText);
							}}
							placeholder="@ann, 123456"
							class="text-[13px] text-foreground"
						/>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">The text has any of these words (message events only; separate with commas)
						<Input
							value={wordsText}
							disabled={!messageType}
							oninput={(e: Event) => {
								wordsText = (e.currentTarget as HTMLInputElement).value;
								form.textContains = parseList(wordsText);
							}}
							placeholder={messageType ? 'deploy, urgent' : 'Choose a message event type first'}
							class="text-[13px] text-foreground"
						/>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">The text matches this regular expression (message events only)
						<Input bind:value={form.textRegex} disabled={!messageType} maxlength={MAX_REGEX + 50} placeholder={messageType ? '^deploy( now)?$' : 'Choose a message event type first'} aria-invalid={!!shownErrors.textRegex} class="font-mono text-[13px] text-foreground" />
						<span>Ignores case. At most {MAX_REGEX} characters, no nested repeats like (a+)+, no back references. The text is cut to 2000 characters before matching.</span>
					</label>
					{@render err('textRegex')}
					{@render err('text')}
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">The emoji is one of (reaction events only; separate with spaces)
						<Input
							value={emojiText}
							disabled={!reactionType}
							oninput={(e: Event) => {
								emojiText = (e.currentTarget as HTMLInputElement).value;
								form.emoji = [...new Set(emojiText.split(/[\s,]+/).filter(Boolean))];
							}}
							placeholder={reactionType ? '👍 🔥' : 'Choose a reaction event type first'}
							class="text-[13px] text-foreground"
						/>
					</label>
					{@render err('emoji')}
					<div class="flex flex-col gap-1.5">
						<span class="text-xs text-muted-foreground">Facts of the event (all must match)</span>
						<datalist id="trigger-field-names">{#each fieldNames as f (f)}<option value={f}></option>{/each}</datalist>
						{#each form.fields as row, i (i)}
							<div class="flex flex-wrap items-center gap-1.5">
								<Input bind:value={row.field} list="trigger-field-names" placeholder="field, e.g. program" aria-label="Field" class="h-8 w-40 text-[13px]" />
								<NativeSelect bind:value={row.op} size="sm" aria-label="Comparison" class="w-28">
									<NativeSelectOption value="equals">is</NativeSelectOption>
									<NativeSelectOption value="contains">contains</NativeSelectOption>
								</NativeSelect>
								<Input bind:value={row.value} placeholder="value" aria-label="Value" class="h-8 min-w-0 flex-1 text-[13px]" />
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Remove field filter" onclick={() => (form.fields = form.fields.filter((_, j) => j !== i))}><TrashIcon class="size-4" /></Button>
							</div>
						{/each}
						{#if fieldNames.length > 0}<p class="text-xs text-muted-foreground">Facts of the chosen types: {fieldNames.join(', ')}.</p>{/if}
						{@render err('fields')}
						<div><Button type="button" variant="outline" size="sm" onclick={() => (form.fields = [...form.fields, { field: '', op: 'equals', value: '' }])}><PlusIcon class="size-4" />Add a fact filter</Button></div>
					</div>
				</section>

				<section class="flex flex-col gap-3">
					<h3 class="text-xs font-semibold text-muted-foreground">Then</h3>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Action
						<NativeSelect bind:value={form.actionKind} size="sm" class="w-full text-foreground">
							{#each ACTION_KINDS as a (a.id)}<NativeSelectOption value={a.id}>{a.label}</NativeSelectOption>{/each}
						</NativeSelect>
						<span>{ACTION_KINDS.find((a) => a.id === (form.actionKind as ActionKind))?.hint}</span>
					</label>

					{#if form.actionKind === 'wake'}
						<label class="flex flex-col gap-1 text-xs text-muted-foreground">Agent
							<NativeSelect bind:value={form.agentId} size="sm" aria-invalid={!!shownErrors.agentId} class="w-full text-foreground">
								<NativeSelectOption value="">Choose an agent</NativeSelectOption>
								{#each agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
							</NativeSelect>
						</label>
						{@render err('agentId')}
						<label class="flex flex-col gap-1 text-xs text-muted-foreground">Where the agent works
							<NativeSelect bind:value={form.target} size="sm" class="w-full text-foreground">
								{#each WAKE_TARGETS as t (t.id)}<NativeSelectOption value={t.id}>{t.label}</NativeSelectOption>{/each}
							</NativeSelect>
							<span>{WAKE_TARGETS.find((t) => t.id === (form.target as WakeTarget))?.hint}</span>
						</label>
						<label class="flex flex-col gap-1 text-xs text-muted-foreground">Instruction
							<Textarea bind:value={form.instruction} rows={4} placeholder="What should the agent do about the event?" aria-invalid={!!shownErrors.instruction} class="text-[13px] text-foreground" />
						</label>
						{@render err('instruction')}
						<label class="flex cursor-pointer items-start gap-2 text-[13px]">
							<Checkbox class="mt-0.5" bind:checked={form.includeText} aria-label="Include a text preview" />
							<span>Give the agent a short preview of the message text <span class="text-muted-foreground">(untrusted: it is written by whoever sent the message)</span></span>
						</label>
					{:else if form.actionKind === 'program'}
						<label class="flex flex-col gap-1 text-xs text-muted-foreground">Program
							<NativeSelect bind:value={form.programId} size="sm" aria-invalid={!!shownErrors.programId} class="w-full text-foreground">
								<NativeSelectOption value="">Choose a program</NativeSelectOption>
								{#each programs as p (p.id)}<NativeSelectOption value={p.id}>{p.name}</NativeSelectOption>{/each}
							</NativeSelect>
						</label>
						{@render err('programId')}
					{:else if form.actionKind === 'notify'}
						<label class="flex flex-col gap-1 text-xs text-muted-foreground">Title (optional)
							<Input bind:value={form.notifyTitle} placeholder="Shown in the bell" class="text-[13px] text-foreground" />
						</label>
						<label class="flex cursor-pointer items-center gap-2 text-[13px]">
							<Checkbox bind:checked={form.dm} aria-label="Also message the owner" />Also message the owner in their direct chat
						</label>
					{:else}
						<label class="flex flex-col gap-1 text-xs text-muted-foreground">URL
							<Input bind:value={form.url} type="url" placeholder="https://example.com/hooks/events" aria-invalid={!!shownErrors.url} class="text-[13px] text-foreground" />
						</label>
						{@render err('url')}
						<div class="flex flex-col gap-1 text-xs text-muted-foreground">
							<label for="trigger-secret">Secret (signs every call with HMAC-SHA256)</label>
							<div class="flex flex-wrap gap-1.5">
								<Input id="trigger-secret" bind:value={form.secret} type={secretVisible ? 'text' : 'password'} autocomplete="off" placeholder={trigger?.hasSecret ? 'Secret set — leave empty to keep it' : `At least ${MIN_SECRET} characters`} aria-invalid={!!shownErrors.secret} class="h-8 min-w-0 flex-1 font-mono text-[13px] text-foreground" />
								<Button type="button" variant="outline" size="sm" onclick={generate}>Generate</Button>
								{#if secretVisible && form.secret}<Button type="button" variant="outline" size="sm" aria-label="Copy the secret" onclick={() => void copySecret()}><CopyIcon class="size-4" />Copy</Button>{/if}
							</div>
							{#if trigger?.hasSecret && !form.secret}<span>Secret set — leave empty to keep it. A stored secret is never shown again.</span>{/if}
							{#if secretVisible && form.secret}<span>Copy it now: it is shown only once and cannot be read back after saving.</span>{/if}
						</div>
						{@render err('secret')}
					{/if}
				</section>

				<section class="flex flex-col gap-3">
					<h3 class="text-xs font-semibold text-muted-foreground">Limits</h3>
					<div class="flex flex-col gap-1 text-xs text-muted-foreground">
						<label for="trigger-cooldown">Wait after a firing before it can fire again (0 = no wait)</label>
						<div class="flex gap-1.5">
							<Input id="trigger-cooldown" type="number" min="0" step="any" bind:value={cdValue} oninput={syncCooldown} aria-invalid={!!shownErrors.cooldownSec} class="h-8 w-28 text-[13px] text-foreground" />
							<NativeSelect bind:value={cdUnit} onchange={syncCooldown} size="sm" aria-label="Unit" class="w-32 text-foreground">
								<NativeSelectOption value="1">seconds</NativeSelectOption>
								<NativeSelectOption value="60">minutes</NativeSelectOption>
								<NativeSelectOption value="3600">hours</NativeSelectOption>
							</NativeSelect>
						</div>
					</div>
					{@render err('cooldownSec')}
					<label class="flex cursor-pointer items-start gap-2 text-[13px]">
						<Checkbox class="mt-0.5" bind:checked={form.allowSelf} aria-label="Also fire on events the agent caused" />
						<span>Also fire on events the agent itself caused
							{#if form.allowSelf}<span class="mt-0.5 block text-xs text-warning-text">Warning: an agent that reacts to its own actions can start a loop. The cooldown and the hourly cap are the only brakes.</span>{/if}
						</span>
					</label>
					<label class="flex cursor-pointer items-center gap-2 text-[13px]">
						<Checkbox bind:checked={form.enabled} aria-label="Enabled" />Enabled
					</label>
				</section>
			</div>

			<footer class="flex shrink-0 flex-col gap-2 border-t border-border p-3">
				{#if serverError}<p class="text-xs text-destructive-text" role="alert">{serverError}</p>{/if}
				{#if showErrors && Object.keys(errors).length > 0}<p class="text-xs text-destructive-text" role="alert">Fix the marked fields to save.</p>{/if}
				<div class="flex justify-end gap-2">
					<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
					<Button type="submit" disabled={saving}>{#if saving}<Spinner />{/if}{editing ? 'Save changes' : 'Create trigger'}</Button>
				</div>
			</footer>
		</form>
	</Sheet.Content>
</Sheet.Root>
