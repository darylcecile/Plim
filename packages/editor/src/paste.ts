/**
 * Paste pipeline for Plim.
 *
 * Notion-style paste behaviour: a single \n becomes a soft break inside a
 * block; a blank line (\n\n+) becomes a block boundary. Future phases will
 * layer markdown auto-detection (when a plain-text payload looks like
 * markdown), HTML clipboard parsing, and an extension hook (`paste.transform`)
 * so consumers can intercept before defaults run.
 *
 * This module is intentionally state-pure: it only exports helpers that take
 * an `ActionContext` and a `PasteData` payload, then commit a single
 * transaction. The caller (the view's `paste` handler in `index.ts`) is
 * responsible for `preventDefault`-ing the native event and routing the
 * clipboard data here.
 */
import type { ActionContext, BlockDescriptor, BlockNode, BlockPath, MarkInstance, TextSpan } from '@plim/core';
import { blockTextLength, getBlockAt, newId, normalizeText } from '@plim/core';
import { contentFromMarkdown, parseMarkdown } from '@plim/markdown';
import { sanitize, Sanitizer } from '@darylcecile/sanitizer';

/**
 * Normalised payload extracted from a `ClipboardEvent` by the view.
 * Future phases will read the html and files fields too.
 */
export type PasteData = {
	text: string;
	html: string;
	files: File[];
	/**
	 * JSON payload from the `application/x-plim` clipboard MIME, written by
	 * `clipboard.ts:writeClipboardMarkdown` whenever the editor copies a
	 * slice. When present, the paste pipeline treats this as authoritative
	 * over markdown/HTML — it's a lossless plim↔plim channel that preserves
	 * block types, attrs (image src, code language, callout tone), and full
	 * nesting that markdown couldn't round-trip without descriptor
	 * `fromMarkdown` hooks. Undefined when the source isn't a plim editor.
	 */
	plim?: string;
};

/**
 * Phase 1 — plain-text paste with Notion-style block splitting.
 *
 * Steps (within one transaction so undo restores the pre-paste state in a
 * single step):
 *
 * 1. Replace any non-collapsed selection on the same path with the first
 *    chunk of the paste (mirrors what `runBuiltInBeforeAction` does for typed
 *    text). Selections that span multiple blocks are not handled in this
 *    phase — the editor doesn't expose a multi-block range delete primitive
 *    yet, and pasting over a multi-block selection is a much rarer case.
 * 2. For each subsequent block-chunk, `splitBlock` at the running cursor and
 *    `insertText` the chunk into the new block. After a `splitBlock`, the
 *    new block's path is `[…parent, idx + 1]` and offset resets to 0 — we
 *    track this locally because `tx.insertText` takes an explicit
 *    path/offset, not "current selection".
 * 3. Set the final selection to the end of the last inserted chunk so the
 *    caret lands where a human would expect after a paste.
 *
 * Returns `true` if the paste was applied (caller has nothing to do),
 * `false` if it bailed (e.g., no selection, multi-block range) so the caller
 * can fall back to the previous behaviour.
 */
export function pastePlainText(text: string, ctx: ActionContext): boolean {
	const sel = ctx.state.selection;
	if (!sel) return false;

	// Multi-block range selections need a multi-block delete primitive we
	// don't have yet. Bail and let the caller fall back to a single-line
	// insert so we don't silently corrupt the doc.
	const samePath = pathsEqual(sel.anchor.path, sel.head.path);
	if (!samePath) return false;

	// Normalise newlines (Windows \r\n, classic Mac \r) and split into block
	// chunks. A run of two-or-more newlines is a paragraph boundary; a single
	// newline survives as a soft break inside a block (the trailing-<br>
	// sentinel in `view.renderTextSpans` makes the empty trailing line
	// visible).
	const normalised = text.replace(/\r\n?/g, '\n');
	const chunks = normalised.split(/\n{2,}/);
	if (chunks.length === 0) return false;

	const tx = ctx.createTransaction();
	const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
	const toOff = Math.max(sel.anchor.offset, sel.head.offset);

	// First chunk: replace any selected range, otherwise insert at caret.
	let path: BlockPath = sel.head.path;
	let offset = fromOff;
	const first = chunks[0] ?? '';
	if (fromOff !== toOff) {
		tx.replaceRange(path, fromOff, toOff, first ? [{ text: first }] : []);
		offset = fromOff + first.length;
	} else if (first) {
		tx.insertText(path, offset, first);
		offset = offset + first.length;
	}

	// Subsequent chunks: each preceded by a splitBlock at the current
	// position. We use the same block type for the split (no `newType`) so
	// pasting "a\n\nb" inside a heading produces two headings — matches
	// Notion's behaviour and keeps the operation type-stable.
	for (let i = 1; i < chunks.length; i++) {
		tx.splitBlock(path, offset);
		const last = path[path.length - 1] ?? 0;
		path = [...path.slice(0, -1), last + 1];
		offset = 0;
		const chunk = chunks[i] ?? '';
		if (chunk) {
			tx.insertText(path, offset, chunk);
			offset = chunk.length;
		}
	}

	tx.setSelection({
		anchor: { path, offset },
		head: { path, offset },
	});
	tx.commit();
	return true;
}

