/**
 * Display filter for already-stored messages: hides leaked tool-call markup (DeepSeek DSML, Qwen,
 * Kimi, `<function_calls>`) from assistant text. Mirrors `stripLeakedToolMarkup` of the library
 * (spec 03 §11), which keeps new messages clean; fenced code is never touched.
 */
const BLOCKS: RegExp[] = [
	/<[｜|](?:DSML[｜|])?tool_calls>[\s\S]*?<\/[｜|](?:DSML[｜|])?tool_calls>/g,
	/<[｜|]tool[▁_]calls[▁_]begin[｜|]>[\s\S]*?<[｜|]tool[▁_]calls[▁_]end[｜|]>/g,
	/<[｜|]tool_calls_section_begin[｜|]>[\s\S]*?<[｜|]tool_calls_section_end[｜|]>/g,
	/<tool_call>[\s\S]*?<\/tool_call>/g,
	/<function_calls>[\s\S]*?<\/function_calls>/g,
	/<[｜|]DSML[｜|]\w+[\s\S]*$/,
	/<\/?[｜|]DSML[｜|][^<>\n]{0,200}>/g
];
const PARAM_TAIL = /^[\w.-]{1,64}"\s+string="(?:true|false)"\s*>[\s\S]*$/;

export function stripLeakedToolMarkup(text: string): string {
	if (!/[<"]/.test(text)) return text;
	if (PARAM_TAIL.test(text.trim()) && !text.includes('```')) return '';
	const parts = text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g);
	const out = parts
		.map((p, i) => {
			if (i % 2 === 1) return p;
			let r = p;
			for (const re of BLOCKS) r = r.replace(re, '');
			return r;
		})
		.join('');
	return out === text ? text : out.trim();
}
