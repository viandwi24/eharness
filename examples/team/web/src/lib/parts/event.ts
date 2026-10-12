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
