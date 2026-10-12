<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';

	const notFound = $derived(page.status === 404);
</script>

<div class="flex min-w-0 flex-1 items-center justify-center p-6" data-testid="error-page">
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>{notFound ? 'This page does not exist' : 'Something went wrong'}</Empty.Title>
			<Empty.Description>
				{notFound ? 'The link may be old, or the item was deleted.' : (page.error?.message ?? 'The page could not be shown. Try again.')}
			</Empty.Description>
		</Empty.Header>
		<Empty.Content class="flex-row justify-center gap-2">
			<Button href="/">Back to agents</Button>
			<Button variant="outline" onclick={() => history.back()}>Go back</Button>
		</Empty.Content>
	</Empty.Root>
</div>
