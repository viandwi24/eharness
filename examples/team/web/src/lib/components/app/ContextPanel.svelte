<script lang="ts">
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import FileCodeIcon from 'phosphor-svelte/lib/FileCode';
	import FileImageIcon from 'phosphor-svelte/lib/FileImage';
	import FilePdfIcon from 'phosphor-svelte/lib/FilePdf';
	import FileIcon from 'phosphor-svelte/lib/File';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
	import FolderOpenIcon from 'phosphor-svelte/lib/FolderOpen';
	import XIcon from 'phosphor-svelte/lib/X';
	import PulseIcon from 'phosphor-svelte/lib/Pulse';
	import { onMount } from 'svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { api } from '#lib/api/index.js';
	import type { AgentSessions, Task } from '#lib/api/client.js';
	import { badgeFor } from '#lib/board/board.js';
	import { contextView, formatTokens } from '#lib/context.js';
	import { modeInfo } from '#lib/modes.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { openEditAgent } from '#lib/stores/dialogs.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { modesStore } from '#lib/stores/modes.svelte.js';
	import { panelTabKey, readPref, writePref } from '#lib/stores/prefs.js';
	import type { components } from '#lib/api/schema.js';
	import { basename, fileKind, formatBytes, parentOf } from '#lib/files/helpers.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import MemoryEditor from './MemoryEditor.svelte';
	import RoutinesTab from './RoutinesTab.svelte';

	/** The agent's details panel: overview, tasks, routines, files and memory. */
	let { agentId, onClose }: { agentId: string; onClose?: () => void } = $props();
	const agent = $derived(agentsStore.find(agentId));

	const TABS = ['overview', 'tasks', 'routines', 'files', 'memory'] as const;
	type TabId = (typeof TABS)[number];
	const LABELS: Record<TabId, string> = { overview: 'Overview', tasks: 'Tasks', routines: 'Routines', files: 'Files', memory: 'Memory' };

	// The open tab is remembered per agent (try/catch inside the prefs helper).
	let tab = $state<TabId>('overview');
	let tabFor = '';
	$effect(() => {
		const id = agentId;
		if (id === tabFor) return;
		tabFor = id;
		const saved = readPref(panelTabKey(id));
		tab = (TABS as readonly string[]).includes(saved ?? '') ? (saved as TabId) : 'overview';
	});
	function setTab(v: string): void {
		tab = v as TabId;
		writePref(panelTabKey(agentId), v);
	}

	let sessions = $state<AgentSessions | null>(null);
	let sessionsError = $state<string | null>(null);
	// Reload on agent change and whenever the board moves (task-changed events refresh `live.state.tasks`).
	const stamp = $derived(live.state.tasks.map((t) => `${t.id}:${t.status}`).join('|'));
	let seq = 0;
	let sessionsAgent: string | undefined;
	$effect(() => {
		const id = agent?.id;
		void stamp;
		if (!id) return;
		if (id !== sessionsAgent) {
			sessionsAgent = id;
			sessions = null;
		}
		const mine = ++seq;
		api.get('/agents/{id}/sessions', { params: { id } }).then(
			(r) => {
				if (mine !== seq) return;
				sessions = r;
				sessionsError = null;
			},
			(e) => {
				if (mine === seq) sessionsError = e instanceof Error ? e.message : 'Could not load tasks';
			}
		);
	});

	// Routines, latest files, tools and context usage come from one context read; reloaded on events.
	type Context = components['schemas']['AgentContext'];
	let context = $state<Context | null>(null);
	let contextError = $state<string | null>(null);
	let cseq = 0;
	async function loadContext(): Promise<void> {
		const id = agent?.id;
		if (!id) return;
		const mine = ++cseq;
		try {
			const c = await api.get('/agents/{id}/context', { params: { id } });
			if (mine !== cseq) return;
			context = c;
			contextError = null;
		} catch (e) {
			if (mine === cseq) contextError = e instanceof Error ? e.message : 'Could not load the agent context';
		}
	}
	let ctxAgent: string | undefined;
	$effect(() => {
		const id = agent?.id;
		void live.state.revs.files;
		void live.state.revs.routines;
		void live.state.revs.chat;
		if (id !== ctxAgent) {
			ctxAgent = id;
			context = null;
		}
		void loadContext();
	});

	// The agent's permission mode (the composer's switch loads it too; the store dedupes by agent).
	const modeState = $derived(agent ? modesStore.state.byAgent[agent.id] : undefined);
	onMount(() => {
		if (agent && !modeState) void modesStore.load(agent.id).catch(() => {});
	});

	const owned = $derived<Task[]>(sessions?.tasks ?? []);
	const delegated = $derived<Task[]>(sessions?.delegated ?? []);
	const active = $derived([...owned, ...delegated].filter((t) => t.status === 'running' || t.status === 'needs_action').length);
	const ctxView = $derived(context ? contextView(context.stats.context) : null);
	const toolLabel = (n: string): string => n.replaceAll('_', ' ');

	function iconFor(path: string) {
		const kind = fileKind({ path, mediaType: null, binary: false });
		return kind === 'markdown' || kind === 'text'
			? FileTextIcon
			: kind === 'code'
				? FileCodeIcon
				: kind === 'image'
					? FileImageIcon
					: kind === 'pdf'
						? FilePdfIcon
						: FileIcon;
	}
