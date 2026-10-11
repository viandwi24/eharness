<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import CircleIcon from 'phosphor-svelte/lib/Circle';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotch';
	import ProhibitIcon from 'phosphor-svelte/lib/Prohibit';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import FileTextIcon from 'phosphor-svelte/lib/FileText';
	import BrainIcon from 'phosphor-svelte/lib/Brain';
	import WrenchIcon from 'phosphor-svelte/lib/Wrench';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import {
		SessionFile,
		SessionOutputPreview,
		SessionOutputTitle,
		SessionPanel,
		SessionPanelDivider,
		SessionProgress,
		SessionSection,
		SessionSource
	} from '#lib/components/ai/session-panel/index.js';
	import type { ArtifactKind } from '#lib/components/ai/artifact-card/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import type { Elevation } from '#lib/components/ui/elevation/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { api } from '#lib/api/index.js';
	import type { AgentSessions, Task } from '#lib/api/client.js';
	import type { components } from '#lib/api/schema.js';
	import { badgeFor } from '#lib/board/board.js';
	import { agentChat } from '#lib/chat/chats.svelte.js';
	import { basename, fileKind } from '#lib/files/helpers.js';
	import { chatOutputs, formatBadge, latestTodoList, markdownTitle, todoPercent, toolViews, usedSummary } from '#lib/session/derive.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { openEditAgent } from '#lib/stores/dialogs.svelte.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	/**
	 * The agent's session panel (edmi "AI session panel"): progress, outputs, delegated agents and what
	 * the chat used. Derived from the chat messages plus two reads (`/agents/{id}/sessions` and
	 * `/agents/{id}/context`) that reload on the same live triggers the old details panel used.
	 */
	let {
		agentId,
		thread,
		onClose,
		elevation = 'raised',
		class: className
	}: { agentId: string; thread: { id: string; sessionId: string }; onClose?: () => void; elevation?: Elevation; class?: string } = $props();

	const agent = $derived(agentsStore.find(agentId));
	const messages = $derived(agentChat(agentId, thread.sessionId).chat.messages);

	// Reload on agent change and whenever the board moves (task events refresh `live.state.tasks`).
	let sessions = $state<AgentSessions | null>(null);
	const stamp = $derived(live.state.tasks.map((t) => `${t.id}:${t.status}`).join('|'));
	let seq = 0;
	let sessionsAgent: string | undefined;
	$effect(() => {
		const id = agentId;
		const tid = thread.id;
		void stamp;
		if (`${id}#${tid}` !== sessionsAgent) {
			sessionsAgent = `${id}#${tid}`;
			sessions = null;
		}
		const mine = ++seq;
		api.get('/agents/{id}/sessions', { params: { id }, query: { thread: tid } }).then(
			(r) => {
				if (mine === seq) sessions = r;
			},
			() => {
				// keeps the previous value; the panel is secondary to the chat
			}
		);
	});

	type Context = components['schemas']['AgentContext'];
	let context = $state<Context | null>(null);
	let cseq = 0;
	let ctxAgent: string | undefined;
	$effect(() => {
		const id = agentId;
		const tid = thread.id;
		void live.state.revs.files;
		void live.state.revs.routines;
		void live.state.revs.chat;
		if (`${id}#${tid}` !== ctxAgent) {
			ctxAgent = `${id}#${tid}`;
			context = null;
		}
		const mine = ++cseq;
		api.get('/agents/{id}/context', { params: { id }, query: { thread: tid } }).then(
			(c) => {
				if (mine === cseq) context = c;
			},
			() => {}
		);
	});

	// Progress
	const todos = $derived(latestTodoList(messages));
	const percent = $derived(todoPercent(todos));
	const delegated = $derived<Task[]>(sessions?.delegated ?? []);
	const active = $derived([...(sessions?.tasks ?? []), ...delegated].filter((t) => t.status === 'running' || t.status === 'needs_action').length);
	const done = $derived(todos.filter((t) => t.status === 'completed').length);

	// Outputs: files written in THIS session — by this chat's own tool calls, then by the agents it
	// delegated to (their task sessions). Not the agent's files from other sessions.
	const views = $derived(toolViews(messages));
	const mine = $derived(chatOutputs(views));
	let childFiles = $state<{ path: string; at: number }[]>([]);
	let fseq = 0;
	const childKey = $derived(delegated.slice(0, 6).map((t) => `${t.id}:${t.lastActivityAt}`).join('|'));
	$effect(() => {
		void childKey;
		// refetch only when a delegated task changed (childKey), not on every sessions reload
		const tasks = untrack(() => delegated.slice(0, 6));
		const mineSeq = ++fseq;
		if (tasks.length === 0) {
			childFiles = [];
			return;
		}
		Promise.all(
			tasks.map((t) =>
				api.get('/tasks/{id}', { params: { id: t.id } }).then(
					(d) => chatOutputs(toolViews(d.messages as never)).map((path) => ({ path, at: t.lastActivityAt })),
					() => []
				)
			)
		).then((lists) => {
			if (mineSeq === fseq) childFiles = lists.flat();
		});
	});
	const updatedAt = $derived(new Map([...childFiles.map((f) => [f.path, f.at] as const), ...(context?.files ?? []).map((f) => [f.path, f.updatedAt] as const)]));
	const outputs = $derived.by((): string[] => {
		const seen = new Set(mine);
		const rest = childFiles.filter((f) => {
			if (seen.has(f.path)) return false;
			seen.add(f.path);
			return true;
		});
		return [...mine, ...rest.sort((a, b) => b.at - a.at).map((f) => f.path)];
	});
	const MAX_FILES = 5;
	const isMd = (p: string): boolean => fileKind({ path: p, mediaType: null, binary: false }) === 'markdown';
	const previewPath = $derived(outputs.find(isMd));
	const listed = $derived(outputs.filter((p) => p !== previewPath).slice(0, previewPath ? MAX_FILES - 1 : MAX_FILES));

	let previewText = $state<string | null>(null);
	let previewFailed = $state(false);
	let pseq = 0;
	let loadedFor = '';
	$effect(() => {
		const path = previewPath;
		void live.state.revs.files;
		if (!path) {
			previewText = null;
			loadedFor = '';
			return;
		}
		if (path !== loadedFor) {
			previewText = null;
			previewFailed = false;
		}
		loadedFor = path;
		const token = ++pseq;
		api.get('/library/file', { query: { path } }).then(
			(r) => {
				if (token !== pseq) return;
				previewText = (r as { content?: string }).content ?? '';
			},
			() => {
				if (token === pseq) previewFailed = true;
			}
		);
	});
	const previewTitle = $derived(previewPath ? (previewText ? markdownTitle(previewText) : undefined) ?? basename(previewPath) : '');
	const previewDate = $derived.by((): string => {
		const t = previewPath ? updatedAt.get(previewPath) : undefined;
		return t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase() : '';
	});

	function kindOf(path: string): ArtifactKind {
		const k = fileKind({ path, mediaType: null, binary: false });
		return k === 'code' ? 'code' : k === 'image' ? 'image' : k === 'pdf' ? 'file' : k === 'other' ? 'file' : 'document';
	}
	const openFile = (path: string): void => void goto(`/files?path=${encodeURIComponent(path)}`);

	// Used in this session
	const used = $derived(usedSummary(messages));
	const hasUsed = $derived(used.web.hosts.length > 0 || used.web.calls > 0 || used.filesRead.count > 0 || used.memory.calls > 0 || used.tools.calls > 0);
	const FAVICONS = 3;
	const detail = (names: string[], n = 3): string => names.slice(0, n).join(', ') + (names.length > n ? ` +${names.length - n}` : '');
	const memoryDetail = $derived(
		[used.memory.read.length ? `Read · ${detail(used.memory.read, 2)}` : '', used.memory.write.length ? `Write · ${detail(used.memory.write, 2)}` : '']
			.filter(Boolean)
			.join(' · ')
	);

	const routinesCount = $derived(context?.routines.length ?? 0);
	const colorOf = (id: string): string | undefined => agentsStore.find(id)?.color;
	const loading = $derived(context === null && sessions === null && messages.length === 0);
