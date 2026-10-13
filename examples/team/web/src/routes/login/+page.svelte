<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import EyeIcon from 'phosphor-svelte/lib/Eye';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlash';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import ThemeToggle from '#lib/components/app/ThemeToggle.svelte';
	import { safeNext } from '#lib/auth.js';
	import { checkSession, signIn } from '#lib/stores/auth.svelte.js';

	let password = $state('');
	let shown = $state(false);
	let error = $state('');
	let busy = $state(false);

	const next = $derived(safeNext(page.url.searchParams.get('next')));

	onMount(async () => {
		// already signed in (or the server has no login): nothing to do here
		const s = await checkSession();
		if (!s.required || s.authenticated) location.replace(next);
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (busy || !password) return;
		busy = true;
		error = '';
		const r = await signIn(password);
		if (r.ok) {
			// a full navigation: every store starts fresh with the cookie
			location.assign(next);
			return;
		}
		error = r.message;
		busy = false;
	}
</script>

<svelte:head><title>Sign in · Team</title></svelte:head>

<div class="relative flex min-h-svh items-center justify-center bg-sidebar px-4 py-8 text-foreground">
	<div class="absolute top-3 right-3"><ThemeToggle /></div>
	<form onsubmit={submit} class="w-full max-w-sm" aria-label="Sign in">
		<Card.Root>
			<Card.Header>
				<div class="mb-2 flex size-9 items-center justify-center rounded-xl bg-foreground font-brand text-sm text-background" aria-hidden="true">T</div>
				<Card.Title>Sign in</Card.Title>
				<Card.Description>Enter the password to open the team workspace.</Card.Description>
			</Card.Header>
			<Card.Content>
				<Field.Field>
					<Field.Label for="login-password">Password</Field.Label>
					<div class="relative">
						<!-- svelte-ignore a11y_autofocus -->
						<Input
							id="login-password"
							type={shown ? 'text' : 'password'}
							bind:value={password}
							autocomplete="current-password"
							autofocus
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? 'login-error' : undefined}
							class="pr-10"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							class="absolute top-1/2 right-1 -translate-y-1/2"
							aria-label={shown ? 'Hide password' : 'Show password'}
							aria-pressed={shown}
							onclick={() => (shown = !shown)}
						>
							{#if shown}<EyeSlashIcon class="size-4" />{:else}<EyeIcon class="size-4" />{/if}
						</Button>
					</div>
					{#if error}<p id="login-error" role="alert" class="text-sm text-destructive">{error}</p>{/if}
				</Field.Field>
			</Card.Content>
			<Card.Footer class="justify-end border-t border-border pt-4">
				<Button type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
			</Card.Footer>
		</Card.Root>
	</form>
</div>
