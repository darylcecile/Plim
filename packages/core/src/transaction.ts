import {
	type BlockNode,
	type DocumentNode,
	type MarkInstance,
	type TextSpan,
	applyMarkToRange,
	blockTextLength,
	hasMark,
	newId,
	normalizeText,
	replaceTextRange,
	sliceText,
} from './document.js';
import {
	type BlockPath,
	type Selection,
	cloneSelection,
	comparePaths,
	getBlockAt,
	getBlockParent,
	nextBlockPath,
	prevBlockPath,
	samePath,
} from './selection.js';

export type EditorState = {
	doc: DocumentNode;
	selection: Selection;
};

export type TransactionMeta = {
	source?: string;
	addToHistory?: boolean;
	scrollIntoView?: boolean;
	[k: string]: unknown;
};

export type TransactionOp =
	| { kind: 'replaceText'; path: BlockPath; from: number; to: number; insert: TextSpan[] }
	| { kind: 'setSelection'; selection: Selection }
	| { kind: 'splitBlock'; path: BlockPath; offset: number; newType?: string; newAttrs?: Record<string, unknown> }
	| { kind: 'joinBackward'; path: BlockPath }
	| { kind: 'setBlockType'; path: BlockPath; type: string; attrs?: Record<string, unknown> }
	| { kind: 'setBlockAttrs'; path: BlockPath; attrs: Record<string, unknown> }
	| { kind: 'insertBlock'; path: BlockPath; block: BlockNode }
	| { kind: 'removeBlock'; path: BlockPath }
	| { kind: 'moveBlock'; from: BlockPath; to: BlockPath }
	| { kind: 'toggleMark'; path: BlockPath; from: number; to: number; mark: MarkInstance }
	| { kind: 'addMark'; path: BlockPath; from: number; to: number; mark: MarkInstance }
	| { kind: 'removeMark'; path: BlockPath; from: number; to: number; mark: MarkInstance };

export class Transaction {
	readonly ops: TransactionOp[] = [];
	readonly meta: TransactionMeta = { addToHistory: true };
	private nextSelection: Selection | null = null;

	constructor(public readonly state: EditorState) {}

	setMeta(key: string, value: unknown): this {
		(this.meta as Record<string, unknown>)[key] = value;
		return this;
	}

	setSelection(selection: Selection): this {
		this.nextSelection = selection;
		this.ops.push({ kind: 'setSelection', selection });
		return this;
	}

	replaceRange(path: BlockPath, from: number, to: number, insert: TextSpan[] = []): this {
		this.ops.push({ kind: 'replaceText', path, from, to, insert });
		return this;
	}

	insertText(path: BlockPath, offset: number, text: string, marks?: MarkInstance[]): this {
		const span: TextSpan = { text, ...(marks && marks.length ? { marks } : {}) };
		this.ops.push({ kind: 'replaceText', path, from: offset, to: offset, insert: [span] });
		return this;
	}

	splitBlock(path: BlockPath, offset: number, newType?: string, newAttrs?: Record<string, unknown>): this {
		const op: TransactionOp = newType
			? { kind: 'splitBlock', path, offset, newType, ...(newAttrs ? { newAttrs } : {}) }
			: { kind: 'splitBlock', path, offset };
		this.ops.push(op);
		return this;
	}

	joinBackward(path: BlockPath): this {
		this.ops.push({ kind: 'joinBackward', path });
		return this;
	}

	setBlockType(path: BlockPath, type: string, attrs?: Record<string, unknown>): this {
		const op: TransactionOp = attrs
			? { kind: 'setBlockType', path, type, attrs }
			: { kind: 'setBlockType', path, type };
		this.ops.push(op);
		return this;
	}

	setBlockAttrs(path: BlockPath, attrs: Record<string, unknown>): this {
		this.ops.push({ kind: 'setBlockAttrs', path, attrs });
		return this;
	}

	insertBlock(path: BlockPath, block: BlockNode): this {
		this.ops.push({ kind: 'insertBlock', path, block });
		return this;
	}

	removeBlock(path: BlockPath): this {
		this.ops.push({ kind: 'removeBlock', path });
		return this;
	}

