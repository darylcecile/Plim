import type { EditorState } from './transaction.js';
import { blockTextLength, hasMark } from './document.js';
import { comparePaths, getBlockAt, nextBlockPath, samePath, selectionIsEmpty } from './selection.js';

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
	| { kind: 'predicate'; name?: string; predicate: (ctx: ValidationContext) => boolean }
	| { kind: 'markActiveInSelection'; name: string }
	| { kind: 'blockTypeIs'; name: string };

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
	/**
	 * True when every text-bearing block in the current selection range is
	 * fully covered by mark `name` over its overlapping portion. For a
	 * collapsed selection this is always false (use `selectionNotEmpty` to
	 * gate visibility).  Mirrors the semantics that `tx.toggleMark` uses to
	 * decide whether the toggle adds or removes — so the toolbar's "active"
	 * highlight matches what clicking the button would do.
	 */
	markActiveInSelection: (name: string) => ValidationRule;
	/** True when the block at the selection head has type `name`. */
	blockTypeIs: (name: string) => ValidationRule;
};

export const builders: ValidationBuilders = {
	and: (rules) => ({ kind: 'and', rules }),
	or: (rules) => ({ kind: 'or', rules }),
	not: (rule) => ({ kind: 'not', rule }),
	predicate: (predicate, name) => ({ kind: 'predicate', predicate, ...(name ? { name } : {}) }),
	markActiveInSelection: (name) => ({ kind: 'markActiveInSelection', name }),
	blockTypeIs: (name) => ({ kind: 'blockTypeIs', name }),
};

export function evalRule(rule: ValidationRule, ctx: ValidationContext): boolean {
	if (typeof rule === 'string') return evalNamed(rule, ctx);
	if (rule.kind === 'and') return rule.rules.every((r) => evalRule(r, ctx));
	if (rule.kind === 'or') return rule.rules.some((r) => evalRule(r, ctx));
	if (rule.kind === 'not') return !evalRule(rule.rule, ctx);
	if (rule.kind === 'predicate') return rule.predicate(ctx);
	if (rule.kind === 'markActiveInSelection') return evalMarkActive(rule.name, ctx);
	if (rule.kind === 'blockTypeIs') return evalBlockTypeIs(rule.name, ctx);
	return false;
}

function evalMarkActive(name: string, ctx: ValidationContext): boolean {
	const { state } = ctx;
	const sel = state.selection;
	if (selectionIsEmpty(sel)) return false;
	// Order anchor/head so we walk forward.
	const cmp = comparePaths(sel.anchor.path, sel.head.path);
	const fwd = cmp < 0 || (cmp === 0 && sel.anchor.offset <= sel.head.offset);
	const from = fwd ? sel.anchor : sel.head;
	const to = fwd ? sel.head : sel.anchor;
	if (samePath(from.path, to.path)) {
		const block = getBlockAt(state.doc, from.path);
		if (!block || !block.text) return false;
		return hasMark(block.text, from.offset, to.offset, name);
	}
	// Multi-block: every text-bearing block in [from..to] must be marked
	// over its overlapping range. Skip non-text blocks (atomic) — they
	// can't carry inline marks; their presence shouldn't flip the toolbar
	// off.
	const first = getBlockAt(state.doc, from.path);
	if (first?.text) {
		if (!hasMark(first.text, from.offset, blockTextLength(first), name)) return false;
	}
	let cur = nextBlockPath(state.doc, from.path);
	while (cur && comparePaths(cur, to.path) < 0) {
		const blk = getBlockAt(state.doc, cur);
		if (blk?.text && blockTextLength(blk) > 0) {
			if (!hasMark(blk.text, 0, blockTextLength(blk), name)) return false;
		}
		cur = nextBlockPath(state.doc, cur);
	}
	const last = getBlockAt(state.doc, to.path);
	if (last?.text && to.offset > 0) {
		if (!hasMark(last.text, 0, to.offset, name)) return false;
	}
	return true;
}

function evalBlockTypeIs(name: string, ctx: ValidationContext): boolean {
	const block = getBlockAt(ctx.state.doc, ctx.state.selection.head.path);
	return !!block && block.type === name;
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
