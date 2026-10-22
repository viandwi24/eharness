<script lang="ts">
	import { api } from '#lib/api/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { lineDiff, type DiffLine } from '#lib/conflict.js';
	import {
		REORG_ACTIONS,
		actionLabel,
		destinationText,
		errorsOf,
		notesOf,
		resultText,
		rowsOf,
		setAction,
		setTarget,
		type ReorgAction,
		type ReorgPlan,
		type ReorgRow
	} from '#lib/library/reorg.js';
	import { live } from '#lib/stores/live.svelte.js';

	let { agentId, agentName }: { agentId: string; agentName: string } = $props();

	let open = $state(false);
	let step = $state<'idle' | 'proposing' | 'review' | 'applying' | 'done'>('idle');
	let rows = $state<ReorgRow[]>([]);
	let plan = $state<ReorgPlan | null>(null);
	let warnings = $state<string[]>([]);
	let error = $state('');
	let outcome = $state('');
	let checking = $state(false);
	let checkTimer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const errors = $derived(plan ? errorsOf(plan) : []);
	const rulesChanged = $derived(plan ? plan.rules.before !== plan.rules.after : false);
	const canApply = $derived(step === 'review' && !!plan && plan.ok && !checking && (plan.rows.length > 0 || rulesChanged));

	function begin(): void {
		open = true;
		void propose();
	}

	async function propose(): Promise<void> {
		step = 'proposing';
		error = '';
		outcome = '';
		plan = null;
		try {
			const r = await api.post('/memory/reorganize/propose', { body: { agentId } });
			plan = r.plan;
			rows = rowsOf(r.plan);
			warnings = r.warnings;
			step = 'review';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not get a proposal';
			step = 'idle';
		}
	}

	/** Re-run the deterministic checks after an edit (debounced); the table shows the checked plan. */
	function edited(): void {
		clearTimeout(checkTimer);
		checking = true;
		checkTimer = setTimeout(() => void check(), 350);
	}

	async function check(): Promise<void> {
		const mine = ++seq;
		try {
			const p = await api.post('/memory/reorganize/preview', { body: { agentId, rows } });
			if (mine !== seq) return;
			plan = p;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not check the plan';
		} finally {
			if (mine === seq) checking = false;
		}
	}

	async function apply(): Promise<void> {
		if (!plan) return;
		step = 'applying';
		error = '';
		try {
			const r = await api.post('/memory/reorganize/apply', { body: { agentId, rows } });
			outcome = resultText(r);
			step = 'done';
			live.state.revs.files++;
			toast.success('Memory reorganized');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not apply the reorganization';
			step = 'review';
		}
	}

	const diff = (before: string, after: string): DiffLine[] => lineDiff(before, after);
	const rulesDiff = $derived(plan ? diff(plan.rules.before, plan.rules.after) : []);
	const indexDiff = $derived(plan ? diff(plan.index.before, plan.index.after) : []);
</script>

