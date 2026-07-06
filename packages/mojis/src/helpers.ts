// ──────────────────────────────────────────────────────────────────────────
// Helpers — block/path lookup, moji detection and grapheme boundaries.
// ──────────────────────────────────────────────────────────────────────────
//
// Mojis behave like ordinary text (no atomic selection). The only special
// behaviour they need is *correct whole-emoji deletion*: a native moji is an
// emoji glyph (often a multi-code-unit grapheme, e.g. a surrogate pair or a
// ZWJ sequence), and the editor's default delete removes a single UTF-16 code
// unit — which would split the glyph and leave a lone surrogate. So when the
// caret is adjacent to a moji we delete the whole grapheme cluster instead,
// exactly like a normal text box deletes an emoji in one keystroke.

import type { BlockNode, TextSpan, ValidationContext } from '@plim/core';
import { MOJI_MARK_NAME } from './mark.js';

/** Resolve a block by its document path, or `null` if the path is invalid. */
export function blockAtPath(
	doc: { children: readonly BlockNode[] },
	path: readonly number[],
): BlockNode | null {
	let node: { children?: readonly BlockNode[] } = doc;
	for (const idx of path) {
		const children = node.children;
		if (!children || idx < 0 || idx >= children.length) return null;
		node = children[idx]!;
	}
	return node as BlockNode;
}

/** Structural equality for document paths. */
export function pathsEqual(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Flattened plain text of a block's spans. */
export function flatText(spans: readonly TextSpan[]): string {
	return spans.map((s) => s.text).join('');
}

/** True if the code unit at `index` belongs to a moji-marked span. */
export function charHasMojiAt(spans: readonly TextSpan[], index: number): boolean {
	if (index < 0) return false;
	let pos = 0;
	for (const span of spans) {
		const end = pos + span.text.length;
		if (index >= pos && index < end) {
			return !!span.marks?.some((m) => m.type === MOJI_MARK_NAME);
		}
		pos = end;
	}
	return false;
}

/** Read the collapsed caret in a single block, or `null` for ranges. */
function collapsedCaret(ctx: ValidationContext): { block: BlockNode; offset: number } | null {
	const sel = ctx.state.selection;
	if (!sel) return null;
	if (!pathsEqual(sel.anchor.path, sel.head.path) || sel.anchor.offset !== sel.head.offset) return null;
	const block = blockAtPath(ctx.state.doc, sel.head.path);
	if (!block?.text) return null;
	return { block, offset: sel.head.offset };
}

/**
 * Validation predicate: a collapsed caret sits immediately *after* a moji, so
 * Backspace should remove the whole moji grapheme. False for range selections
 * (those delete normally).
 */
export function precededByMoji(ctx: ValidationContext): boolean {
	const c = collapsedCaret(ctx);
	if (!c) return false;
	if (c.offset <= 0) return false;
	return charHasMojiAt(c.block.text!, c.offset - 1);
}

/**
 * Validation predicate: a collapsed caret sits immediately *before* a moji, so
 * forward-Delete should remove the whole moji grapheme.
 */
export function followedByMoji(ctx: ValidationContext): boolean {
	const c = collapsedCaret(ctx);
	if (!c) return false;
	const len = flatText(c.block.text!).length;
	if (c.offset >= len) return false;
	return charHasMojiAt(c.block.text!, c.offset);
}

// A minimal structural view of Intl.Segmenter so this compiles regardless of
// the configured TypeScript `lib` (Intl.Segmenter is available at runtime in
// modern browsers and Node ≥ 16).
interface GraphemeSegmenter {
	segment(input: string): Iterable<{ index: number; segment: string }>;
}
function graphemeSegmenter(): GraphemeSegmenter | null {
	const Seg = (Intl as unknown as {
		Segmenter?: new (locales?: string, options?: { granularity: string }) => GraphemeSegmenter;
	}).Segmenter;
	if (typeof Seg !== 'function') return null;
	try {
		return new Seg(undefined, { granularity: 'grapheme' });
	} catch {
		return null;
	}
}

/**
 * Start offset of the grapheme cluster ending at `offset` (i.e. the extent a
 * Backspace should remove). Grapheme-aware so a native emoji — surrogate pair
 * or ZWJ sequence — is deleted whole. Falls back to surrogate-pair handling
 * when Intl.Segmenter is unavailable.
 */
export function previousGraphemeStart(text: string, offset: number): number {
	if (offset <= 0) return 0;
	const seg = graphemeSegmenter();
	if (seg) {
		let start = 0;
		for (const s of seg.segment(text)) {
			if (s.index >= offset) break;
			start = s.index;
		}
		return start;
	}
	const code = text.charCodeAt(offset - 1);
	if (offset >= 2 && code >= 0xdc00 && code <= 0xdfff) return offset - 2;
	return offset - 1;
}

/**
 * End offset of the grapheme cluster starting at `offset` (i.e. the extent a
 * forward-Delete should remove). See {@link previousGraphemeStart}.
 */
export function nextGraphemeEnd(text: string, offset: number): number {
	if (offset >= text.length) return text.length;
	const seg = graphemeSegmenter();
	if (seg) {
		for (const s of seg.segment(text)) {
			if (s.index > offset) return s.index;
		}
		return text.length;
	}
	const code = text.charCodeAt(offset);
	if (offset + 1 < text.length && code >= 0xd800 && code <= 0xdbff) return offset + 2;
	return offset + 1;
}
