// Op-based inverse computation.
//
// A `TransactionOp` is plain, serializable data, but no op stores the content
// it removed or overwrote (`replaceText` carries the inserted span, not the
// deleted one; `setBlockAttrs` carries the merged-in attrs, not the prior
// ones; `removeBlock` carries only a path). A record therefore cannot be
// inverted standalone after the fact — the inverse must be computed at the
// moment the op is applied, while the before-state is still in hand.
//
// `invertOps` does exactly that: it walks a transaction's ops forward,
// capturing the editor state `S_i` immediately before each `ops[i]`, then
// builds the inverse list in reverse order so that folding the inverses over
// the post-transaction state reproduces the original before-state. If any op
// is non-invertible (a required block/content is absent from the before-state)
// the whole thing returns `null` and the caller falls back to a snapshot
// restore — undo never breaks.

import { type BlockNode, type DocumentNode, type TextSpan, blockTextLength, sliceText } from './document.js';
import { type BlockPath, clonePath, getBlockAt, prevBlockPath } from './selection.js';
import { type EditorState, type TransactionOp, applyOp } from './transaction.js';

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Depth-first search for the block carrying `id`, returning its `BlockPath`
 * (or `null`). Block ids are stable across an op, so this is how the inverse
 * of a `moveBlock` recovers where the moved block actually landed in the
 * post-state regardless of index arithmetic.
 */
export function findBlockPathById(doc: DocumentNode, id: string): BlockPath | null {
	let found: BlockPath | null = null;
	const walk = (nodes: BlockNode[], parent: BlockPath): boolean => {
		for (let i = 0; i < nodes.length; i++) {
			const block = nodes[i]!;
			const path: BlockPath = [...parent, i];
			if (block.id === id) {
				found = path;
				return true;
			}
			if (block.children && walk(block.children, path)) return true;
		}
		return false;
	};
	walk(doc.children, []);
	return found;
}

/**
 * Compute the inverse of a single op given the state *immediately before* it
 * was applied. Returns the op (or ops) that map `applyOp(before, op)` back to
 * `before`, an empty array when the op has no document effect to undo (e.g.
 * `setSelection`), or `null` when the op cannot be faithfully inverted because
 * the data it touched is absent from `before`.
 *
 * Every embedded block / span carried into an inverse op is deep-cloned so the
 * inverse never aliases live editor state.
 */
