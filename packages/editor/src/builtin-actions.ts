import {
	type ActionContext,
	type BlockDescriptor,
	type BlockNode,
	type EditorState,
	type MarkInstance,
	type TextSpan,
	blockTextLength,
	flattenBlocks,
	getBlockAt,
	marksAtOffset,
	nextBlockPath,
	prevBlockPath,
} from '@plim/core';

function pathsEqual(a: number[], b: number[]) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Built-in key handler. Returns true if the event was handled. */
export function runBuiltInKey(
	ev: KeyboardEvent,
	state: EditorState,
	ctx: ActionContext,
	_blocks: BlockDescriptor[]
): boolean {
	const sel = state.selection;
	const block = getBlockAt(state.doc, sel.head.path);
	if (!block) return false;

	// Arrow Up/Down — only intercept when at top/bottom *visual* line of block.
	// We let the browser handle in-block multi-line nav (the contenteditable wrapper
	// gives correct visual line breaks for free), and only force cross-block jumps
	// when the browser would otherwise stay inside this block.
	if (ev.key === 'ArrowUp' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
		// If at offset 0 of a single-line block, move to previous block end
		if (sel.head.offset === 0 && pathsEqual(sel.anchor.path, sel.head.path) && sel.anchor.offset === 0) {
			const prev = prevBlockPath(state.doc, sel.head.path);
			if (prev) {
				const prevBlock = getBlockAt(state.doc, prev);
				const len = prevBlock ? blockTextLength(prevBlock) : 0;
				const tx = ctx.createTransaction();
				tx.setSelection({ anchor: { path: prev, offset: len }, head: { path: prev, offset: len } });
				(tx.meta as Record<string, unknown>).addToHistory = false;
				tx.commit();
				return true;
			}
		}
		// allow native; browser will move within or to previous element
		return false;
	}
	if (ev.key === 'ArrowDown' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
		const len = blockTextLength(block);
		if (sel.head.offset === len && pathsEqual(sel.anchor.path, sel.head.path) && sel.anchor.offset === len) {
			const next = nextBlockPath(state.doc, sel.head.path);
			if (next) {
				const tx = ctx.createTransaction();
				tx.setSelection({ anchor: { path: next, offset: 0 }, head: { path: next, offset: 0 } });
				(tx.meta as Record<string, unknown>).addToHistory = false;
				tx.commit();
				return true;
			}
		}
		return false;
	}

	// Arrow Left at offset 0 → end of previous block
	if (ev.key === 'ArrowLeft' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
		if (sel.head.offset === 0) {
			const prev = prevBlockPath(state.doc, sel.head.path);
			if (prev) {
				const pb = getBlockAt(state.doc, prev);
				const len = pb ? blockTextLength(pb) : 0;
				const tx = ctx.createTransaction();
				tx.setSelection({ anchor: { path: prev, offset: len }, head: { path: prev, offset: len } });
				(tx.meta as Record<string, unknown>).addToHistory = false;
				tx.commit();
				return true;
			}
		}
		return false;
	}
	if (ev.key === 'ArrowRight' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
		const len = blockTextLength(block);
		if (sel.head.offset === len) {
			const next = nextBlockPath(state.doc, sel.head.path);
			if (next) {
				const tx = ctx.createTransaction();
				tx.setSelection({ anchor: { path: next, offset: 0 }, head: { path: next, offset: 0 } });
				(tx.meta as Record<string, unknown>).addToHistory = false;
				tx.commit();
				return true;
			}
		}
		return false;
	}

	// Tab / Shift+Tab — indent/outdent list-ish blocks
	if (ev.key === 'Tab') {
		if (block.type === 'bulleted_list_item' || block.type === 'numbered_list_item' || block.type === 'to_do' || block.type === 'toggle') {
			if (ev.shiftKey) {
				outdent(state, ctx, sel.head.path);
			} else {
				indent(state, ctx, sel.head.path);
			}
			return true;
		}
		// otherwise insert tab
		return false;
	}

	return false;
}

function indent(state: EditorState, ctx: ActionContext, path: number[]): void {
	if (path.length === 0) return;
	const idx = path[path.length - 1]!;
	if (idx === 0) return; // can't indent first item
	const parentPath = path.slice(0, -1);
	const siblingsContainer = parentPath.length === 0 ? state.doc : (getBlockAt(state.doc, parentPath) as { children?: BlockNode[] } | null);
	if (!siblingsContainer) return;
	const siblings = ('children' in siblingsContainer ? siblingsContainer.children : undefined) as BlockNode[] | undefined;
	if (!siblings) return;
	const target = siblings[idx - 1];
	const cur = siblings[idx];
	if (!target || !cur) return;
	const targetChildren = target.children?.length ?? 0;
	const newPath = [...parentPath, idx - 1, targetChildren];
	const tx = ctx.createTransaction();
	tx.moveBlock(path, newPath);
	tx.setSelection({ anchor: { path: newPath, offset: state.selection.head.offset }, head: { path: newPath, offset: state.selection.head.offset } });
	tx.commit();
}

