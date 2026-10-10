<script lang="ts">
	import {
		Confirmation,
		ConfirmationAccepted,
		ConfirmationAction,
		ConfirmationActions,
		ConfirmationRejected,
		ConfirmationRequest,
		ConfirmationTitle
	} from '#lib/components/ai/confirmation/index.js';
	import type { ToolUIPartApproval } from '#lib/components/ai/confirmation/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import type { PartView } from './map.js';

	export type ApprovalAnswer = { id: string; approved: boolean; reason?: string };

	let {
		view,
		onApproval
	}: {
		view: Extract<PartView, { kind: 'approval' }>;
		onApproval?: (answer: ApprovalAnswer) => void;
	} = $props();

	let reason = $state('');

	function answer(approved: boolean): void {
		const r = reason.trim();
		onApproval?.({ id: view.approval.id, approved, reason: r || undefined });
	}
</script>

<Confirmation approval={view.approval as ToolUIPartApproval} state={view.state}>
	<ConfirmationTitle>
		<ConfirmationRequest>Allow <span class="font-mono text-[12.5px]">{view.title}</span>?</ConfirmationRequest>
		<ConfirmationAccepted>Approved: {view.title}</ConfirmationAccepted>
		<ConfirmationRejected>
			Rejected: {view.title}{view.approval.reason ? ` (${view.approval.reason})` : ''}
		</ConfirmationRejected>
	</ConfirmationTitle>
	<ConfirmationActions class="flex-wrap">
		<Input class="h-8 min-w-40 flex-1" placeholder="Reason (optional)" bind:value={reason} />
		<ConfirmationAction variant="outline" onclick={() => answer(false)}>Reject</ConfirmationAction>
		<ConfirmationAction onclick={() => answer(true)}>Approve</ConfirmationAction>
	</ConfirmationActions>
</Confirmation>