	moveBlock(from: BlockPath, to: BlockPath): this {
		this.ops.push({ kind: 'moveBlock', from, to });
		return this;
	}

	toggleMark(name: string, range: { from: { path: BlockPath; offset: number }; to: { path: BlockPath; offset: number } }, attrs?: Record<string, unknown>): this;
	toggleMark(name: string, range: { path: BlockPath; from: number; to: number }, attrs?: Record<string, unknown>): this;
	toggleMark(name: string, range: any, attrs?: Record<string, unknown>): this {
		const mark: MarkInstance = attrs ? { type: name, attrs } : { type: name };
		for (const r of this.markRanges(range)) this.ops.push({ kind: 'toggleMark', path: r.path, from: r.from, to: r.to, mark });
		return this;
	}

	/**
	 * Add a mark over a range *unconditionally* (unlike {@link toggleMark}, which
	 * removes the mark when the range is already fully marked). This is what
	 * range-keyed annotations such as comments want: applying a comment must never
	 * accidentally toggle an existing one off. A character holds at most one mark
	 * of a given `type` — adding a mark whose attrs differ (e.g. a new comment
	 * thread over already-commented text) replaces the prior one on the overlap.
	 */
	addMark(name: string, range: { from: { path: BlockPath; offset: number }; to: { path: BlockPath; offset: number } }, attrs?: Record<string, unknown>): this;
	addMark(name: string, range: { path: BlockPath; from: number; to: number }, attrs?: Record<string, unknown>): this;
	addMark(name: string, range: any, attrs?: Record<string, unknown>): this {
		const mark: MarkInstance = attrs ? { type: name, attrs } : { type: name };
		for (const r of this.markRanges(range)) this.ops.push({ kind: 'addMark', path: r.path, from: r.from, to: r.to, mark });
		return this;
	}

	/**
	 * Remove every mark of `type` over a range (attrs are ignored — a character
	 * carries at most one mark per type). Pair with a doc walk that targets only
	 * the runs belonging to one annotation to remove a single comment thread.
	 */
	removeMark(name: string, range: { from: { path: BlockPath; offset: number }; to: { path: BlockPath; offset: number } }, attrs?: Record<string, unknown>): this;
	removeMark(name: string, range: { path: BlockPath; from: number; to: number }, attrs?: Record<string, unknown>): this;
	removeMark(name: string, range: any, attrs?: Record<string, unknown>): this {
		const mark: MarkInstance = attrs ? { type: name, attrs } : { type: name };
		for (const r of this.markRanges(range)) this.ops.push({ kind: 'removeMark', path: r.path, from: r.from, to: r.to, mark });
		return this;
	}

	// Resolve a single- or cross-block mark range into one `{path, from, to}` per
	// affected block. Shared by toggleMark/addMark/removeMark so the cross-block
	// expansion (with the `to: -1` "to end of block" sentinel) lives in one place.
	private markRanges(range: any): Array<{ path: BlockPath; from: number; to: number }> {
		const out: Array<{ path: BlockPath; from: number; to: number }> = [];
		if ('path' in range) {
			// Normalize: callers may pass an unordered range (e.g. when the
			// selection is backward and from/to come straight from anchor/head).
			out.push({ path: range.path, from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) });
			return out;
		}
		const fromP = range.from.path as BlockPath;
		const toP = range.to.path as BlockPath;
		if (samePath(fromP, toP)) {
			out.push({ path: fromP, from: Math.min(range.from.offset, range.to.offset), to: Math.max(range.from.offset, range.to.offset) });
			return out;
		}
		// cross-block: the first block runs from the start offset to its end
		// (sentinel -1), every fully covered middle block is 0..end, and the last
		// block runs 0..end offset. Middle blocks are walked against the current
		// doc snapshot.
		const ordered = comparePaths(fromP, toP) <= 0 ? { f: range.from, t: range.to } : { f: range.to, t: range.from };
		out.push({ path: ordered.f.path, from: ordered.f.offset, to: -1 });
		let cur = nextBlockPath(this.state.doc, ordered.f.path);
		while (cur && comparePaths(cur, ordered.t.path) < 0) {
			const blk = getBlockAt(this.state.doc, cur);
			if (blk?.text) out.push({ path: cur, from: 0, to: -1 });
			cur = nextBlockPath(this.state.doc, cur);
		}
		out.push({ path: ordered.t.path, from: 0, to: ordered.t.offset });
		return out;
	}

	private committed = false;
	private committer?: (tx: Transaction) => void;
	__bindCommitter(fn: (tx: Transaction) => void) {
		this.committer = fn;
	}
	commit(): this {
		if (this.committed) return this;
		this.committed = true;
		if (this.nextSelection) this.meta.nextSelection = this.nextSelection;
		this.committer?.(this);
		return this;
	}
}

