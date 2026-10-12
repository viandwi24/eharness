// "Discuss in chat" opens a thread with one `eh.event` message (`discuss.<kind>`) that carries the
// context for the model; the person sees it as a readable card, not as the raw marker. Pure, unit-tested.
export type DiscussCard = { label: string; title: string; body: string };

const KINDS: Record<string, string> = {
	'discuss.briefing': 'Discussing a briefing item',
	'discuss.alert': 'Discussing an alert',
	'discuss.run': 'Discussing a run'
};

export function discussCard(name: string, text: string): DiscussCard | undefined {
	const label = KINDS[name];
	if (!label) return undefined;
	// "The client opened this chat to talk about a briefing item: <title>\n\n<body>"
	const m = /^The client opened this chat to talk about [^:\n]+: ([^\n]*)\n*([\s\S]*)$/.exec(text.trim());
	return m ? { label, title: m[1]!.trim(), body: m[2]!.trim() } : { label, title: '', body: text.trim() };
}

/**
 * The outcome of a proposal the person decided in the Decision Center (`decision.proposal.approved`
 * / `.rejected`, seeded into the agent's chat for the model) as a readable card.
 */
export function proposalOutcomeCard(name: string, text: string): DiscussCard | undefined {
	const m = /^decision\.proposal\.(approved|rejected)$/.exec(name);
	if (!m) return undefined;
	const first = /^The client (?:approved|rejected) your proposal "(.*)"\.\s*$/m.exec(text);
	const note = /^The client's note \(their own words\): ([\s\S]*?)(?:\n(?:It is now|Nothing was created)|$)/m.exec(text);
	const approved = m[1] === 'approved';
	return {
		label: approved ? 'Proposal approved' : 'Proposal rejected',
		title: first?.[1] ?? '',
		body: [note ? `Your note: ${note[1]!.trim()}` : '', approved && /It is now a program/.test(text) ? 'It is now a program: follow it on the Programs page.' : '', !approved ? 'Nothing was created.' : ''].filter(Boolean).join('\n\n')
	};
}
