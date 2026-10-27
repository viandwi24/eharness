<script lang="ts">
	// The manifest as forms: "Runs when" (triggers), "Allowed to" (grants), "Limits".
	// Pickers offer the real connections, chats, tables, agents and programs; typing still works.
	import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircle';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import TableIcon from 'phosphor-svelte/lib/Table';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTilt';
	import FolderIcon from 'phosphor-svelte/lib/Folder';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import RobotIcon from 'phosphor-svelte/lib/Robot';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import WebhooksLogoIcon from 'phosphor-svelte/lib/WebhooksLogo';
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import ShieldCheckIcon from 'phosphor-svelte/lib/ShieldCheck';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import TagInput from './TagInput.svelte';
	import { cn } from '#lib/utils.js';
	import type { Lookups } from '#lib/scripts/lookups.svelte.js';
	import { APP_EVENTS, CHANNEL_EVENTS, describeTrigger, MESSAGE_KINDS, newTrigger, ROLES, type Schedule, type SimpleManifest, TABLE_EVENTS, type Trigger, WEEKDAYS } from '#lib/scripts/manifest-model.js';

	let { manifest = $bindable(), lookups, webhookUrl = '' }: { manifest: SimpleManifest; lookups: Lookups; webhookUrl?: string } = $props();

	const L = $derived(lookups.state);
	const tableOptions = $derived([{ value: '*', label: 'Any table' }, ...L.tables]);
	const chatSuggestions = (connections: string[]) => {
		const ids = connections.length ? connections : L.connections.map((c) => c.value);
		const seen = new Set<string>();
		return ids.flatMap((id) => (L.chats[id] ?? []).filter((c) => !seen.has(c.value) && seen.add(c.value)));
	};

	$effect(() => {
		// the chats of every connection a trigger or a grant uses (or all, for "any connection")
		if (!L.loaded) return;
		void lookups.allChats();
	});

	const eventGroups = [...new Set(CHANNEL_EVENTS.map((e) => e.group))];
	const appGroups = [...new Set(APP_EVENTS.map((e) => e.group))];
	const hasSchedule = $derived(manifest.triggers.some((t) => t.kind === 'schedule'));
	const hasWebhook = $derived(manifest.triggers.some((t) => t.kind === 'webhook'));
	async function copy(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied');
		} catch {
			toast.error('Could not copy');
		}
	}
	let showLimits = $state(false);
	let openTrigger = $state<number | null>(null);

	function addTrigger(kind: Trigger['kind']): void {
		manifest.triggers = [...manifest.triggers, newTrigger(kind)];
		openTrigger = manifest.triggers.length - 1;
	}
	function removeTrigger(i: number): void {
		manifest.triggers = manifest.triggers.filter((_, j) => j !== i);
		openTrigger = null;
	}
	function toggle(list: string[], v: string): string[] {
		return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
	}
	function setScheduleMode(t: Extract<Trigger, { kind: 'schedule' }>, mode: Schedule['mode']): void {
		const tz = 'timezone' in t.schedule ? t.schedule.timezone : '';
		const time = 'time' in t.schedule ? t.schedule.time : '09:00';
		t.schedule =
			mode === 'every'
				? { mode, every: 1, unit: 'hours' }
				: mode === 'daily'
					? { mode, time, timezone: tz }
					: mode === 'weekly'
						? { mode, days: [1], time, timezone: tz }
						: mode === 'cron'
							? { mode, expr: '0 9 * * *', timezone: tz }
							: { mode, at: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16) };
	}

	const iconOf = { channel: ChatCircleIcon, schedule: ClockIcon, table: TableIcon, app: LightningIcon, webhook: WebhooksLogoIcon } as const;
	const kindLabel = { channel: 'Chat event', schedule: 'Schedule', table: 'Table change', app: 'App event', webhook: 'Webhook' } as const;

	const chip = (on: boolean): string =>
		cn('rounded-full border px-2.5 py-1 text-xs transition-colors', on ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground');
</script>

{#snippet chatRows(key: 'send' | 'read' | 'moderate', addLabel: string)}
	{#each manifest.grants[key] as g, i (i)}
		<div class="flex flex-wrap items-center gap-2">
			<NativeSelect bind:value={g.connection} class="w-48" aria-label="Connection" onchange={() => void lookups.chatsOf(g.connection)}>
				<NativeSelectOption value="">Connection…</NativeSelectOption>
				{#each L.connections as c (c.value)}<NativeSelectOption value={c.value}>{c.label}</NativeSelectOption>{/each}
				{#if g.connection && !L.connections.some((c) => c.value === g.connection)}<NativeSelectOption value={g.connection}>{g.connection}</NativeSelectOption>{/if}
			</NativeSelect>
			<Input bind:value={g.chat} list="mb-{key}-chats-{i}" placeholder="Chat title or id (* = all)" class="w-56" aria-label="Chat" autocomplete="off" />
			<datalist id="mb-{key}-chats-{i}">{#each L.chats[g.connection] ?? [] as c (c.value)}<option value={c.value}>{c.hint}</option>{/each}</datalist>
			<Input bind:value={g.topic} placeholder="Topic (optional)" class="w-40" aria-label="Topic" autocomplete="off" />
			<Button size="icon-sm" variant="ghost" aria-label="Remove chat" onclick={() => (manifest.grants[key] = manifest.grants[key].filter((_, j) => j !== i))}><TrashIcon class="size-4" /></Button>
		</div>
	{/each}
	<div>
		<Button size="sm" variant="ghost" onclick={() => (manifest.grants[key] = [...manifest.grants[key], { connection: L.connections[0]?.value ?? '', chat: '', topic: '' }])}><PlusIcon class="size-4" /> {addLabel}</Button>
	</div>
{/snippet}


<div class="flex flex-col gap-6">
	<!-- RUNS WHEN -->
	<section class="flex flex-col gap-3" aria-labelledby="mb-when">
		<div class="flex items-center gap-2">
			<h3 id="mb-when" class="text-sm font-semibold">Runs when</h3>
			<span class="text-xs text-muted-foreground">Any of these starts the script.</span>
			<span class="flex-1"></span>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} size="sm" variant="outline"><PlusIcon class="size-4" /> Add trigger</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					<DropdownMenu.Item onclick={() => addTrigger('channel')}><ChatCircleIcon class="size-4" /> Chat event</DropdownMenu.Item>
					<DropdownMenu.Item disabled={hasSchedule} onclick={() => addTrigger('schedule')}><ClockIcon class="size-4" /> Schedule{hasSchedule ? ' (one only)' : ''}</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => addTrigger('table')}><TableIcon class="size-4" /> Table change</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => addTrigger('app')}><LightningIcon class="size-4" /> App event (task, program, alarm…)</DropdownMenu.Item>
					<DropdownMenu.Item disabled={hasWebhook} onclick={() => addTrigger('webhook')}><WebhooksLogoIcon class="size-4" /> Webhook{hasWebhook ? ' (one only)' : ''}</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>

		{#if !manifest.triggers.length}
			<p class="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">No trigger: the script runs only when you press Run now.</p>
		{/if}

		{#each manifest.triggers as t, i (i)}
			{@const Icon = iconOf[t.kind]}
			{@const open = openTrigger === i}
			<div class="rounded-lg border border-border bg-card">
				<div class="flex items-center gap-2 px-3 py-2">
					<button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} onclick={() => (openTrigger = open ? null : i)}>
						<span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted"><Icon class="size-4" /></span>
						<span class="min-w-0">
							<span class="block text-xs text-muted-foreground">{kindLabel[t.kind]}</span>
							<span class="block truncate text-sm">{describeTrigger(t)}</span>
						</span>
						<CaretDownIcon class={cn('ml-auto size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
					</button>
					<Button size="icon-sm" variant="ghost" aria-label="Remove trigger" title="Remove" onclick={() => removeTrigger(i)}><TrashIcon class="size-4" /></Button>
				</div>

				{#if open}
					<div class="flex flex-col gap-4 border-t border-border px-3 py-3 text-sm">
						{#if t.kind === 'channel'}
							<div class="flex flex-col gap-2">
								<span class="text-xs font-medium">Events</span>
								{#each eventGroups as g (g)}
									<div class="flex flex-wrap items-center gap-1.5">
										<span class="w-20 text-xs text-muted-foreground">{g}</span>
										{#each CHANNEL_EVENTS.filter((e) => e.group === g) as e (e.value)}
											<button type="button" class={chip(t.events.includes(e.value))} aria-pressed={t.events.includes(e.value)} onclick={() => (t.events = toggle(t.events, e.value))}>{e.label}</button>
										{/each}
									</div>
								{/each}
								{#if !t.events.length}<p class="text-xs text-destructive-text">Pick at least one event.</p>{/if}
							</div>
							<div class="grid gap-4 md:grid-cols-2">
								<div class="flex flex-col gap-1.5">
									<span class="text-xs font-medium">From connection <span class="font-normal text-muted-foreground">(empty = any)</span></span>
									<TagInput label="Connections" bind:values={t.connections} suggestions={L.connections} placeholder="Any connection" mono />
								</div>
								<div class="flex flex-col gap-1.5">
									<span class="text-xs font-medium">In chats <span class="font-normal text-muted-foreground">(empty = any)</span></span>
									<TagInput label="Chats" bind:values={t.chats} suggestions={chatSuggestions(t.connections)} placeholder="Chat title or id" />
								</div>
								{#if t.events.some((e) => e.startsWith('message.'))}
									<div class="flex flex-col gap-1.5">
										<span class="text-xs font-medium">Text contains any of <span class="font-normal text-muted-foreground">(ignores case)</span></span>
										<TagInput label="Words" bind:values={t.textContains} placeholder="e.g. halo" />
									</div>
									<div class="flex flex-col gap-1.5">
										<span class="text-xs font-medium">And matches a pattern <span class="font-normal text-muted-foreground">(regular expression, optional)</span></span>
										<Input bind:value={t.textRegex} class="font-mono text-xs" placeholder="^order\s+#\d+" autocomplete="off" />
									</div>
									<div class="flex flex-col gap-1.5 md:col-span-2">
										<span class="text-xs font-medium">Only these kinds of message <span class="font-normal text-muted-foreground">(none chosen = any)</span></span>
										<div class="flex flex-wrap gap-1.5">
											{#each MESSAGE_KINDS as k (k.value)}
												<button type="button" class={chip(t.messageKinds.includes(k.value))} aria-pressed={t.messageKinds.includes(k.value)} onclick={() => (t.messageKinds = toggle(t.messageKinds, k.value))}>{k.label}</button>
											{/each}
										</div>
									</div>
									<div class="flex flex-wrap items-end gap-3 md:col-span-2">
										<label class="flex flex-col gap-1.5">
											<span class="text-xs font-medium">Replies</span>
											<NativeSelect bind:value={t.isReply} class="w-40" aria-label="Replies">
												<NativeSelectOption value="any">Any message</NativeSelectOption>
												<NativeSelectOption value="yes">Only replies</NativeSelectOption>
												<NativeSelectOption value="no">No replies</NativeSelectOption>
											</NativeSelect>
										</label>
										<label class="flex flex-col gap-1.5">
											<span class="text-xs font-medium">Forwarded</span>
											<NativeSelect bind:value={t.isForward} class="w-44" aria-label="Forwarded">
												<NativeSelectOption value="any">Any message</NativeSelectOption>
												<NativeSelectOption value="yes">Only forwarded</NativeSelectOption>
												<NativeSelectOption value="no">Not forwarded</NativeSelectOption>
											</NativeSelect>
										</label>
										<label class="flex flex-col gap-1.5">
											<span class="text-xs font-medium">Links</span>
											<NativeSelect bind:value={t.hasLink} class="w-40" aria-label="Links">
												<NativeSelectOption value="any">Any message</NativeSelectOption>
												<NativeSelectOption value="yes">With a link</NativeSelectOption>
												<NativeSelectOption value="no">Without links</NativeSelectOption>
											</NativeSelect>
										</label>
									</div>
									{#if t.isForward === 'yes'}
										<div class="flex flex-col gap-1.5 md:col-span-2">
											<span class="text-xs font-medium">Forwarded from <span class="font-normal text-muted-foreground">(empty = from anywhere)</span></span>
											<TagInput label="Forwarded from" bind:values={t.forwardFrom} placeholder="Channel name or id" />
										</div>
									{/if}
								{/if}
								<div class="flex flex-col gap-1.5">
									<span class="text-xs font-medium">Only by people with role</span>
									<div class="flex flex-wrap gap-1.5">
										{#each ROLES as r (r)}
											<button type="button" class={chip(t.actorRoles.includes(r))} aria-pressed={t.actorRoles.includes(r)} onclick={() => (t.actorRoles = toggle(t.actorRoles, r))}>{r}</button>
										{/each}
									</div>
								</div>
								<div class="flex flex-col gap-1.5">
									<span class="text-xs font-medium">Only by these people</span>
									<TagInput label="People" bind:values={t.actors} placeholder="@username, name or id" />
								</div>
							</div>
						{:else if t.kind === 'schedule'}
							{@const s = t.schedule}
							<div class="flex flex-wrap gap-1.5">
								{#each [['daily', 'Every day'], ['weekly', 'Some weekdays'], ['every', 'Every few minutes/hours'], ['at', 'Once'], ['cron', 'Cron']] as [mode, label] (mode)}
									<button type="button" class={chip(s.mode === mode)} aria-pressed={s.mode === mode} onclick={() => setScheduleMode(t, mode as Schedule['mode'])}>{label}</button>
								{/each}
							</div>
							<div class="flex flex-wrap items-end gap-3">
								{#if s.mode === 'every'}
									<label class="flex flex-col gap-1 text-xs font-medium">Every<Input type="number" min="1" bind:value={s.every} class="w-24" /></label>
									<label class="flex flex-col gap-1 text-xs font-medium">Unit
										<NativeSelect bind:value={s.unit}><NativeSelectOption value="minutes">minutes</NativeSelectOption><NativeSelectOption value="hours">hours</NativeSelectOption><NativeSelectOption value="days">days</NativeSelectOption></NativeSelect>
									</label>
									{#if s.unit === 'minutes' && s.every < 1}<p class="text-xs text-destructive-text">At least one minute.</p>{/if}
								{:else if s.mode === 'daily' || s.mode === 'weekly'}
									{#if s.mode === 'weekly'}
										<div class="flex flex-col gap-1 text-xs font-medium">On
											<div class="flex gap-1">
												{#each WEEKDAYS as d, di (d)}
													<button type="button" class={chip(s.days.includes(di))} aria-pressed={s.days.includes(di)} onclick={() => (s.days = s.days.includes(di) ? s.days.filter((x) => x !== di) : [...s.days, di])}>{d}</button>
												{/each}
											</div>
										</div>
									{/if}
									<label class="flex flex-col gap-1 text-xs font-medium">At<Input type="time" bind:value={s.time} class="w-32" /></label>
									<label class="flex flex-col gap-1 text-xs font-medium">Timezone <span class="font-normal text-muted-foreground">(empty = team)</span><Input bind:value={s.timezone} placeholder="Asia/Jakarta" class="w-44" autocomplete="off" /></label>
								{:else if s.mode === 'cron'}
									<label class="flex flex-col gap-1 text-xs font-medium">Cron <span class="font-normal text-muted-foreground">minute hour day month weekday</span><Input bind:value={s.expr} class="w-48 font-mono text-xs" autocomplete="off" /></label>
									<label class="flex flex-col gap-1 text-xs font-medium">Timezone<Input bind:value={s.timezone} placeholder="Asia/Jakarta" class="w-44" autocomplete="off" /></label>
								{:else}
									<label class="flex flex-col gap-1 text-xs font-medium">When<Input type="datetime-local" value={s.at.slice(0, 16)} oninput={(e) => (s.at = e.currentTarget.value)} class="w-56" /></label>
								{/if}
							</div>
						{:else if t.kind === 'app'}
							<div class="flex flex-col gap-2">
								<span class="text-xs font-medium">Events</span>
								{#each appGroups as g (g)}
									<div class="flex flex-wrap items-center gap-1.5">
										<span class="w-20 text-xs text-muted-foreground">{g}</span>
										{#each APP_EVENTS.filter((e) => e.group === g) as e (e.value)}
											<button type="button" class={chip(t.events.includes(e.value))} aria-pressed={t.events.includes(e.value)} onclick={() => (t.events = toggle(t.events, e.value))}>{e.label}</button>
										{/each}
									</div>
								{/each}
								{#if !t.events.length}<p class="text-xs text-destructive-text">Pick at least one event.</p>{/if}
							</div>
							<div class="grid gap-4 md:grid-cols-2">
								<div class="flex flex-col gap-1.5">
									<span class="text-xs font-medium">Only for agents <span class="font-normal text-muted-foreground">(empty = any)</span></span>
									<TagInput label="Agents" bind:values={t.agents} suggestions={L.agents} placeholder="Agent" />
								</div>
								<div class="flex flex-col gap-1.5">
									<span class="text-xs font-medium">Only when the event says <span class="font-normal text-muted-foreground">(field = value)</span></span>
									{#each t.match as m, mi (mi)}
										<div class="flex items-center gap-1.5">
											<Input bind:value={m.key} placeholder="change" class="h-8 w-32 font-mono text-xs" aria-label="Field" autocomplete="off" />
											<span class="text-xs text-muted-foreground">=</span>
											<Input bind:value={m.value} placeholder="done" class="h-8 flex-1 text-xs" aria-label="Value" autocomplete="off" />
											<Button size="icon-sm" variant="ghost" aria-label="Remove condition" onclick={() => (t.match = t.match.filter((_, j) => j !== mi))}><TrashIcon class="size-4" /></Button>
										</div>
									{/each}
									<div><Button size="sm" variant="ghost" onclick={() => (t.match = [...t.match, { key: '', value: '' }])}><PlusIcon class="size-4" /> Add a condition</Button></div>
								</div>
							</div>
							<p class="text-xs text-muted-foreground">The event's fields (its payload) are in <code class="font-mono">event.payload</code>. A test with a real event shows them.</p>
						{:else if t.kind === 'webhook'}
							<div class="flex flex-col gap-2">
								<span class="text-xs font-medium">POST to this secret URL runs the script; the request body is <code class="font-mono">event.body</code>.</span>
								{#if webhookUrl}
									<div class="flex items-center gap-1.5">
										<Input value={webhookUrl} readonly class="h-8 flex-1 font-mono text-xs" aria-label="Webhook URL" onfocus={(e) => e.currentTarget.select()} />
										<Button size="sm" variant="outline" onclick={() => void copy(webhookUrl)}><CopyIcon class="size-4" /> Copy</Button>
									</div>
								{:else}
									<p class="text-xs text-muted-foreground">Save to get the URL.</p>
								{/if}
								<p class="text-xs text-muted-foreground">It works while the script is turned on. Anyone with the URL can call it: keep it private. The answer is the script's result as JSON.</p>
							</div>
						{:else}
							<div class="flex flex-wrap items-end gap-4">
								<label class="flex flex-col gap-1 text-xs font-medium">Table
									<NativeSelect bind:value={t.table} class="min-w-44">
										<NativeSelectOption value="">Pick a table…</NativeSelectOption>
										{#each L.tables as tb (tb.value)}<NativeSelectOption value={tb.value}>{tb.label}</NativeSelectOption>{/each}
										{#if t.table && !L.tables.some((x) => x.value === t.table)}<NativeSelectOption value={t.table}>{t.table}</NativeSelectOption>{/if}
									</NativeSelect>
								</label>
								<div class="flex flex-col gap-1 text-xs font-medium">When a row is
									<div class="flex gap-1.5">
										{#each TABLE_EVENTS as e (e.value)}
											<button type="button" class={chip(t.events.includes(e.value))} aria-pressed={t.events.includes(e.value)} onclick={() => (t.events = toggle(t.events, e.value))}>{e.label.replace('Row ', '')}</button>
										{/each}
									</div>
								</div>
							</div>
							<p class="text-xs text-muted-foreground">Changes the script itself makes never start it again.</p>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</section>

	<!-- ALLOWED TO -->
	<section class="flex flex-col gap-3" aria-labelledby="mb-grants">
		<div class="flex items-baseline gap-2">
			<h3 id="mb-grants" class="text-sm font-semibold">Allowed to</h3>
			<span class="text-xs text-muted-foreground">Everything else is blocked. The run trace says when the code tries.</span>
		</div>

		<div class="divide-y divide-border rounded-lg border border-border bg-card text-sm">
			<div class="flex flex-col gap-3 p-3">
				<div class="flex items-center gap-2"><PaperPlaneTiltIcon class="size-4 text-muted-foreground" /><span class="font-medium">Send to chats</span></div>
				{@render chatRows('send', 'Add a chat')}
				<label class="flex items-center gap-3">
					<Switch bind:checked={manifest.grants.reply} size="sm" />
					<span>Reply in the chat of the event <span class="text-xs text-muted-foreground">(ctx.channels.reply)</span></span>
				</label>
			</div>

			<div class="flex flex-col gap-3 p-3">
				<div class="flex items-center gap-2"><ChatCircleIcon class="size-4 text-muted-foreground" /><span class="font-medium">Read chats</span><span class="text-xs text-muted-foreground">history, members and files (chats you send to are readable already)</span></div>
				{@render chatRows('read', 'Add a chat to read')}
			</div>

			<div class="flex flex-col gap-3 p-3">
				<div class="flex items-center gap-2"><ShieldCheckIcon class="size-4 text-muted-foreground" /><span class="font-medium">Moderate groups</span><span class="text-xs text-muted-foreground">ban, mute, restrict, join requests, invite links (the connection needs the admin right)</span></div>
				{@render chatRows('moderate', 'Add a group')}
			</div>

			<div class="flex flex-col gap-3 p-3">
				<div class="flex items-center gap-2"><LightningIcon class="size-4 text-muted-foreground" /><span class="font-medium">Native actions</span><span class="text-xs text-muted-foreground">what a connection can do beyond messages (the Channels page lists them; * = any)</span></div>
				{#each manifest.grants.actions as a, i (i)}
					<div class="flex flex-wrap items-center gap-2">
						<NativeSelect bind:value={a.connection} class="w-48" aria-label="Connection">
							<NativeSelectOption value="">Connection…</NativeSelectOption>
							{#each L.connections as c (c.value)}<NativeSelectOption value={c.value}>{c.label}</NativeSelectOption>{/each}
							{#if a.connection && !L.connections.some((c) => c.value === a.connection)}<NativeSelectOption value={a.connection}>{a.connection}</NativeSelectOption>{/if}
						</NativeSelect>
						<Input bind:value={a.name} placeholder="Action (e.g. create_link)" class="w-56 font-mono text-xs" aria-label="Action" autocomplete="off" />
						<Button size="icon-sm" variant="ghost" aria-label="Remove action" onclick={() => (manifest.grants.actions = manifest.grants.actions.filter((_, j) => j !== i))}><TrashIcon class="size-4" /></Button>
					</div>
				{/each}
				<div>
					<Button size="sm" variant="ghost" onclick={() => (manifest.grants.actions = [...manifest.grants.actions, { connection: L.connections[0]?.value ?? '', name: '' }])}><PlusIcon class="size-4" /> Add an action</Button>
				</div>
			</div>

			<div class="p-3">
				<label class="flex items-center gap-3">
					<Switch bind:checked={manifest.grants.notify} size="sm" />
					<span>Notify the owner <span class="text-xs text-muted-foreground">(ctx.notify: a notification in the bell)</span></span>
				</label>
			</div>

			<div class="grid gap-3 p-3 md:grid-cols-2">
				<div class="flex flex-col gap-1.5 md:col-span-2"><div class="flex items-center gap-2"><TableIcon class="size-4 text-muted-foreground" /><span class="font-medium">Tables</span></div></div>
				<div class="flex flex-col gap-1.5"><span class="text-xs font-medium">Read</span><TagInput label="Tables to read" bind:values={manifest.grants.tablesRead} suggestions={tableOptions} placeholder="Table name" mono /></div>
				<div class="flex flex-col gap-1.5"><span class="text-xs font-medium">Read and change</span><TagInput label="Tables to change" bind:values={manifest.grants.tablesWrite} suggestions={tableOptions} placeholder="Table name" mono /></div>
			</div>

			<div class="grid gap-3 p-3 md:grid-cols-2">
				<div class="flex flex-col gap-1.5 md:col-span-2"><div class="flex items-center gap-2"><FolderIcon class="size-4 text-muted-foreground" /><span class="font-medium">Library files</span><span class="text-xs text-muted-foreground"><code class="font-mono">*</code> = any name in a folder, <code class="font-mono">**</code> = any depth</span></div></div>
				<div class="flex flex-col gap-1.5"><span class="text-xs font-medium">Read</span><TagInput label="Library paths to read" bind:values={manifest.grants.libraryRead} placeholder="/library/data/**" mono /></div>
				<div class="flex flex-col gap-1.5"><span class="text-xs font-medium">Read and write</span><TagInput label="Library paths to write" bind:values={manifest.grants.libraryWrite} placeholder="/library/reports/**" mono /></div>
			</div>

			<div class="grid gap-3 p-3 md:grid-cols-2">
				<div class="flex flex-col gap-1.5">
					<div class="flex items-center gap-2"><GlobeIcon class="size-4 text-muted-foreground" /><span class="font-medium">Web requests</span></div>
					<TagInput label="Hosts" bind:values={manifest.grants.http} placeholder="api.example.com" mono />
					<span class="text-xs text-muted-foreground">https only; private addresses are always blocked.</span>
				</div>
				<div class="flex flex-col gap-1.5">
					<div class="flex items-center gap-2"><RobotIcon class="size-4 text-muted-foreground" /><span class="font-medium">Wake agents</span></div>
					<TagInput label="Agents" bind:values={manifest.grants.wake} suggestions={L.agents} placeholder="Agent" />
					<span class="text-xs text-muted-foreground">A wake is a paid model turn; at most 3 per run.</span>
				</div>
				<div class="flex flex-col gap-1.5">
					<span class="text-xs font-medium">Start programs</span>
					<TagInput label="Programs" bind:values={manifest.grants.programs} suggestions={L.programs} placeholder="Program" />
				</div>
			</div>

			<div class="flex flex-col gap-2 p-3">
				<div class="flex items-center gap-2"><PlugsConnectedIcon class="size-4 text-muted-foreground" /><span class="font-medium">Team API</span><span class="text-xs text-muted-foreground">anything the web app can do, route by route</span></div>
				<TagInput label="API routes" bind:values={manifest.grants.api} placeholder="GET /tasks/**" mono suggestions={[
					{ value: 'GET /agents/**', label: 'GET /agents/**', hint: 'read agents' },
					{ value: 'GET /tasks/**', label: 'GET /tasks/**', hint: 'read tasks' },
					{ value: 'POST /tables/*/rows', label: 'POST /tables/*/rows', hint: 'add rows' },
					{ value: 'GET /programs/**', label: 'GET /programs/**', hint: 'read programs' },
					{ value: 'GET /events', label: 'GET /events', hint: 'the event stream' },
					{ value: 'GET /library/**', label: 'GET /library/**', hint: 'read the library' }
				]} />
				<span class="text-xs text-muted-foreground">
					<code class="font-mono">METHOD /path</code>; <code class="font-mono">*</code> = one path part, <code class="font-mono">**</code> = any. Call with <code class="font-mono">ctx.api.get</code> / <code class="font-mono">ctx.api.request</code>. Every route is listed in the <a href="/api/docs" target="_blank" rel="noreferrer" class="underline underline-offset-4">API docs</a>. Scripts, secrets, sign-in and backups are never callable.
				</span>
			</div>
		</div>
	</section>

	<!-- LIMITS -->
	<section class="flex flex-col gap-3" aria-labelledby="mb-limits">
		<button type="button" class="flex items-center gap-2 text-left" aria-expanded={showLimits} onclick={() => (showLimits = !showLimits)}>
			<h3 id="mb-limits" class="text-sm font-semibold">Limits</h3>
			<span class="text-xs text-muted-foreground">
				{manifest.cooldownSec ? `wait ${manifest.cooldownSec}s between runs · ` : ''}{manifest.maxRunsPerHour ? `at most ${manifest.maxRunsPerHour} runs an hour` : 'no hourly cap'}{manifest.loopGuard ? '' : ' · loop guard off'}
			</span>
			<CaretDownIcon class={cn('size-4 text-muted-foreground transition-transform', showLimits && 'rotate-180')} />
		</button>
		{#if showLimits}
			<div class="flex flex-wrap gap-4 rounded-lg border border-border bg-card p-3 text-sm">
				<label class="flex flex-col gap-1 text-xs font-medium">Wait between runs (seconds)<Input type="number" min="0" bind:value={manifest.cooldownSec} class="w-36" /></label>
				<label class="flex flex-col gap-1 text-xs font-medium">Most runs per hour (0 = no cap)<Input type="number" min="0" bind:value={manifest.maxRunsPerHour} class="w-36" /></label>
				<label class="flex w-full items-start gap-3">
					<Switch bind:checked={manifest.loopGuard} size="sm" class="mt-0.5" />
					<span class="flex flex-col gap-0.5">
						<span class="text-xs font-medium">Loop guard</span>
						<span class="text-xs text-muted-foreground">On (recommended): messages the app itself sent, rows this script wrote and what its own API calls caused never start it again. Messages you type on a connected account always count. Off: everything starts it; the wait and the hourly cap above still stop a runaway loop.</span>
					</span>
				</label>
				<p class="w-full text-xs text-muted-foreground">Memory, CPU and time limits have safe defaults; change them in JSON mode (<code class="font-mono">limits</code>).</p>
			</div>
		{/if}
	</section>
</div>