// ----- Apply ops to state ---------------------------------------------------

function withDocChange(doc: DocumentNode, mutate: (root: DocumentNode) => void): DocumentNode {
	// Deep clone (small docs - fine).
	const cloned = JSON.parse(JSON.stringify(doc)) as DocumentNode;
	mutate(cloned);
	// Structural-sharing pass: walk the cloned tree alongside the
	// previous one and re-alias any subtree that's structurally
	// identical to its predecessor. This restores reference equality
	// for blocks the transaction didn't touch — most txs change one
	// block, so 99% of the doc keeps its prior identity. The view
	// layer can then short-circuit `updateBlockElement` for unchanged
	// blocks via `node === prevNode` checks. Cost: one
	// `JSON.stringify` per block per tx (cheap for small blocks),
	// gated behind an id-equality fast path. Net win because the
	// renderer's per-block update is far costlier.
	return reuseUnchangedRefs(doc, cloned);
}

/**
 * Walk `prev` and `next` (post-mutation clone) in parallel; whenever a
 * subtree's structural form is identical, splice the previous reference
 * into `next`. Block identity is keyed on `id` to avoid expensive
 * comparisons across reordered siblings — if ids match at the same
 * position we compare shape, otherwise we leave `next`'s clone in
 * place.
 *
 * Structural equality is determined via `JSON.stringify` rather than a
 * recursive deep-equal walk: it's a single pass over each block's
 * material (text spans, attrs, attribute order is stable since both
 * trees came from the same JSON source), and avoids the O(n*depth)
 * cost of per-field comparison while still being correct for plain
 * data (no functions, no symbols — Plim docs are pure JSON-shaped).
 */
function reuseUnchangedRefs(prev: DocumentNode, next: DocumentNode): DocumentNode {
	if (!prev.children || !next.children) return next;
	const reusedChildren = reuseChildren(prev.children, next.children);
	if (reusedChildren === next.children) return next;
	return { ...next, children: reusedChildren };
}

function reuseChildren(prev: BlockNode[], next: BlockNode[]): BlockNode[] {
	if (prev === next) return prev;
	let reused: BlockNode[] | null = null;
	for (let i = 0; i < next.length; i++) {
		const nextChild = next[i]!;
		const prevChild = prev[i];
		const candidate = prevChild && prevChild.id === nextChild.id ? reuseBlock(prevChild, nextChild) : nextChild;
		if (candidate !== nextChild) {
			if (!reused) reused = next.slice();
			reused[i] = candidate;
		}
	}
	return reused ?? next;
}

function reuseBlock(prev: BlockNode, next: BlockNode): BlockNode {
	if (prev === next) return prev;
	// Shallow shape compare (id/type/attrs/text). If those differ,
	// no point recursing into children — the block itself is changed
	// and the renderer must reprocess it anyway. We deliberately
	// stringify *only* the block's own material and exclude
	// `children` so a deep subtree change in a descendant doesn't
	// mark every ancestor as "changed" for no reason — children are
	// re-aliased independently below.
	const prevShallow = shallowKey(prev);
	const nextShallow = shallowKey(next);
	const prevHasChildren = !!prev.children;
	const nextHasChildren = !!next.children;
	if (prevShallow !== nextShallow) return next;
	if (!prevHasChildren && !nextHasChildren) return prev;
	if (!prevHasChildren || !nextHasChildren) return next;
	const reusedChildren = reuseChildren(prev.children!, next.children!);
	if (reusedChildren === prev.children) return prev;
	return { ...next, children: reusedChildren };
}

