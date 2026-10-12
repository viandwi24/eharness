// Prompts written for the model are hard-wrapped at ~80 columns. For display, a line break inside a
// paragraph is a space; blank lines, list items, headings, quotes, tables and fenced code keep theirs. Pure.

const STRUCTURAL = /^(\s*([-*+]|\d+[.)])\s|\s{2,}\S|#{1,6}\s|>|\||```|---|===)/;

export function unwrapText(text: string): string {
	const out: string[] = [];
	let fenced = false;
	for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
		if (line.trimStart().startsWith('```')) {
			fenced = !fenced;
			out.push(line);
			continue;
		}
		const prev = out.at(-1);
		const joinable = !fenced && prev !== undefined && prev.trim() !== '' && line.trim() !== '' && !STRUCTURAL.test(line) && !/^(\s*#{1,6}\s|```|\|)/.test(prev) && !prev.trimStart().startsWith('```');
		if (joinable) out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
		else out.push(line);
	}
	return out.join('\n');
}
