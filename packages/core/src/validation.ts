import type { EditorState } from './transaction.js';
import { blockTextLength } from './document.js';
import { getBlockAt, selectionIsEmpty } from './selection.js';

export type ValidationRuleName =
	| 'selectionNotEmpty'
	| 'blockSupportsDecoration'
	| 'startOfBlock'
	| 'endOfBlock'
	| 'precededByWhitespace'
	| 'inTextBlock';

export type ValidationRule =
	| ValidationRuleName
	| { kind: 'and'; rules: ValidationRule[] }
	| { kind: 'or'; rules: ValidationRule[] }
	| { kind: 'not'; rule: ValidationRule }
	| { kind: 'predicate'; name?: string; predicate: (ctx: ValidationContext) => boolean };

export type ValidationContext = {
	state: EditorState;
	supportsDecoration: (blockType: string) => boolean;
};

export type ValidationBuilders = {
	and: (rules: ValidationRule[]) => ValidationRule;
	or: (rules: ValidationRule[]) => ValidationRule;
	not: (rule: ValidationRule) => ValidationRule;
	/** Escape hatch for extension-defined predicates. The optional `name` is
	 *  used in error messages and devtools but has no runtime effect. */
	predicate: (predicate: (ctx: ValidationContext) => boolean, name?: string) => ValidationRule;
};

export const builders: ValidationBuilders = {
	and: (rules) => ({ kind: 'and', rules }),
	or: (rules) => ({ kind: 'or', rules }),
	not: (rule) => ({ kind: 'not', rule }),
	predicate: (predicate, name) => ({ kind: 'predicate', predicate, ...(name ? { name } : {}) }),
};

export function evalRule(rule: ValidationRule, ctx: ValidationContext): boolean {
	if (typeof rule === 'string') return evalNamed(rule, ctx);
	if (rule.kind === 'and') return rule.rules.every((r) => evalRule(r, ctx));
	if (rule.kind === 'or') return rule.rules.some((r) => evalRule(r, ctx));
	if (rule.kind === 'not') return !evalRule(rule.rule, ctx);
	return rule.predicate(ctx);
}

function evalNamed(name: ValidationRuleName, ctx: ValidationContext): boolean {
	const { state } = ctx;
	const sel = state.selection;
	const block = getBlockAt(state.doc, sel.head.path);
	switch (name) {
		case 'selectionNotEmpty':
			return !selectionIsEmpty(sel);
		case 'blockSupportsDecoration':
			return !!block && ctx.supportsDecoration(block.type);
		case 'inTextBlock':
			return !!block && block.text !== undefined;
		case 'startOfBlock':
			return sel.head.offset === 0;
		case 'endOfBlock':
			return !!block && sel.head.offset >= blockTextLength(block);
		case 'precededByWhitespace': {
			if (!block || !block.text) return sel.head.offset === 0;
			if (sel.head.offset === 0) return true;
			let pos = 0;
			for (const span of block.text) {
				const end = pos + span.text.length;
				if (sel.head.offset <= end) {
					const localIdx = sel.head.offset - pos - 1;
					if (localIdx < 0) return true;
					const ch = span.text[localIdx];
					return !!ch && /\s/.test(ch);
				}
				pos = end;
			}
			return false;
		}
	}
}