function shallowKey(b: BlockNode): string {
	// Stable string of (id, type, attrs, text) — excludes `children`.
	// JSON.stringify is sufficient because BlockNode is plain data
	// and we never deviate from a fixed property set.
	return JSON.stringify({ id: b.id, type: b.type, attrs: b.attrs ?? null, text: b.text ?? null });
}

function arrAt(parent: BlockNode | DocumentNode): BlockNode[] {
	if (!('children' in parent) || !parent.children) {
		(parent as { children?: BlockNode[] }).children = [];
	}
	return (parent as { children: BlockNode[] }).children;
}

function getMutBlock(doc: DocumentNode, path: BlockPath): BlockNode | null {
	let parent: BlockNode | DocumentNode = doc;
	let block: BlockNode | null = null;
	for (const idx of path) {
		const arr: BlockNode[] | undefined = (parent as { children?: BlockNode[] }).children;
		if (!arr) return null;
		block = arr[idx] ?? null;
		if (!block) return null;
		parent = block;
	}
	return block;
}

export function applyOp(state: EditorState, op: TransactionOp): EditorState {
	switch (op.kind) {
		case 'setSelection':
			return { doc: state.doc, selection: cloneSelection(op.selection) };
		case 'replaceText': {
			const doc = withDocChange(state.doc, (root) => {
				const block = getMutBlock(root, op.path);
				if (!block) return;
				block.text = replaceTextRange(block.text, op.from, op.to, op.insert);
			});
			// adjust selection if it was inside this block
			const sel = cloneSelection(state.selection);
			const insertedLen = op.insert.reduce((n, s) => n + s.text.length, 0);
			const delta = insertedLen - (op.to - op.from);
			for (const pos of [sel.anchor, sel.head]) {
				if (samePath(pos.path, op.path)) {
					if (pos.offset > op.to) pos.offset += delta;
					else if (pos.offset > op.from) pos.offset = op.from + insertedLen;
				}
			}
			return { doc, selection: sel };
		}
		case 'toggleMark': {
			const doc = withDocChange(state.doc, (root) => {
				const block = getMutBlock(root, op.path);
				if (!block || !block.text) return;
				const len = blockTextLength(block);
				const to = op.to === -1 ? len : op.to;
				const isOn = hasMark(block.text, op.from, to, op.mark.type);
				block.text = applyMarkToRange(block.text, op.from, to, op.mark, isOn ? 'remove' : 'add');
			});
			return { doc, selection: state.selection };
		}
		case 'addMark': {
			const doc = withDocChange(state.doc, (root) => {
				const block = getMutBlock(root, op.path);
				if (!block || !block.text) return;
				const len = blockTextLength(block);
				const to = op.to === -1 ? len : op.to;
				block.text = applyMarkToRange(block.text, op.from, to, op.mark, 'add');
			});
			return { doc, selection: state.selection };
		}
		case 'removeMark': {
			const doc = withDocChange(state.doc, (root) => {
				const block = getMutBlock(root, op.path);
				if (!block || !block.text) return;
				const len = blockTextLength(block);
				const to = op.to === -1 ? len : op.to;
				block.text = applyMarkToRange(block.text, op.from, to, op.mark, 'remove');
			});
			return { doc, selection: state.selection };
		}
		case 'splitBlock': {
			let nextSelection: Selection | null = null;
			const doc = withDocChange(state.doc, (root) => {
				const parentInfo = getBlockParent(root, op.path);
				if (!parentInfo) return;
				const block = getMutBlock(root, op.path);
				if (!block) return;
				const left: TextSpan[] = sliceText(block.text, 0, op.offset);
				const right: TextSpan[] = sliceText(block.text, op.offset, Number.MAX_SAFE_INTEGER);
				const newBlock: BlockNode = {
					id: newId(),
					type: op.newType ?? block.type,
					...(op.newAttrs ? { attrs: op.newAttrs } : block.attrs ? { attrs: { ...block.attrs } } : {}),
					text: right,
				};
				if (op.newType && op.newType !== block.type) {
					// when changing type on the right side, drop attrs unless explicitly given
					if (!op.newAttrs) delete newBlock.attrs;
				}
				block.text = left;
				const arr = arrAt(parentInfo.parent);
				arr.splice(parentInfo.index + 1, 0, newBlock);
				const newPath: BlockPath = [...op.path.slice(0, -1), parentInfo.index + 1];
				nextSelection = {
					anchor: { path: newPath, offset: 0 },
					head: { path: newPath, offset: 0 },
				};
			});
			return { doc, selection: nextSelection ?? state.selection };
		}
		case 'joinBackward': {
			let nextSelection: Selection | null = null;
			const doc = withDocChange(state.doc, (root) => {
				const prevPath = prevBlockPath(root, op.path);
				if (!prevPath) return;
				const cur = getMutBlock(root, op.path);
				const prev = getMutBlock(root, prevPath);
				if (!cur || !prev) return;
				const prevLen = blockTextLength(prev);
				if (prev.text === undefined) {
					// previous block is non-text (e.g. divider) — just remove it
					const pInfo = getBlockParent(root, prevPath);
					if (pInfo) arrAt(pInfo.parent).splice(pInfo.index, 1);
					nextSelection = {
						anchor: { path: op.path[0]! > prevPath[0]! && op.path.length === prevPath.length ? [...op.path.slice(0, -1), op.path[op.path.length - 1]! - 1] : op.path, offset: 0 },
						head: { path: op.path, offset: 0 },
					};
					return;
				}
				prev.text = normalizeText([...(prev.text ?? []), ...(cur.text ?? [])]);
				// remove cur
				const curInfo = getBlockParent(root, op.path);
				if (curInfo) arrAt(curInfo.parent).splice(curInfo.index, 1);
				nextSelection = {
					anchor: { path: prevPath, offset: prevLen },
					head: { path: prevPath, offset: prevLen },
				};
			});
			return { doc, selection: nextSelection ?? state.selection };
		}
		case 'setBlockType': {
			const doc = withDocChange(state.doc, (root) => {
				const block = getMutBlock(root, op.path);
				if (!block) return;
				block.type = op.type;
				if (op.attrs) block.attrs = op.attrs;
				else delete block.attrs;
			});
			return { doc, selection: state.selection };
		}
		case 'setBlockAttrs': {
			const doc = withDocChange(state.doc, (root) => {
				const block = getMutBlock(root, op.path);
				if (!block) return;
				block.attrs = { ...(block.attrs ?? {}), ...op.attrs };
			});
			return { doc, selection: state.selection };
		}
		case 'insertBlock': {
			const doc = withDocChange(state.doc, (root) => {
				const parentInfo = getBlockParent(root, op.path);
				if (!parentInfo) {
					// inserting at root with absolute index
					arrAt(root).splice(op.path[op.path.length - 1] ?? 0, 0, op.block);
					return;
				}
				arrAt(parentInfo.parent).splice(parentInfo.index, 0, op.block);
			});
			return { doc, selection: state.selection };
		}
		case 'removeBlock': {
			const doc = withDocChange(state.doc, (root) => {
				const parentInfo = getBlockParent(root, op.path);
				if (!parentInfo) return;
				arrAt(parentInfo.parent).splice(parentInfo.index, 1);
			});
			return { doc, selection: state.selection };
		}
		case 'moveBlock': {
			const doc = withDocChange(state.doc, (root) => {
				const fromInfo = getBlockParent(root, op.from);
				if (!fromInfo) return;
				const arrFrom = arrAt(fromInfo.parent);
				const moving = arrFrom[fromInfo.index];
				if (!moving) return;
				arrFrom.splice(fromInfo.index, 1);
				const toInfo = getBlockParent(root, op.to);
				if (!toInfo) {
					arrAt(root).splice(op.to[op.to.length - 1] ?? 0, 0, moving);
					return;
				}
				arrAt(toInfo.parent).splice(toInfo.index, 0, moving);
			});
			return { doc, selection: state.selection };
		}
	}
}

export function applyTransaction(state: EditorState, tx: Transaction): EditorState {
	let next = state;
	for (const op of tx.ops) next = applyOp(next, op);
	if (tx.meta.nextSelection) {
		next = { doc: next.doc, selection: cloneSelection(tx.meta.nextSelection as Selection) };
	}
	return next;
}
