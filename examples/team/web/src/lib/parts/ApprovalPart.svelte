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
		onApproval,
		canAnswer
	}: {
		view: Extract<PartView, { kind: 'approval' }>;
		onApproval?: (answer: ApprovalAnswer) => void;
		/** Whether the server still lists this approval as waiting (decided ones are never offered). */
		canAnswer?: (approvalId: string) => boolean;
	} = $props();

	// An automatic decision (Auto mode) never shows buttons; a request the server no longer lists
	// as waiting was decided elsewhere (another tab, the classifier, a remembered grant).
	const automatic = $derived((view.approval as { isAutomatic?: boolean }).isAutomatic === true);
	const decidedElsewhere = $derived(view.state === 'approval-requested' && !automatic && canAnswer?.(view.approval.id) === false);
</script>

{#if decidedElsewhere}
	<p class="text-sm text-muted-foreground" data-testid="approval-decided-elsewhere">Already handled: {view.title}</p>
{:else}
<Confirmation approval={view.approval as ToolUIPartApproval} state={view.state}>
	<ConfirmationTitle>
		<ConfirmationRequest>Allow <span class="font-mono text-[12.5px]">{view.title}</span>?</ConfirmationRequest>
		<ConfirmationAccepted>Approved: {view.title}</ConfirmationAccepted>
		<ConfirmationRejected>
			Rejected: {view.title}{view.approval.reason ? ` (${view.approval.reason})` : ''}
		</ConfirmationRejected>
	</ConfirmationTitle>
	{#if !automatic}
		<ConfirmationActions class="block">
			<ApprovalActions toolName={view.toolName} onAnswer={(body) => onApproval?.({ id: view.approval.id, ...body })} />
		</ConfirmationActions>
	{/if}
</Confirmation>
{/if}