function outdent(state: EditorState, ctx: ActionContext, path: number[]): void {
	if (path.length < 2) return;
	const grandPath = path.slice(0, -2);
	const parentIdx = path[path.length - 2]!;
	const newPath = [...grandPath, parentIdx + 1];
	const tx = ctx.createTransaction();
	tx.moveBlock(path, newPath);
	tx.setSelection({ anchor: { path: newPath, offset: state.selection.head.offset }, head: { path: newPath, offset: state.selection.head.offset } });
	tx.commit();
}

// ---- Markdown-style input rules ----
// Called *before* a character would be inserted. We always insert the typed
// character first (if any) — the caller did this already by routing here —
// and then apply transformations on the resulting text.

const LINE_RULES: Array<{ re: RegExp; when?: (block: BlockNode) => boolean; apply: (m: RegExpMatchArray, ctx: ActionContext, path: number[]) => void }> = [
	{
		re: /^(#{1,3}) $/,
		apply: (m, ctx, path) => {
			const level = m[1]!.length;
			const tx = ctx.createTransaction();
			tx.replaceRange(path, 0, m[0].length, []);
			tx.setBlockType(path, 'heading', { level });
			tx.setSelection({ anchor: { path, offset: 0 }, head: { path, offset: 0 } });
			tx.commit();
		},
	},
	{
		re: /^[-*+] $/,
		apply: (_m, ctx, path) => {
			const tx = ctx.createTransaction();
			tx.replaceRange(path, 0, 2, []);
			tx.setBlockType(path, 'bulleted_list_item');
			tx.setSelection({ anchor: { path, offset: 0 }, head: { path, offset: 0 } });
			tx.commit();
		},
	},
	{
		re: /^1\. $/,
		apply: (_m, ctx, path) => {
			const tx = ctx.createTransaction();
			tx.replaceRange(path, 0, 3, []);
			tx.setBlockType(path, 'numbered_list_item');
			tx.setSelection({ anchor: { path, offset: 0 }, head: { path, offset: 0 } });
			tx.commit();
		},
	},
	{
		// `[ ] ` or `[x] ` — only upgrade an empty bulleted_list_item to a to_do.
		// Rejects `[ ] ` typed in a fresh paragraph (and any non-bullet block)
		// so we don't surprise users who actually want literal brackets.
		re: /^\[([ xX]?)\] $/,
		when: (b) => b.type === 'bulleted_list_item',
		apply: (m, ctx, path) => {
			const checked = (m[1] ?? '').toLowerCase() === 'x';
			const tx = ctx.createTransaction();
			tx.replaceRange(path, 0, m[0].length, []);
			tx.setBlockType(path, 'to_do', { checked });
			tx.setSelection({ anchor: { path, offset: 0 }, head: { path, offset: 0 } });
			tx.commit();
		},
	},
	{
		re: /^> $/,
		apply: (_m, ctx, path) => {
			const tx = ctx.createTransaction();
			tx.replaceRange(path, 0, 2, []);
			tx.setBlockType(path, 'quote');
			tx.setSelection({ anchor: { path, offset: 0 }, head: { path, offset: 0 } });
			tx.commit();
		},
	},
	{
		re: /^>>> $/,
		apply: (_m, ctx, path) => {
			const tx = ctx.createTransaction();
			tx.replaceRange(path, 0, 4, []);
			tx.setBlockType(path, 'toggle', { open: true });
			tx.setSelection({ anchor: { path, offset: 0 }, head: { path, offset: 0 } });
			tx.commit();
		},
	},
	{
		re: /^```$/,
		apply: (_m, ctx, path) => {
			const tx = ctx.createTransaction();
			tx.replaceRange(path, 0, 3, []);
			tx.setBlockType(path, 'code');
			tx.setSelection({ anchor: { path, offset: 0 }, head: { path, offset: 0 } });
			tx.commit();
		},
	},
	{
		re: /^---$/,
		apply: (_m, ctx, path) => {
			const tx = ctx.createTransaction();
			tx.replaceRange(path, 0, 3, []);
			tx.setBlockType(path, 'divider');
			// add a fresh paragraph after for caret
			tx.commit();
		},
	},
];

const INLINE_RULES: Array<{
	re: RegExp;
	apply: (m: RegExpMatchArray, ctx: ActionContext, path: number[], offset: number) => void;
}> = [
	{
		// **bold**
		re: /\*\*([^*\n]+)\*\*$/,
		apply: (m, ctx, path, _offset) => applyMarkRule(m, ctx, path, 'bold'),
	},
	{
		// *italic*
		re: /(^|[^*])\*([^*\n]+)\*$/,
		apply: (m, ctx, path) => applyAsteriskItalic(m, ctx, path),
	},
	{
		// `code`
		re: /`([^`\n]+)`$/,
		apply: (m, ctx, path) => applyMarkRule(m, ctx, path, 'code'),
	},
	{
		// ~strike~
		re: /~([^~\n]+)~$/,
		apply: (m, ctx, path) => applyMarkRule(m, ctx, path, 'strikethrough'),
	},
];

function applyMarkRule(m: RegExpMatchArray, ctx: ActionContext, path: number[], markType: string): void {
	const matchEnd = (m.index ?? 0) + m[0].length;
	const matchStart = m.index ?? 0;
	const inner = m[1]!;
	const tx = ctx.createTransaction();
	// Replace whole match with inner text (no marks yet) then toggle mark.
	tx.replaceRange(path, matchStart, matchEnd, [{ text: inner }]);
	tx.toggleMark(markType, { path, from: matchStart, to: matchStart + inner.length });
	tx.setSelection({ anchor: { path, offset: matchStart + inner.length }, head: { path, offset: matchStart + inner.length } });
	tx.commit();
}

function applyAsteriskItalic(m: RegExpMatchArray, ctx: ActionContext, path: number[]): void {
	const prefix = m[1] ?? '';
	const inner = m[2]!;
	const start = (m.index ?? 0) + prefix.length;
	const end = (m.index ?? 0) + m[0].length;
	const tx = ctx.createTransaction();
	tx.replaceRange(path, start, end, [{ text: inner }]);
	tx.toggleMark('italic', { path, from: start, to: start + inner.length });
	tx.setSelection({ anchor: { path, offset: start + inner.length }, head: { path, offset: start + inner.length } });
	tx.commit();
}

/**
 * Insert text at caret; then run input rules over the resulting text.
 * Returns true if any rule fired (caller should not insert again).
 */
export function runBuiltInBeforeAction(text: string, state: EditorState, ctx: ActionContext): boolean {
	const sel = state.selection;
	const path = sel.head.path;
	const block = getBlockAt(state.doc, path);
	if (!block) return false;

	// Insert text first into the doc. New chars inherit the marks at the
	// caret offset (strictly-inside-a-run wins; at a run boundary the
	// intersection of the adjacent runs' marks is used) so typing in the
	// middle of an existing marked run extends the run instead of splitting
	// it. For a non-collapsed selection we use the marks at `fromOff` of the
	// pre-insert state — typed chars inherit the marks at the start of what
	// they replace, which matches user intent ("type to overwrite, keep the
	// formatting of what was selected").
	const tx = ctx.createTransaction();
	const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
	const toOff = Math.max(sel.anchor.offset, sel.head.offset);
	const samePathSel = pathsEqual(sel.anchor.path, sel.head.path);
	const insertOff = samePathSel && fromOff !== toOff ? fromOff : sel.head.offset;
	const inheritedMarks = marksAtOffset(block.text, insertOff);
	const span: TextSpan =
		inheritedMarks.length > 0 ? { text, marks: inheritedMarks } : { text };
	if (samePathSel && fromOff !== toOff) {
		tx.replaceRange(path, fromOff, toOff, [span]);
	} else {
		tx.insertText(path, sel.head.offset, text, inheritedMarks.length ? inheritedMarks : undefined);
	}
	tx.setSelection({
		anchor: { path, offset: (samePathSel ? fromOff : sel.head.offset) + text.length },
		head: { path, offset: (samePathSel ? fromOff : sel.head.offset) + text.length },
	});
	tx.commit();

	// Now check input rules against the (post-insert) state
	const next = ctx.state;
	const nextBlock = getBlockAt(next.doc, path);
	if (!nextBlock) return false;
	const txt = plainText(nextBlock);

	// Line rules: only when caret is at end-of-line and text is exactly one line
	if (text === ' ' || text === '`' || text === '-') {
		for (const rule of LINE_RULES) {
			if (rule.when && !rule.when(nextBlock)) continue;
			const m = txt.match(rule.re);
			if (m) {
				rule.apply(m, ctx, path);
				return true;
			}
		}
	}

	// Inline rules — only on closing character
	if (text === '*' || text === '`' || text === '~') {
		for (const rule of INLINE_RULES) {
			const m = txt.match(rule.re);
			if (m) {
				rule.apply(m, ctx, path, next.selection.head.offset);
				return true;
			}
		}
	}
	return false;
}

function plainText(b: BlockNode): string {
	if (!b.text) return '';
	let s = '';
	for (const span of b.text) s += span.text;
	return s;
}