export function invertOp(op: TransactionOp, before: EditorState): TransactionOp | TransactionOp[] | null {
	switch (op.kind) {
		case 'setSelection':
			// Selection has no document effect; the caret is restored separately
			// via the inverse transaction's `meta.nextSelection`.
			return [];
		case 'replaceText': {
			const block = getBlockAt(before.doc, op.path);
			if (!block) return null;
			// The forward op replaced [from, to) with `insert`; the inserted span
			// now occupies [from, from + insertedLen). Replace that back with the
			// content the forward op removed (captured from `before`).
			const removed = sliceText(block.text, op.from, op.to);
			const insertedLen = op.insert.reduce((n, s) => n + s.text.length, 0);
			return { kind: 'replaceText', path: clonePath(op.path), from: op.from, to: op.from + insertedLen, insert: removed };
		}
		case 'toggleMark':
		case 'addMark':
		case 'removeMark': {
			// None of the mark ops are self-inverse on partial ranges (re-applying
			// can add/remove the wrong subset). Restore the exact original spans of
			// the affected range from `before`. Text length is unchanged by a mark
			// op, so offsets carry over to the post-state unchanged.
			const block = getBlockAt(before.doc, op.path);
			if (!block || !block.text) return null;
			const len = blockTextLength(block);
			const to = op.to === -1 ? len : op.to;
			if (op.from >= to) return [];
			const original = sliceText(block.text, op.from, to);
			return { kind: 'replaceText', path: clonePath(op.path), from: op.from, to, insert: original };
		}
		case 'setBlockType':
		case 'setBlockAttrs': {
			// `setBlockType` replaces attrs wholesale and `setBlockAttrs` merges
			// them, so in both cases the faithful inverse is a `setBlockType` that
			// resets the block's exact prior type + attrs from `before`.
			const block = getBlockAt(before.doc, op.path);
			if (!block) return null;
			return {
				kind: 'setBlockType',
				path: clonePath(op.path),
				type: block.type,
				...(block.attrs ? { attrs: clone(block.attrs) } : {}),
			};
		}
		case 'insertBlock':
			// The forward op inserted `op.block` at `op.path`; remove it.
			return { kind: 'removeBlock', path: clonePath(op.path) };
		case 'removeBlock': {
			const block = getBlockAt(before.doc, op.path);
			if (!block) return null;
			return { kind: 'insertBlock', path: clonePath(op.path), block: clone(block) };
		}
		case 'moveBlock': {
			const moving = getBlockAt(before.doc, op.from);
			if (!moving) return null;
			// Find where the block actually landed (by stable id) and move it back
			// to its origin. `to: op.from` is interpreted against the post-removal
			// tree, which equals `before` minus the moved block — so inserting at
			// the origin index restores `before` exactly.
			const post = applyOp(before, op);
			const landed = findBlockPathById(post.doc, moving.id);
			if (!landed) return null;
			return { kind: 'moveBlock', from: landed, to: clonePath(op.from) };
		}
		case 'splitBlock': {
			const block = getBlockAt(before.doc, op.path);
			if (!block) return null;
			// The split appends a fresh block right after `op.path`; joining it
			// backward merges it into the left (original) block. Note: the forward
			// split mints a non-deterministic `newId()` for the right block, so a
			// later *redo* of the split produces a different id — a known
			// replay-fidelity wrinkle. The structural inverse (text + tree) is
			// exact.
			const last = op.path[op.path.length - 1]!;
			const rightPath: BlockPath = [...op.path.slice(0, -1), last + 1];
			return { kind: 'joinBackward', path: rightPath };
		}
		case 'joinBackward': {
			const prevPath = prevBlockPath(before.doc, op.path);
			if (!prevPath) return null;
			const prev = getBlockAt(before.doc, prevPath);
			const cur = getBlockAt(before.doc, op.path);
			if (!prev || !cur) return null;
			if (prev.text === undefined) {
				// Non-text previous block (e.g. a divider) was removed outright;
				// reinsert it at its original path.
				return { kind: 'insertBlock', path: clonePath(prevPath), block: clone(prev) };
			}
			// Text merge: `cur`'s text was appended onto `prev` and `cur` removed.
			// Reinsert `cur` (with its original id/type/attrs) at its path, then
			// truncate the appended tail back off `prev`.
			const lenP = blockTextLength(prev);
			const lenC = blockTextLength(cur);
			const empty: TextSpan[] = [];
			return [
				{ kind: 'insertBlock', path: clonePath(op.path), block: clone(cur) },
				{ kind: 'replaceText', path: clonePath(prevPath), from: lenP, to: lenP + lenC, insert: empty },
			];
		}
	}
}

/**
 * Sequentially invert a transaction's ops. Walks forward capturing the
 * pre-op state `S_i` before each `ops[i]`, then folds `invertOp(ops[i], S_i)`
 * in reverse order. The concatenated result, applied to the post-transaction
 * state, reproduces the original before-state.
 *
 * Returns `null` if any op is non-invertible — the caller should then fall
 * back to a full snapshot restore.
 */
export function invertOps(ops: TransactionOp[], before: EditorState): TransactionOp[] | null {
	const preStates: EditorState[] = [];
	let state = before;
	for (const op of ops) {
		preStates.push(state);
		state = applyOp(state, op);
	}
	const out: TransactionOp[] = [];
	for (let i = ops.length - 1; i >= 0; i--) {
		const inv = invertOp(ops[i]!, preStates[i]!);
		if (inv === null) return null;
		if (Array.isArray(inv)) out.push(...inv);
		else out.push(inv);
	}
	return out;
}