</script>

<SessionPanel {elevation} class={className} aria-label="Agent session">
	<SessionProgress title="Progress" value={todos.length ? percent : undefined} defaultOpen {onClose}>
		{#if todos.length}
			<ul class="flex flex-col gap-1.5" aria-label="To-do list, {done} of {todos.length} done">
				{#each todos as t, i (i)}
					<li class="flex items-start gap-2 {t.status === 'completed' || t.status === 'cancelled' ? 'text-muted-foreground' : 'text-foreground'}">
						<span class="mt-0.5 shrink-0" aria-hidden="true">
							{#if t.status === 'completed'}
								<CheckCircleIcon class="size-4 text-success-text" weight="fill" />
							{:else if t.status === 'in_progress'}
								<CircleNotchIcon class="size-4 animate-spin text-info-text motion-reduce:animate-none" />
							{:else if t.status === 'cancelled'}
								<ProhibitIcon class="size-4" />
							{:else}
								<CircleIcon class="size-4" />
							{/if}
						</span>
						<span class="min-w-0 {t.status === 'completed' || t.status === 'cancelled' ? 'line-through' : ''}">
							{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
						</span>
						<span class="sr-only">({t.status.replace('_', ' ')})</span>
					</li>
				{/each}
			</ul>
		{:else if active > 0}
			<p class="flex items-center gap-2" role="status">
				<CircleNotchIcon class="size-4 animate-spin text-info-text motion-reduce:animate-none" aria-hidden="true" />
				{active} delegated {active === 1 ? 'task' : 'tasks'} in progress
			</p>
		{:else if loading}
			<div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading"><Skeleton class="h-3.5 w-4/5" /><Skeleton class="h-3.5 w-3/5" /></div>
		{:else}
			<p>Idle. A checklist shows up here when the agent plans multi-step work.</p>
		{/if}
	</SessionProgress>

	<SessionPanelDivider />

	<SessionSection title="Outputs">
		{#if previewPath}
			<a
				href="/files?path={encodeURIComponent(previewPath)}"
				class="block rounded-[var(--radius)] outline-none focus-visible:outline-2 focus-visible:outline-ring"
				aria-label="Open {basename(previewPath)} in Files"
			>
				<SessionOutputPreview class="flex flex-col justify-between bg-accent p-3.5">
					<span class="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Markdown{previewDate ? ` · ${previewDate}` : ''}</span>
					{#if previewText === null && !previewFailed}
						<Skeleton class="h-5 w-3/4" />
					{:else}
						<span class="line-clamp-4 font-brand text-lg leading-snug font-semibold tracking-tight">{previewTitle}</span>
					{/if}
				</SessionOutputPreview>
			</a>
			<SessionOutputTitle meta="File"><span class="truncate">{previewTitle}</span></SessionOutputTitle>
		{/if}
		{#if listed.length}
			<div class="{previewPath ? 'mt-1.5' : ''} flex flex-col">
				{#each listed as p (p)}
					<SessionFile name={basename(p)} format={formatBadge(p)} kind={kindOf(p)} title={p} onclick={() => openFile(p)} />
				{/each}
			</div>
		{/if}
		{#if outputs.length === 0}
			{#if sessions === null}
				<div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading"><Skeleton class="h-4 w-full" /><Skeleton class="h-4 w-2/3" /></div>
			{:else}
				<p class="text-[13px] text-muted-foreground">No files yet. Files written in this session (and by the agents it delegates to) appear here.</p>
			{/if}
		{:else}
			<a href="/files" class="mt-1 self-start rounded text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
				Show all in Files
			</a>
		{/if}
	</SessionSection>

	{#if delegated.length}
		<SessionPanelDivider />
		<SessionSection title="Agents">
			<ul class="flex flex-col">
				{#each delegated.slice(0, 6) as t (t.id)}
					{@const b = badgeFor(t.status, t.summary)}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-2.5 rounded-md py-[7px] text-left text-sm outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
							onclick={() => openTask(t.id)}
						>
							<AgentAvatar seed={t.agentId} color={colorOf(t.agentId)} size={20} class="shrink-0" />
							<span class="min-w-0 flex-1 truncate">{t.title}</span>
							<Badge variant={b.variant}>{b.label}</Badge>
						</button>
					</li>
				{/each}
			</ul>
			{#if delegated.length > 6}
				<a href="/tasks" class="mt-1 self-start rounded text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
					+{delegated.length - 6} more on the board
				</a>
			{/if}
		</SessionSection>
	{/if}

	{#if hasUsed}
		<SessionPanelDivider />
		<SessionSection title="Used in this session">
			{#if used.web.hosts.length || used.web.calls}
				<SessionSource
					label="Web search"
					favicons={used.web.hosts.slice(0, FAVICONS).map((h) => ({ label: h }))}
					more={Math.max(0, used.web.hosts.length - FAVICONS)}
				>
					{#snippet icon()}<GlobeIcon />{/snippet}
				</SessionSource>
			{/if}
			{#if used.filesRead.count}
				<SessionSource label="Files read">
					{#snippet icon()}<FileTextIcon />{/snippet}
					{used.filesRead.count} · {detail(used.filesRead.names)}
				</SessionSource>
			{/if}
			{#if used.memory.calls}
				<SessionSource label="Memory">
					{#snippet icon()}<BrainIcon />{/snippet}
					{memoryDetail}
				</SessionSource>
			{/if}
			{#if used.tools.calls}
				<SessionSource label="Tools">
					{#snippet icon()}<WrenchIcon />{/snippet}
					{used.tools.calls} · {detail(used.tools.names)}
				</SessionSource>
			{/if}
		</SessionSection>
	{/if}

	<SessionPanelDivider />
	<nav class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Agent shortcuts">
		<a href="/routines?agentId={encodeURIComponent(agentId)}" class="rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
			Routines{context ? ` (${routinesCount})` : ''}
		</a>
		<button type="button" class="rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring" onclick={() => openEditAgent(agentId, 'memory')} disabled={!agent}>
			Agent memory
		</button>
		<a href="/logs?sessionId={encodeURIComponent(thread.sessionId)}" class="rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
			Model calls
		</a>
	</nav>
</SessionPanel>
