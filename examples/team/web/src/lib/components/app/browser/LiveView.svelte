<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import HandGrabbingIcon from 'phosphor-svelte/lib/HandGrabbing';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { LiveSession } from '#lib/browser/live.svelte.js';
	import { buttonOf, controllerText, keyInput, mapPointer, modifiersOf, normalizeUrl } from '#lib/browser/model.js';

	/**
	 * The live view of one profile: frames on a canvas (scaled to the width, pointer coordinates mapped to
	 * frame pixels), Take control / Give back, keyboard capture while in control, a paste box and a URL bar.
	 * A hosted provider's own view (`liveUrl`) is an iframe instead. Closing the page hands the browser back.
	 */
	let { profileId, liveUrl, autoconnect = true, agentHolds = true }: { profileId: string; liveUrl?: string; autoconnect?: boolean; agentHolds?: boolean } = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let frame = $state({ width: 0, height: 0 });
	let frames = 0;
	const session = new LiveSession(untrack(() => profileId), (blob, size) => void draw(blob, size));
	let urlText = $state('');
	let pasteText = $state('');
	let focused = $state(false);
	let down = new Set<string>();

	async function draw(blob: Blob, size: { width: number; height: number }): Promise<void> {
		const n = ++frames;
		const bmp = await createImageBitmap(blob).catch(() => undefined);
		if (!bmp || !canvas || n !== frames) return bmp?.close();
		if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
			canvas.width = bmp.width;
			canvas.height = bmp.height;
		}
		canvas.getContext('2d')?.drawImage(bmp, 0, 0);
		bmp.close();
		if (frame.width !== size.width || frame.height !== size.height) frame = size;
	}

	onMount(() => {
		if (!liveUrl && autoconnect) session.connect();
	});
	onDestroy(() => session.close());

	const point = (e: { clientX: number; clientY: number }): { x: number; y: number } | undefined => {
		if (!canvas) return undefined;
		const r = canvas.getBoundingClientRect();
		return mapPointer({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, frame);
	};
	function pointer(kind: 'move' | 'down' | 'up', e: PointerEvent): void {
		if (!session.inControl) return;
		const p = point(e);
		if (!p) return;
		if (kind === 'down') {
			(e.currentTarget as HTMLElement).focus();
			(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		}
		session.input({ type: 'mouse', event: kind, ...p, button: buttonOf(e.button), clickCount: Math.max(1, e.detail), modifiers: modifiersOf(e) });
	}
	function wheelAction(node: HTMLElement): { destroy(): void } {
		const on = (e: WheelEvent): void => {
			if (!session.inControl) return;
			const p = point(e);
			if (!p) return;
			e.preventDefault();
			session.input({ type: 'mouse', event: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) });
		};
		node.addEventListener('wheel', on, { passive: false });
		return { destroy: () => node.removeEventListener('wheel', on) };
	}
	function key(phase: 'down' | 'up', e: KeyboardEvent): void {
		if (!session.inControl) return;
		// Escape is how a keyboard user leaves the view; everything else goes to the page
		if (e.key === 'Escape' && e.shiftKey) {
			(e.currentTarget as HTMLElement).blur();
			return;
		}
		e.preventDefault();
		if (phase === 'down') down.add(e.code);
		else if (!down.delete(e.code)) return;
		for (const ev of keyInput(e, phase)) session.input(ev);
	}

	async function takeOver(): Promise<void> {
		const err = await session.takeOver();
		if (err) toast.error(err);
	}
	async function handBack(): Promise<void> {
		const err = await session.handBack();
		if (err) toast.error(err);
	}
	async function navigate(): Promise<void> {
		const url = normalizeUrl(urlText);
		if (!url) return;
		const err = await session.sendAck({ type: 'navigate', url });
		if (err) toast.error(err);
	}
	async function paste(): Promise<void> {
		if (pasteText === '') return;
		const err = await session.sendAck({ type: 'text', text: pasteText });
		if (err) toast.error(err);
		else pasteText = '';
	}
	const banner = $derived(controllerText(session.controller, session.you?.id, agentHolds));
	const asked = $derived(session.controller?.by === 'agent' && !!session.controller.reason);
</script>

<div class="flex min-w-0 flex-col gap-3" data-testid="live-view">
	{#if liveUrl}
		<iframe src={liveUrl} title="Live view" class="aspect-video w-full rounded-lg border border-border bg-muted" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
		<p class="text-xs text-muted-foreground">This is the provider's own live view; controls are inside it.</p>
	{:else}
		<div class="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm {session.inControl ? 'border-warning-text/40 bg-warning-soft text-warning-text' : asked ? 'border-info-text/40 bg-info-soft text-info-text' : 'border-border bg-muted/40'}" role="status" data-testid="live-banner">
			<span class="min-w-40 flex-1">{banner}</span>
			{#if session.status === 'open'}
				{#if session.inControl}
					<Button size="sm" onclick={() => void handBack()} data-testid="give-back">Give back</Button>
				{:else if session.you?.canTakeOver && session.controller?.by !== 'human'}
					<Button size="sm" onclick={() => void takeOver()} data-testid="take-control"><HandGrabbingIcon class="size-4" /> Take control</Button>
				{/if}
			{:else if session.status === 'closed' || session.status === 'error' || session.status === 'busy'}
				<Button size="sm" variant="outline" onclick={() => session.connect()} data-testid="live-reconnect">Reconnect</Button>
			{/if}
		</div>
		{#if session.status === 'busy'}
			<p class="text-xs text-warning-text" role="alert">{session.message || 'Too many people are watching this browser.'}</p>
		{:else if session.message}
			<p class="text-xs text-muted-foreground" role="status">{session.message}</p>
		{/if}

		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="relative w-full overflow-hidden rounded-lg border bg-muted outline-none {focused && session.inControl ? 'border-ring ring-2 ring-ring' : 'border-border'}"
			style={frame.width ? `aspect-ratio:${frame.width}/${frame.height}` : 'aspect-ratio:16/10'}
			tabindex="0"
			role="application"
			aria-label={session.inControl ? 'Remote browser. Your keystrokes go to the page; Shift+Escape leaves it.' : 'Remote browser view'}
			use:wheelAction
			onfocus={() => (focused = true)}
			onblur={() => {
				focused = false;
				down = new Set();
			}}
			onkeydown={(e) => key('down', e)}
			onkeyup={(e) => key('up', e)}
			data-testid="live-surface"
		>
			<canvas
				bind:this={canvas}
				class="size-full touch-none select-none {session.inControl ? 'cursor-crosshair' : ''}"
				onpointerdown={(e) => pointer('down', e)}
				onpointermove={(e) => pointer('move', e)}
				onpointerup={(e) => pointer('up', e)}
				oncontextmenu={(e) => session.inControl && e.preventDefault()}
			></canvas>
			{#if frame.width === 0}
				<div class="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{session.status === 'connecting' ? 'Connecting…' : session.status === 'open' ? 'Waiting for the first frame…' : 'Not connected'}</div>
			{/if}
		</div>

		{#if session.inControl}
			<form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); void navigate(); }}>
				<Input bind:value={urlText} placeholder="Go to a URL" aria-label="URL" class="min-w-0 flex-1" data-testid="live-url" />
				<Button size="sm" type="submit" variant="outline" disabled={urlText.trim() === ''}>Go</Button>
			</form>
			<div class="flex items-end gap-2">
				<Textarea bind:value={pasteText} rows={2} placeholder="Paste text to type into the focused field" aria-label="Text to send" class="min-w-0 flex-1" data-testid="live-paste" />
				<Button size="sm" variant="outline" disabled={pasteText === ''} onclick={() => void paste()}>Send text</Button>
			</div>
			<p class="text-xs text-muted-foreground">Click the page to focus it; keys go to the remote browser. Shift+Escape leaves the page.</p>
		{/if}
	{/if}
</div>
