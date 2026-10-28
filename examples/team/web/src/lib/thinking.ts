/**
 * The Thinking setting of an agent: which choices its model offers. The catalog lists the levels of
 * many models (`thinking.levels`, OpenRouter's supported efforts); a model it knows only as
 * "reasoning" gets the common levels; a model it does not know gets every level, and the server
 * maps a level the model lacks onto the nearest one it takes.
 */
import type { ProviderModel } from '#lib/providers/models.js';

export type Thinking = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every level, weakest first (the order the select shows them). */
export const THINKING_ORDER: readonly Thinking[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const THINKING_LABEL: Record<Thinking, string> = {
	default: 'Model default',
	none: 'Off',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max'
};

export interface ThinkingChoices {
	/** Levels the select offers (besides "Model default"), weakest first. */
	levels: Thinking[];
	/** The model never reasons (the catalog says so): only "Model default" makes sense. */
	unsupported: boolean;
	/** The model always thinks: "Off" is not offered. */
	mandatory: boolean;
	/** The provider's own level, when the catalog says. */
	defaultLevel?: Thinking;
	/** Where the list comes from, in a sentence. */
	hint: string;
}

const isThinking = (v: string): v is Thinking => (THINKING_ORDER as readonly string[]).includes(v);

export function thinkingChoices(model: ProviderModel | undefined): ThinkingChoices {
	if (model === undefined) {
		return { levels: [...THINKING_ORDER], unsupported: false, mandatory: false, hint: 'The catalog does not know this model: a level it lacks is sent as the nearest one it takes.' };
	}
	const t = model.thinking;
	const mandatory = t?.mandatory === true;
	const defaultLevel = t?.defaultLevel !== undefined && isThinking(t.defaultLevel) ? t.defaultLevel : undefined;
	const listed = (t?.levels ?? []).filter(isThinking);
	if (listed.length > 0) {
		const levels = THINKING_ORDER.filter((l) => listed.includes(l) && !(mandatory && l === 'none'));
		return {
			levels,
			unsupported: false,
			mandatory,
			...(defaultLevel === undefined ? {} : { defaultLevel }),
			hint: `${model.name} takes ${levels.map((l) => THINKING_LABEL[l]).join(', ')}${mandatory ? '; it always thinks, so it cannot be turned off' : ''}.`
		};
	}
	if (t === undefined && model.reasoning === false) {
		return { levels: [], unsupported: true, mandatory: false, hint: `${model.name} does not think before it answers.` };
	}
	if (t === undefined && model.reasoning === undefined) {
		return { levels: [...THINKING_ORDER], unsupported: false, mandatory: false, hint: 'The catalog does not say whether this model thinks: a level it lacks is sent as the nearest one it takes.' };
	}
	const levels = THINKING_ORDER.filter((l) => l === 'none' || l === 'low' || l === 'medium' || l === 'high').filter((l) => !(mandatory && l === 'none'));
	return { levels, unsupported: false, mandatory, ...(defaultLevel === undefined ? {} : { defaultLevel }), hint: `${model.name} thinks; the catalog does not list its levels, so the common ones are offered.` };
}