function pathsEqual(a: BlockPath, b: BlockPath): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 2 — markdown auto-detect.
//
// We don't try to be clever: a paste is "markdown-ish" only when it contains
// at least one *block-level* marker on a line by itself. Heading prefixes
// (`# `..`###### `), list bullets (`- `, `* `, `+ `, `1. `), block quotes
// (`> `), thematic breaks (`---`/`***`), and fenced code (` ``` `).
//
// Inline-only markdown (a `**bold**` mention in prose, a stray `*emphasis*`)
// is intentionally NOT detected: the false-positive rate from prose with
// asterisks/underscores is too high, and a user who wants those treated as
// formatting can paste from a markdown source that contains a block marker
// somewhere, or rely on a future explicit "paste as markdown" command.
//
// The regex below is anchored to start-of-line (we operate on the split
// array) so we don't get tripped up by `1.` appearing mid-sentence.
const MARKDOWN_BLOCK_MARKERS: RegExp[] = [
	/^#{1,6}\s/, // ATX heading
	/^[-*+]\s/, // bullet list
	/^\d+\.\s/, // numbered list
	/^>\s/, // block quote
	/^```/, // fenced code
	/^[-*_]{3,}\s*$/, // thematic break (--- *** ___)
];

export function looksLikeMarkdown(text: string): boolean {
	const normalised = text.replace(/\r\n?/g, '\n');
	const lines = normalised.split('\n');
	for (const line of lines) {
		for (const re of MARKDOWN_BLOCK_MARKERS) {
			if (re.test(line)) return true;
		}
	}
	return false;
}

/**
 * Phase 2 — paste markdown.
 *
 * Parses the pasted text via `@plim/markdown.contentFromMarkdown` and inserts
 * the resulting blocks at the caret. We deliberately do NOT try to merge the
 * first parsed block back into the surrounding text run — markdown blocks
 * carry their own type/attrs (headings, lists, code), and merging would
 * either drop that information or surprise the user. Instead:
 *
 * 1. If the cursor is in an empty block, that block is replaced wholesale by
 *    the parsed blocks (so pasting markdown into a fresh document yields
 *    clean structure with no leading blank line).
 * 2. Otherwise the current block is split at the cursor and the parsed
 *    blocks are inserted between the two halves.
 *
 * In both paths the caret lands at the end of the *last* parsed block, so a
 * follow-up keystroke continues at the natural place for the document.
 */
export function pasteMarkdown(text: string, ctx: ActionContext, blocks?: BlockDescriptor[]): boolean {
	const sel = ctx.state.selection;
	if (!sel) return false;
	if (!pathsEqual(sel.anchor.path, sel.head.path)) return false;

	const path = sel.head.path;
	const block = getBlockAt(ctx.state.doc, path);
	if (!block) return false;

	const normalised = text.replace(/\r\n?/g, '\n');
	// Use `parseMarkdown` directly so registered descriptors' `fromMarkdown`
	// hooks get a peek at every line. This is what restores callouts, custom
	// admonitions, etc. on round-trip — without it, `> [!INFO] …` parses as
	// a built-in `quote`, dropping the descriptor type.
	const doc = parseMarkdown(normalised.split('\n'), blocks ? { blocks } : undefined);
	// `contentFromMarkdown` emits an empty paragraph for every blank source
	// line — that's deliberate (round-trips for the rest of the pipeline)
	// but for paste purposes blank lines are just separators between blocks
	// and shouldn't pollute the doc with empty paragraphs. Drop them.
	const parsed = doc.children.filter(
		(b) => !(b.type === 'paragraph' && (!b.text || b.text.length === 0))
	);
	if (parsed.length === 0) return false;

	const tx = ctx.createTransaction();
	const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
	const toOff = Math.max(sel.anchor.offset, sel.head.offset);

	// Resolve the parent path so we can address sibling indices for inserts.
	// Top-level path looks like `[i]`; nested would be `[…, i]`. The block
	// index in its parent is the last segment.
	const parentPath = path.slice(0, -1);
	const blockIdx = path[path.length - 1] ?? 0;

	const isEmpty = blockTextLength(block) === 0;

	// Helper: text length of last parsed block, for caret placement.
	const lastParsed = parsed[parsed.length - 1] as BlockNode;
	const lastLen = lastParsed.text ? lastParsed.text.reduce((n, s) => n + s.text.length, 0) : 0;

	if (isEmpty) {
		// Replace the empty block in-place: insert all parsed blocks at the
		// current index, then remove the (now-shifted) empty block.
		for (let i = 0; i < parsed.length; i++) {
			tx.insertBlock([...parentPath, blockIdx + i], parsed[i] as BlockNode);
		}
		// After inserts, the originally-empty block sits at index
		// blockIdx + parsed.length.
		tx.removeBlock([...parentPath, blockIdx + parsed.length]);
		const lastPath: BlockPath = [...parentPath, blockIdx + parsed.length - 1];
		tx.setSelection({
			anchor: { path: lastPath, offset: lastLen },
			head: { path: lastPath, offset: lastLen },
		});
		tx.commit();
		return true;
	}

	// Non-empty current block: drop any selected range first (so the paste
	// replaces the selection), then split, then insert parsed blocks before
	// the right-half block.
	if (fromOff !== toOff) {
		tx.replaceRange(path, fromOff, toOff, []);
	}
	tx.splitBlock(path, fromOff);
	// After split, the right half lives at blockIdx + 1 (per `splitBlock`
	// op's selection update). Insert parsed blocks at that index, pushing
	// the right half to blockIdx + 1 + parsed.length.
	for (let i = 0; i < parsed.length; i++) {
		tx.insertBlock([...parentPath, blockIdx + 1 + i], parsed[i] as BlockNode);
	}
	const lastPath: BlockPath = [...parentPath, blockIdx + parsed.length];
	tx.setSelection({
		anchor: { path: lastPath, offset: lastLen },
		head: { path: lastPath, offset: lastLen },
	});
	tx.commit();
	return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 0 — Plim-native (lossless plim↔plim via the `application/x-plim` MIME).
//
// When the source clipboard came from another plim editor, `clipboard.ts`
// wrote a JSON envelope to the OS clipboard. This path treats it as
// authoritative: types, attrs (image src, code language, callout tone),
// and full nesting are preserved exactly. Compared to the markdown path
// it sidesteps the lossy serializer altogether — useful for blocks like
// raw HTML, embeds, images, tables, or any descriptor without a
// `fromMarkdown` hook.

const PLIM_CLIPBOARD_VERSION = 1;

/** Recursively assign fresh ids so the pasted slice can't collide with existing blocks. */
function reassignIds(blocks: BlockNode[]): BlockNode[] {
	return blocks.map((b) => {
		const out: BlockNode = { ...b, id: newId() };
		if (b.children) out.children = reassignIds(b.children);
		return out;
	});
}

function isValidBlockNode(x: unknown): x is BlockNode {
	if (!x || typeof x !== 'object') return false;
	const o = x as Record<string, unknown>;
	if (typeof o.type !== 'string') return false;
	// id may be missing/empty in alien payloads; we re-id anyway.
	return true;
}

/**
 * Phase 0 paste: lossless plim-native blocks via the custom MIME envelope.
 * Returns true on success. Insertion logic mirrors `pasteMarkdown` so the
 * caret behaviour and undo grouping are consistent across phases.
 */
export function pastePlimNative(payload: string, ctx: ActionContext): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== 'object') return false;
	const env = parsed as { version?: unknown; blocks?: unknown };
	if (typeof env.version !== 'number' || env.version > PLIM_CLIPBOARD_VERSION) return false;
	if (!Array.isArray(env.blocks)) return false;
	const incoming = env.blocks.filter(isValidBlockNode) as BlockNode[];
	if (incoming.length === 0) return false;
	const fresh = reassignIds(incoming);

	const sel = ctx.state.selection;
	if (!sel) return false;
	if (!pathsEqual(sel.anchor.path, sel.head.path)) return false;
	const path = sel.head.path;
	const block = getBlockAt(ctx.state.doc, path);
	if (!block) return false;

	const tx = ctx.createTransaction();
	const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
	const toOff = Math.max(sel.anchor.offset, sel.head.offset);
	const parentPath = path.slice(0, -1);
	const blockIdx = path[path.length - 1] ?? 0;
	const isEmpty = blockTextLength(block) === 0;
	const lastBlock = fresh[fresh.length - 1] as BlockNode;
	const lastLen = lastBlock.text ? lastBlock.text.reduce((n, s) => n + s.text.length, 0) : 0;

	if (isEmpty) {
		for (let i = 0; i < fresh.length; i++) tx.insertBlock([...parentPath, blockIdx + i], fresh[i] as BlockNode);
		tx.removeBlock([...parentPath, blockIdx + fresh.length]);
		const lastPath: BlockPath = [...parentPath, blockIdx + fresh.length - 1];
		tx.setSelection({ anchor: { path: lastPath, offset: lastLen }, head: { path: lastPath, offset: lastLen } });
		tx.commit();
		return true;
	}
	if (fromOff !== toOff) tx.replaceRange(path, fromOff, toOff, []);
	tx.splitBlock(path, fromOff);
	for (let i = 0; i < fresh.length; i++) tx.insertBlock([...parentPath, blockIdx + 1 + i], fresh[i] as BlockNode);
	const lastPath: BlockPath = [...parentPath, blockIdx + fresh.length];
	tx.setSelection({ anchor: { path: lastPath, offset: lastLen }, head: { path: lastPath, offset: lastLen } });
	tx.commit();
	return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 3 — HTML clipboard.
//
// When the OS clipboard contains a `text/html` payload (the common case when
// pasting from a browser, Notion, Google Docs, Word-on-the-web, Slack, etc.)
// we walk the HTML tree directly instead of round-tripping through plain
// text. This preserves marks (bold/italic/code/links) and structural blocks
// (headings, lists, quotes, code, dividers) at much higher fidelity than
// markdown auto-detect can. The HTML is run through `@darylcecile/sanitizer`
// in safe mode first so any `<script>`, event-handler attributes, or
// `javascript:` URLs in the clipboard never reach our DOM parser.

type WalkCtx = {
	marks: MarkInstance[];
	link: string | null;
};

const TAG_TO_MARK: Record<string, MarkInstance['type'] | undefined> = {
	STRONG: 'bold',
	B: 'bold',
	EM: 'italic',
	I: 'italic',
	CODE: 'code',
	S: 'strikethrough',
	DEL: 'strikethrough',
	STRIKE: 'strikethrough',
	U: 'underline',
};

/**
 * Walk a node's inline children, accumulating text spans with the marks
 * implied by the surrounding tags. Block-level descendants (e.g., a stray
 * `<p>` inside a `<li>`) are flattened to their text so the caller's block
 * boundary is the only one that matters.
 */
function collectInline(node: Node, ctx: WalkCtx): TextSpan[] {
	if (node.nodeType === Node.TEXT_NODE) {
		const t = node.nodeValue ?? '';
		if (!t) return [];
		const marks: MarkInstance[] = [...ctx.marks];
		if (ctx.link) marks.push({ type: 'link', attrs: { href: ctx.link } });
		return marks.length ? [{ text: t, marks }] : [{ text: t }];
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return [];
	const el = node as Element;
	const tag = el.tagName;

	// `<br>` becomes a soft break inside the current run.
	if (tag === 'BR') {
		const marks: MarkInstance[] = [...ctx.marks];
		if (ctx.link) marks.push({ type: 'link', attrs: { href: ctx.link } });
		return marks.length ? [{ text: '\n', marks }] : [{ text: '\n' }];
	}

	// Inline-mark wrappers: push the implied mark, recurse, pop.
	const markType = TAG_TO_MARK[tag];
	const isLink = tag === 'A';
	const pushed: MarkInstance | null = markType ? { type: markType } : null;
	const linkBefore = ctx.link;
	if (pushed) ctx.marks.push(pushed);
	if (isLink) {
		const href = el.getAttribute('href') ?? '';
		// `javascript:` is sanitiser-stripped; we still guard here in case a
		// consumer plumbed in custom HTML that bypassed sanitisation.
		ctx.link = /^javascript:/i.test(href) ? linkBefore : href || linkBefore;
	}
	const out: TextSpan[] = [];
	for (const child of Array.from(el.childNodes)) {
		out.push(...collectInline(child, ctx));
	}
	if (pushed) ctx.marks.pop();
	if (isLink) ctx.link = linkBefore;
	return out;
}

/**
 * Convert one element to one block (or, in a few cases like nested lists,
 * multiple blocks). Returns `[]` for nodes that produce no block content
 * (whitespace text, comments, unsupported elements).
 */
function elementToBlocks(el: Element): BlockNode[] {
	const tag = el.tagName;

	// Headings: clamp to plim's 1..3 range.
	const headingMatch = /^H([1-6])$/.exec(tag);
	if (headingMatch) {
		const level = Math.min(3, parseInt(headingMatch[1]!, 10));
		const text = normalizeText(collectInline(el, { marks: [], link: null }));
		return [{ id: newId(), type: 'heading', attrs: { level }, text }];
	}

	if (tag === 'P' || tag === 'DIV') {
		const text = normalizeText(collectInline(el, { marks: [], link: null }));
		// Skip empty paragraphs/divs (very common when pasting from rich-text
		// sources that wrap each line in its own div).
		if (text.length === 0) return [];
		return [{ id: newId(), type: 'paragraph', text }];
	}

	if (tag === 'BLOCKQUOTE') {
		const text = normalizeText(collectInline(el, { marks: [], link: null }));
		return [{ id: newId(), type: 'quote', text }];
	}

	if (tag === 'PRE') {
		// Prefer the contained <code> if present; harvest a `language-X`
		// classname for the editor's `language` attr.
		const code = el.querySelector('code') ?? el;
		let lang = '';
		if (code instanceof Element) {
			const cls = code.getAttribute('class') ?? '';
			const m = /(?:^|\s)language-(\S+)/.exec(cls);
			if (m) lang = m[1] ?? '';
		}
		const txt = code.textContent ?? '';
		return [
			{
				id: newId(),
				type: 'code',
				...(lang ? { attrs: { language: lang } } : {}),
				text: txt ? [{ text: txt }] : [],
			},
		];
	}

	if (tag === 'HR') {
		return [{ id: newId(), type: 'divider' }];
	}

	if (tag === 'UL' || tag === 'OL') {
		const blocks: BlockNode[] = [];
		const itemType = tag === 'UL' ? 'bulleted_list_item' : 'numbered_list_item';
		for (const li of Array.from(el.children)) {
			if (li.tagName !== 'LI') continue;
			// Pull out direct text content of the <li> (everything except
			// nested lists, which we recurse into). This mirrors how Notion
			// flattens nested HTML lists into typed blocks.
			const text = normalizeText(collectInline(liInlinePortion(li), { marks: [], link: null }));
			blocks.push({ id: newId(), type: itemType, text });
			for (const nested of Array.from(li.children)) {
				if (nested.tagName === 'UL' || nested.tagName === 'OL') {
					blocks.push(...elementToBlocks(nested));
				}
			}
		}
		return blocks;
	}

	if (tag === 'LI') {
		// Bare <li> (clipboard fragment without surrounding list) — treat as
		// a bulleted item.
		const text = normalizeText(collectInline(liInlinePortion(el), { marks: [], link: null }));
		return [{ id: newId(), type: 'bulleted_list_item', text }];
	}

	// Generic inline-only element at the top level: flatten to a paragraph.
	const text = normalizeText(collectInline(el, { marks: [], link: null }));
	if (text.length === 0) return [];
	return [{ id: newId(), type: 'paragraph', text }];
}

/**
 * Build a synthetic element containing only the inline-portion children of
 * an `<li>` (skipping nested lists). We can't mutate the source DOM since
 * the caller may walk it again, so we clone the relevant nodes.
 */
function liInlinePortion(li: Element): Element {
	const wrap = li.ownerDocument.createElement('span');
	for (const child of Array.from(li.childNodes)) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			const t = (child as Element).tagName;
			if (t === 'UL' || t === 'OL') continue;
		}
		wrap.appendChild(child.cloneNode(true));
	}
	return wrap;
}

/**
 * Phase 3 — paste HTML.
 *
 * Sanitises the html, parses it, walks the body's children, and inserts the
 * resulting blocks at the caret using the same insertion strategy as
 * `pasteMarkdown` (replace empty block in place, otherwise split + insert
 * between halves).
 */
export function pasteHtml(html: string, ctx: ActionContext): boolean {
	const sel = ctx.state.selection;
	if (!sel) return false;
	if (!pathsEqual(sel.anchor.path, sel.head.path)) return false;

	// Strip script-capable content first. The default safe config also
	// allow-lists ~100 elements; anything else is removed wholesale, which
	// matches what we want for paste (e.g., `<form>`, `<iframe>` shouldn't
	// land in the doc as a paragraph of garbage). We also opt class into
	// the allow-list because syntax-highlighting CSS frameworks (Prism,
	// hljs, GitHub) tag fenced code with `class="language-ts"` — we read
	// the language back off it when building a `code` block.
	const safe = sanitize(html, { sanitizer: pasteSanitizer });
	if (!safe.trim()) return false;
	const parser = new DOMParser();
	const doc = parser.parseFromString(`<!doctype html><body>${safe}</body>`, 'text/html');
	const body = doc.body;
	if (!body || !body.firstChild) return false;

	// Some clipboard payloads wrap everything in a single root (e.g.,
	// Microsoft's `<html><body><!--StartFragment--><div>…`) — the sanitiser
	// keeps the inner div but it becomes our only top-level block. Walk
	// body.children directly: each top-level element becomes one or more
	// blocks; orphan text-nodes get wrapped into a paragraph.
	const blocks: BlockNode[] = [];
	let textBuffer: TextSpan[] = [];
	const flushBuffer = () => {
		const norm = normalizeText(textBuffer);
		if (norm.length > 0) blocks.push({ id: newId(), type: 'paragraph', text: norm });
		textBuffer = [];
	};
	for (const child of Array.from(body.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) {
			const t = child.nodeValue ?? '';
			if (t.trim()) textBuffer.push({ text: t });
			continue;
		}
		if (child.nodeType !== Node.ELEMENT_NODE) continue;
		const el = child as Element;
		// Inline-only top-level elements (e.g., `<span>foo</span>`) get
		// folded into the running paragraph buffer. Block-level elements
		// flush the buffer and emit their own blocks.
		if (isInlineLikeTop(el)) {
			textBuffer.push(...collectInline(el, { marks: [], link: null }));
			continue;
		}
		flushBuffer();
		blocks.push(...elementToBlocks(el));
	}
	flushBuffer();
	if (blocks.length === 0) return false;

	// Insertion identical to `pasteMarkdown`. Kept inline so the two paths
	// remain readable rather than over-DRYed.
	const path = sel.head.path;
	const block = getBlockAt(ctx.state.doc, path);
	if (!block) return false;
	const tx = ctx.createTransaction();
	const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
	const toOff = Math.max(sel.anchor.offset, sel.head.offset);
	const parentPath = path.slice(0, -1);
	const blockIdx = path[path.length - 1] ?? 0;
	const isEmpty = blockTextLength(block) === 0;
	const lastParsed = blocks[blocks.length - 1] as BlockNode;
	const lastLen = lastParsed.text ? lastParsed.text.reduce((n, s) => n + s.text.length, 0) : 0;

	if (isEmpty) {
		for (let i = 0; i < blocks.length; i++) {
			tx.insertBlock([...parentPath, blockIdx + i], blocks[i] as BlockNode);
		}
		tx.removeBlock([...parentPath, blockIdx + blocks.length]);
		const lastPath: BlockPath = [...parentPath, blockIdx + blocks.length - 1];
		tx.setSelection({
			anchor: { path: lastPath, offset: lastLen },
			head: { path: lastPath, offset: lastLen },
		});
		tx.commit();
		return true;
	}
	if (fromOff !== toOff) tx.replaceRange(path, fromOff, toOff, []);
	tx.splitBlock(path, fromOff);
	for (let i = 0; i < blocks.length; i++) {
		tx.insertBlock([...parentPath, blockIdx + 1 + i], blocks[i] as BlockNode);
	}
	const lastPath: BlockPath = [...parentPath, blockIdx + blocks.length];
	tx.setSelection({
		anchor: { path: lastPath, offset: lastLen },
		head: { path: lastPath, offset: lastLen },
	});
	tx.commit();
	return true;
}

const BLOCK_LIKE_TAGS = new Set([
	'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
	'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR',
	'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
	'ARTICLE', 'SECTION', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION',
]);

function isInlineLikeTop(el: Element): boolean {
	return !BLOCK_LIKE_TAGS.has(el.tagName);
}

// Module-singleton sanitiser: W3C safe defaults plus `class` (so we can
// pluck the `language-X` hint off pasted `<code>` blocks). Created once;
// the sanitiser is stateless across calls.
const pasteSanitizer = (() => {
	const s = new Sanitizer('default');
	s.allowAttribute('class');
	return s;
})();
