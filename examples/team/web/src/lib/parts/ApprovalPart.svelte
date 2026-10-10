<script lang="ts">
	import {
		Confirmation,
		ConfirmationAccepted,
		ConfirmationActions,
		ConfirmationRejected,
		ConfirmationRequest,
		ConfirmationTitle
	} from '#lib/components/ai/confirmation/index.js';
	import type { ToolUIPartApproval } from '#lib/components/ai/confirmation/index.js';
	import ApprovalActions from '#lib/components/app/ApprovalActions.svelte';
	import type { ApprovalAnswerBody } from '#lib/approval/answer.js';
	import type { PartView } from './map.js';

	export type ApprovalAnswer = { id: string } & ApprovalAnswerBody;

	let {
		view,
		onApproval
	}: {
		view: Extract<PartView, { kind: 'approval' }>;
		onApproval?: (answer: ApprovalAnswer) => void;
	} = $props();
</script>

<Confirmation approval={view.approval as ToolUIPartApproval} state={view.state}>
	<ConfirmationTitle>
		<ConfirmationRequest>Allow <span class="font-mono text-[12.5px]">{view.title}</span>?</ConfirmationRequest>
		<ConfirmationAccepted>Approved: {view.title}</ConfirmationAccepted>
		<ConfirmationRejected>
			Rejected: {view.title}{view.approval.reason ? ` (${view.approval.reason})` : ''}
		</ConfirmationRejected>
	</ConfirmationTitle>
	<ConfirmationActions class="block">
		<ApprovalActions toolName={view.toolName} onAnswer={(body) => onApproval?.({ id: view.approval.id, ...body })} />
	</ConfirmationActions>
</Confirmation>