</script>

{#snippet heading(text: string)}
	<h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{text}</h3>
{/snippet}

{#snippet skeletonRows()}
	<div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
		{#each [0, 1, 2] as i (i)}<Skeleton class="h-9 w-full rounded-lg" />{/each}
	</div>
{/snippet}

{#snippet errorLine(text: string)}
	<p class="rounded-lg bg-destructive-soft px-2.5 py-2 text-xs text-destructive-text" role="alert">{text}</p>
{/snippet}

{#snippet taskRow(t: Task)}
	{@const b = badgeFor(t.status)}
	<Item.Root size="xs" class="px-2 py-1.5">
		{#snippet child({ props })}
			<button type="button" {...props} class="{props.class} cursor-pointer text-left" onclick={() => openTask(t.id)}>
				<Item.Content>
					<Item.Title class="text-[13px] font-medium">{t.title}</Item.Title>
					<Item.Description class="text-xs">{relativeTime(t.lastActivityAt)}</Item.Description>
				</Item.Content>
				<Badge variant={b.variant}>{b.label}</Badge>
			</button>
		{/snippet}
	</Item.Root>
{/snippet}

<Tabs.Root value={tab} onValueChange={setTab} class="flex h-full min-h-0 flex-col gap-0">
	<!-- The tab strip is the panel header: same height and single bottom border as the chat header;
	     triggers stretch over the border (-mb-px) so the active underline replaces it. -->
	<div class="flex h-14 shrink-0 items-stretch border-b border-border pr-2">
		<Tabs.List variant="line" class="h-full min-w-0 flex-1 items-stretch gap-3.5 overflow-x-auto border-b-0 px-3 [scrollbar-width:none]">
			{#each TABS as v (v)}
				<Tabs.Trigger value={v} class="items-center pb-0 text-[13px]">
					{LABELS[v]}
					{#if v === 'tasks' && active > 0}
						<Badge shape="number" variant="info" class="h-4 min-w-4 px-1 text-[10px]">{active}</Badge>
					{/if}
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
		{#if onClose}
			<Button variant="ghost" size="icon-sm" class="my-auto shrink-0" aria-label="Close details" onclick={onClose}><XIcon class="size-4" /></Button>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
		<Tabs.Content value="overview" class="flex flex-col gap-5">
			{#if agent}
				<section>
					{#if agent.description}<p class="text-[13px] leading-relaxed text-foreground">{agent.description}</p>
					{:else}<p class="text-[13px] text-muted-foreground">No description yet.</p>{/if}
					<Button variant="outline" size="sm" class="mt-3" onclick={() => openEditAgent(agent.id)}>
						<PencilSimpleIcon /> Edit agent
					</Button>
				</section>

				<section>
					{@render heading('Configuration')}
					<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
						<dt class="text-muted-foreground">Model</dt>
						<dd class="truncate text-right font-mono text-xs" title={agent.model ?? context?.stats.model.id ?? ''}>
							{agent.model ?? context?.stats.model.id ?? 'Workspace default'}
						</dd>
						<dt class="text-muted-foreground">Mode</dt>
						<dd class="text-right">{modeState ? modeInfo(modeState.mode).label : '—'}</dd>
						<dt class="text-muted-foreground">Role</dt>
						<dd class="text-right capitalize">{agent.role}</dd>
					</dl>
					<Button variant="ghost" size="sm" class="mt-2 -ml-2 text-muted-foreground" href="/logs?sessionId={encodeURIComponent(`dm:${agent.id}`)}">
						<PulseIcon /> View model calls
					</Button>
				</section>

				<section>
					{@render heading('Context')}
					{#if ctxView && context}
						<div class="flex items-baseline justify-between text-xs">
							<span class="text-muted-foreground">{formatTokens(context.stats.context.tokens)} of {formatTokens(context.stats.context.window)}</span>
							<span class="tabular-nums {ctxView.over ? 'text-destructive-text' : ctxView.near ? 'text-warning-text' : ''}">{ctxView.pct}%</span>
						</div>
						<div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Context used {ctxView.pct}%">
							<div class="h-full rounded-full {ctxView.over ? 'bg-destructive-text' : ctxView.near ? 'bg-warning-text' : 'bg-foreground/60'}" style="width: {Math.min(100, ctxView.pct)}%"></div>
						</div>
						<p class="mt-1.5 text-xs text-muted-foreground">Full breakdown in the composer's context meter.</p>
					{:else if contextError}
						{@render errorLine(contextError)}
					{:else}
						<Skeleton class="h-8 w-full rounded-lg" />
					{/if}
				</section>

				<section>
					{@render heading('Tools')}
					{#if agent.tools.length || agent.skills.length || agent.mcpServers.length}
						<div class="flex flex-wrap gap-1.5">
							{#each agent.tools as t (t)}<Badge variant="secondary" class="capitalize">{toolLabel(t)}</Badge>{/each}
							{#if agent.skills.length}<Badge variant="outline">{agent.skills.length} skill{agent.skills.length === 1 ? '' : 's'}</Badge>{/if}
							{#if agent.mcpServers.length}<Badge variant="outline">{agent.mcpServers.length} MCP server{agent.mcpServers.length === 1 ? '' : 's'}</Badge>{/if}
						</div>
					{:else}
						<p class="text-xs text-muted-foreground">No extra tools enabled.</p>
					{/if}
				</section>
			{:else}
				<div class="flex flex-col gap-3"><Skeleton class="h-4 w-full" /><Skeleton class="h-4 w-4/5" /><Skeleton class="h-20 w-full rounded-lg" /></div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="tasks" class="flex flex-col gap-4">
			{#if sessions && sessions.dm.pending > 0}
				<p class="rounded-lg bg-warning-soft px-2.5 py-2 text-xs text-warning-text" role="status">
					{sessions.dm.pending} waiting for your answer in this chat.
				</p>
			{/if}
			{#if sessionsError}{@render errorLine(sessionsError)}{/if}
			{#if owned.length}
				<section>
					{@render heading('Runs')}
					<div class="flex flex-col gap-0.5">{#each owned as t (t.id)}{@render taskRow(t)}{/each}</div>
				</section>
			{/if}
			{#if delegated.length}
				<section>
					{@render heading('Delegated')}
					<div class="flex flex-col gap-0.5">{#each delegated as t (t.id)}{@render taskRow(t)}{/each}</div>
				</section>
			{/if}
			{#if sessions && !owned.length && !delegated.length}
				<Empty.Root class="border-0 p-6">
					<Empty.Header>
						<Empty.Media variant="icon"><ListChecksIcon /></Empty.Media>
						<Empty.Title>No tasks yet</Empty.Title>
						<Empty.Description>Runs and work delegated to this agent show up here.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else if !sessions && !sessionsError}
				{@render skeletonRows()}
			{/if}
		</Tabs.Content>

		<Tabs.Content value="routines">
			{#if agent}
				<RoutinesTab agentId={agent.id} />
			{:else}
				{@render skeletonRows()}
			{/if}
		</Tabs.Content>

		<Tabs.Content value="files" class="flex flex-col gap-3">
			{#if contextError}{@render errorLine(contextError)}{/if}
			{#if context && context.files.length}
				<div class="flex flex-col gap-0.5">
					{#each context.files as f (f.path)}
						{@const Icon = iconFor(f.path)}
						<Item.Root size="xs" class="px-2 py-1.5">
							{#snippet child({ props })}
								<a {...props} href="/files?path={encodeURIComponent(f.path)}" title="Open in Files">
									<Item.Media><Icon class="size-4 text-muted-foreground" /></Item.Media>
									<Item.Content>
										<Item.Title class="text-[13px] font-medium break-all">{basename(f.path)}</Item.Title>
										<Item.Description class="text-xs">{parentOf(f.path)} · {formatBytes(f.size)} · {relativeTime(f.updatedAt)}</Item.Description>
									</Item.Content>
								</a>
							{/snippet}
						</Item.Root>
					{/each}
				</div>
				<Button href="/files" variant="ghost" size="sm" class="self-start text-muted-foreground">
					<ArrowSquareOutIcon /> Open in Files
				</Button>
			{:else if context}
				<Empty.Root class="border-0 p-6">
					<Empty.Header>
						<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
						<Empty.Title>No files yet</Empty.Title>
						<Empty.Description>Files this agent writes appear here.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else if !contextError}
				{@render skeletonRows()}
			{/if}
		</Tabs.Content>

		<Tabs.Content value="memory">
			{#if agent}
				{#key agent.id}
					<MemoryEditor scope="agent" agentId={agent.id} compact />
				{/key}
			{:else}
				{@render skeletonRows()}
			{/if}
		</Tabs.Content>
	</div>
</Tabs.Root>