{#snippet diffView(lines: DiffLine[])}
	<pre class="max-h-56 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{#each lines as l, i (i)}<span class={l.kind === 'add' ? 'text-success-text' : l.kind === 'del' ? 'text-destructive-text' : 'text-muted-foreground'}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}{l.text}
</span>{/each}</pre>
{/snippet}

<div class="rounded-lg border border-border px-3 py-3 text-sm" data-testid="memory-reorganize">
	<p class="font-medium">Reorganize memory</p>
	<p class="mt-1 text-xs text-muted-foreground">
		Memory keeps only short rules and an index; the library is the source of truth for facts. {agentName} proposes where each memory file belongs. You review every row, then apply. A backup is taken first, nothing is deleted (originals move to the archive), and you can undo it from Settings, Backups.
	</p>
	<Button size="sm" variant="outline" class="mt-2" onclick={begin}>Reorganize memory…</Button>
</div>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>Reorganize memory of {agentName}</Dialog.Title>
			<Dialog.Description>
				One model call per small batch of files proposes an action per file. Nothing changes until you press Apply. HEARTBEAT.md is never touched.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
			{#if step === 'proposing'}<p class="text-sm text-muted-foreground" role="status">Reading the memory files and asking the agent's model…</p>{/if}
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			{#each warnings as w (w)}<p class="text-xs text-warning-text">{w}</p>{/each}
			{#if step === 'done'}
				<Alert.Root variant="success">
					<Alert.Title>Done</Alert.Title>
					<Alert.Description>{outcome} Undo it from <a class="underline underline-offset-4" href="/settings?section=backups">Settings, Backups</a> (restore points).</Alert.Description>
				</Alert.Root>
			{/if}
			{#if plan && (step === 'review' || step === 'applying')}
				{#if !plan.rows.length}
					<p class="text-sm text-muted-foreground">There is nothing to move: memory has only rules, an index and the heartbeat checklist.</p>
				{:else}
					<div class="overflow-x-auto rounded-lg border border-border">
						<table class="w-full text-left text-xs" aria-label="Memory reorganization plan">
							<thead class="border-b border-border bg-muted/40">
								<tr>
									<th class="px-2 py-1.5">Memory file</th>
									<th class="px-2 py-1.5">Action</th>
									<th class="px-2 py-1.5">Target</th>
									<th class="px-2 py-1.5">Ends up at</th>
									<th class="px-2 py-1.5">Why</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-border">
								{#each plan.rows as r, i (r.source)}
									{@const row = rows[i]}
									{#if row}
										<tr class="align-top">
											<td class="max-w-48 px-2 py-1.5 font-mono break-all">{r.source}</td>
											<td class="px-2 py-1.5">
												<NativeSelect
													value={row.action}
													aria-label={`Action for ${r.source}`}
													onchange={(e) => {
														rows = setAction(rows, r.source, (e.currentTarget as HTMLSelectElement).value as ReorgAction);
														edited();
													}}
												>
													{#each REORG_ACTIONS as a (a.value)}<NativeSelectOption value={a.value}>{a.label}</NativeSelectOption>{/each}
												</NativeSelect>
											</td>
											<td class="px-2 py-1.5">
												{#if row.action === 'move'}
													<Input
														value={row.target ?? ''}
														aria-label={`Library path for ${r.source}`}
														class="h-8 min-w-56 font-mono text-xs"
														onchange={(e) => {
															rows = setTarget(rows, r.source, (e.currentTarget as HTMLInputElement).value);
															edited();
														}}
													/>
												{:else if row.action === 'merge-into'}
													<NativeSelect
														value={row.target ?? ''}
														aria-label={`Merge ${r.source} into`}
														onchange={(e) => {
															rows = setTarget(rows, r.source, (e.currentTarget as HTMLSelectElement).value);
															edited();
														}}
													>
														<NativeSelectOption value="">Choose a file…</NativeSelectOption>
														{#each plan.rows.filter((x) => x.source !== r.source && x.action !== 'archive' && x.action !== 'keep-as-rule') as o (o.source)}<NativeSelectOption value={o.source}>{o.source}</NativeSelectOption>{/each}
													</NativeSelect>
												{:else}
													<span class="text-muted-foreground">{actionLabel(row.action)}</span>
												{/if}
											</td>
											<td class="max-w-56 px-2 py-1.5 font-mono break-all">
												{destinationText(r)}
												{#each errorsOf(plan, r.source) as i (i.message)}<div class="font-sans text-destructive-text">{i.message}</div>{/each}
												{#each notesOf(plan, r.source) as i (i.message)}<div class="font-sans text-muted-foreground">{i.message}</div>{/each}
											</td>
											<td class="px-2 py-1.5 text-muted-foreground">{r.reason}</td>
										</tr>
									{/if}
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
				{#if rulesChanged}
					<section>
						<p class="mb-1 flex items-center gap-2 text-sm font-medium">rules.md <Badge variant="secondary">changes</Badge></p>
						{@render diffView(rulesDiff)}
					</section>
				{/if}
				<section>
					<p class="mb-1 flex items-center gap-2 text-sm font-medium">index.md <Badge variant="secondary">where things are</Badge></p>
					{@render diffView(indexDiff)}
				</section>
				<p class="text-xs text-muted-foreground">Originals are kept under {plan.originals.rules.replace(/\/[^/]*$/, '/')} (archived files under their archive folder) and are never deleted.</p>
				{#if errors.length}<p class="text-sm text-destructive-text" role="alert">Fix the rows marked in red before you apply.</p>{/if}
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button variant="ghost" onclick={() => (open = false)}>{step === 'done' ? 'Close' : 'Cancel'}</Button>
			{#if step === 'review' || step === 'applying'}
				<Button onclick={apply} disabled={!canApply || step === 'applying'}>{step === 'applying' ? 'Applying…' : 'Apply reorganization'}</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
