// Copy/cut clipboard pipeline. Bridges the view's two selection models
// (multi-block id Set + text-range PSelection) to the markdown serializer
// so registered blocks' `toMarkdown` actually fires when the user copies
// or cuts. Without this, the browser's default behaviour serializes the
// rendered DOM and ignores descriptor-level markdown — callouts paste as
// `<aside>` text, code blocks lose fences, etc.
//
// Two slice shapes:
//  - block-set:    selection.ids has ≥1 entry. Walk the doc; for each
//                  selected block, take it (deep) and stop recursing.
//                  Preserves nesting when the user selected an ancestor.
//  - cross-range:  text selection where anchor.path !== head.path. We
//                  flatten the doc, take blocks between (inclusive),
//                  trim text on the start/end blocks, drop nesting
//                  (each block becomes its own top-level entry —
//                  appropriate for text-range semantics).
// Single-block text ranges intentionally return null so the browser's
// native partial-text copy stays in charge (no surprise block prefixes).

import {
	type BlockDescriptor,
	type BlockNode,
	type DocumentNode,
	type Selection as PSelection,
	type TextSpan,
	comparePaths,
	flattenBlocks,
	newId,
	samePath,
} from '@plim/core';
import { contentToMarkdown } from '@plim/markdown';

function cloneSpan(s: TextSpan): TextSpan {
	const out: TextSpan = { text: s.text };
	if (s.marks)
		out.marks = s.marks.map((m) => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type }));
	return out;
}

function cloneBlockDeep(b: BlockNode): BlockNode {
	const out: BlockNode = { id: newId('b'), type: b.type };
	if (b.attrs) out.attrs = { ...b.attrs };
	if (b.text) out.text = b.text.map(cloneSpan);
	if (b.children) out.children = b.children.map(cloneBlockDeep);
	return out;
}

function sliceTextSpans(spans: TextSpan[], from: number, to: number): TextSpan[] {
	if (from >= to) return [];
	const out: TextSpan[] = [];
	let off = 0;
	for (const s of spans) {
		const end = off + s.text.length;
		if (end <= from) {
			off = end;
			continue;
		}
		if (off >= to) break;
		const a = Math.max(from, off) - off;
		const b = Math.min(to, end) - off;
		const sliced = s.text.slice(a, b);
		if (sliced.length > 0) {
			const span: TextSpan = { text: sliced };
			if (s.marks) span.marks = s.marks.map((m) => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type }));
			out.push(span);
		}
		off = end;
	}
	return out;
}

function blockTextLen(b: BlockNode): number {
	if (!b.text) return 0;
	let n = 0;
	for (const s of b.text) n += s.text.length;
	return n;
}

/**
 * Build a slice from the view-layer multi-block selection. Returns
 * cloned blocks in document order; if a selected block has selected
 * descendants, only the ancestor is emitted (its subtree comes along
 * naturally via the deep clone).
 */
export function sliceFromBlockSelection(doc: DocumentNode, ids: ReadonlySet<string>): BlockNode[] {
	const out: BlockNode[] = [];
	function walk(nodes: BlockNode[]): void {
		for (const n of nodes) {
			if (ids.has(n.id)) {
				out.push(cloneBlockDeep(n));
				continue;
			}
			if (n.children?.length) walk(n.children);
		}
	}
	walk(doc.children);
	return out;
}

/**
 * Build a slice from a text-range selection that spans ≥2 blocks.
 * Returns null for single-block ranges (caller should let the browser
 * handle native partial-text copy). Also returns null for collapsed
 * selections.
 */
export function sliceFromTextRange(doc: DocumentNode, sel: PSelection): { blocks: BlockNode[]; start: { path: number[]; offset: number }; end: { path: number[]; offset: number } } | null {
	const cmp = comparePaths(sel.anchor.path, sel.head.path);
	let start = sel.anchor;
	let end = sel.head;
	if (cmp > 0 || (cmp === 0 && sel.anchor.offset > sel.head.offset)) {
		start = sel.head;
		end = sel.anchor;
	}
	if (samePath(start.path, end.path)) return null;
	const flat = flattenBlocks(doc);
	const startIdx = flat.findIndex((e) => samePath(e.path, start.path));
	const endIdx = flat.findIndex((e) => samePath(e.path, end.path));
	if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return null;
	const out: BlockNode[] = [];
	for (let i = startIdx; i <= endIdx; i++) {
		const b = flat[i]!.block;
		if (b.text === undefined) {
			// Atomic / container block in the middle. Include without children
			// (children, if any, are emitted as their own flat entries by the
			// surrounding loop).
			const clone: BlockNode = { id: newId('b'), type: b.type };
			if (b.attrs) clone.attrs = { ...b.attrs };
			out.push(clone);
			continue;
		}
		const len = blockTextLen(b);
		const from = i === startIdx ? start.offset : 0;
		const to = i === endIdx ? end.offset : len;
		const clone: BlockNode = { id: newId('b'), type: b.type, text: sliceTextSpans(b.text, from, to) };
		if (b.attrs) clone.attrs = { ...b.attrs };
		out.push(clone);
	}
	// Trim leading/trailing empties: if the user clicked at the very end of
	// the start block (or start of end block), the slice from that side is
	// empty and shouldn't render as a stray blank block.
	while (out.length && out[0]!.text !== undefined && (out[0]!.text!.length === 0 || out[0]!.text!.every((s) => s.text === ''))) out.shift();
	while (out.length && out[out.length - 1]!.text !== undefined && (out[out.length - 1]!.text!.length === 0 || out[out.length - 1]!.text!.every((s) => s.text === ''))) out.pop();
	if (out.length === 0) return null;
	return { blocks: out, start: { path: start.path.slice(), offset: start.offset }, end: { path: end.path.slice(), offset: end.offset } };
}

/**
 * Serialize the slice to markdown via `contentToMarkdown` (so each
 * descriptor's `toMarkdown` runs) and write it to the clipboard event
 * as `text/plain` and `text/markdown`. Also writes `application/x-plim`
 * with the raw BlockNode[] JSON so plim↔plim paste is lossless (preserves
 * block types, attrs, and nesting that markdown can't roundtrip without
 * per-descriptor `fromMarkdown` hooks). Caller is responsible for
 * `preventDefault`.
 */
export const PLIM_CLIPBOARD_MIME = 'application/x-plim';
export const PLIM_CLIPBOARD_VERSION = 1;

export function writeClipboardMarkdown(ev: ClipboardEvent, blocks: BlockNode[], descs: BlockDescriptor[]): boolean {
	if (!ev.clipboardData) return false;
	const md = contentToMarkdown({ type: 'doc', children: blocks }, { blocks: descs });
	ev.clipboardData.setData('text/plain', md);
	ev.clipboardData.setData('text/markdown', md);
	// Lossless plim-native channel. Wrap in a versioned envelope so we can
	// evolve the shape without breaking older readers (a future v2 reader
	// can downgrade gracefully).
	try {
		const payload = JSON.stringify({ version: PLIM_CLIPBOARD_VERSION, blocks });
		ev.clipboardData.setData(PLIM_CLIPBOARD_MIME, payload);
	} catch {
		// JSON.stringify can throw on cyclic structures (shouldn't happen
		// for plain BlockNode but stay defensive). The markdown fallback is
		// already written, so swallow.
	}
	return true;
}
