import { describe, expect, it } from 'vitest';
import {
	type BlockNode,
	type EditorState,
	type MarkInstance,
	type TextSpan,
	type TransactionOp,
	applyOp,
	findBlockPathById,
	invertOps,
} from '@plim/core';

// ----- builders (explicit, stable ids so docs deep-equal) -------------------

function span(text: string, marks?: MarkInstance[]): TextSpan {
	return marks && marks.length ? { text, marks } : { text };
}

function para(id: string, text: string, attrs?: Record<string, unknown>): BlockNode {
	return {
		id,
		type: 'paragraph',
		...(attrs ? { attrs } : {}),
		text: text ? [{ text }] : [],
	};
}

function state(...blocks: BlockNode[]): EditorState {
	return {
		doc: { type: 'doc', children: blocks },
		selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
	};
}

function applyAll(s: EditorState, ops: TransactionOp[]): EditorState {
	let cur = s;
	for (const op of ops) cur = applyOp(cur, op);
	return cur;
}

/**
 * Apply `ops` to `before`, invert them, fold the inverse over the post-state,
 * and return the reconstructed state. The caller asserts `.doc` deep-equals
 * `before.doc` — i.e. the inverse round-trips the document exactly.
 */
function roundTrip(before: EditorState, ops: TransactionOp[]): EditorState {
	const post = applyAll(before, ops);
	const inverse = invertOps(ops, before);
	expect(inverse).not.toBeNull();
	return applyAll(post, inverse!);
}

describe('invertOps — per-op round-trips', () => {
	it('replaceText (insertion) restores the original text', () => {
		const before = state(para('b0', 'hello'));
		const ops: TransactionOp[] = [{ kind: 'replaceText', path: [0], from: 5, to: 5, insert: [span(' world')] }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('replaceText (deletion) restores the removed text', () => {
		const before = state(para('b0', 'hello world'));
		const ops: TransactionOp[] = [{ kind: 'replaceText', path: [0], from: 5, to: 11, insert: [] }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('replaceText (overwrite) restores the overwritten span', () => {
		const before = state(para('b0', 'hello'));
		const ops: TransactionOp[] = [{ kind: 'replaceText', path: [0], from: 0, to: 5, insert: [span('HELLO')] }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('setSelection is dropped from the inverse (no doc effect)', () => {
		const before = state(para('b0', 'hello'));
		const ops: TransactionOp[] = [
			{ kind: 'setSelection', selection: { anchor: { path: [0], offset: 2 }, head: { path: [0], offset: 4 } } },
		];
		const inverse = invertOps(ops, before);
		expect(inverse).toEqual([]);
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('insertBlock <-> removeBlock', () => {
		const before = state(para('b0', 'first'), para('b1', 'third'));
		const insert: TransactionOp[] = [{ kind: 'insertBlock', path: [1], block: para('bx', 'second') }];
		expect(roundTrip(before, insert).doc).toEqual(before.doc);

		const afterInsert = applyAll(before, insert);
		const remove: TransactionOp[] = [{ kind: 'removeBlock', path: [1] }];
		expect(roundTrip(afterInsert, remove).doc).toEqual(afterInsert.doc);
	});

	it('moveBlock down then back', () => {
		const before = state(para('b0', 'a'), para('b1', 'b'), para('b2', 'c'));
		const ops: TransactionOp[] = [{ kind: 'moveBlock', from: [0], to: [2] }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('moveBlock up then back', () => {
		const before = state(para('b0', 'a'), para('b1', 'b'), para('b2', 'c'));
		const ops: TransactionOp[] = [{ kind: 'moveBlock', from: [2], to: [0] }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('moveBlock across nesting levels', () => {
		const before: EditorState = {
			doc: {
				type: 'doc',
				children: [
					{ id: 'list', type: 'list', children: [para('li0', 'one'), para('li1', 'two')] },
					para('b1', 'tail'),
				],
			},
			selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
		};
		const ops: TransactionOp[] = [{ kind: 'moveBlock', from: [0, 1], to: [1] }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('setBlockType restores prior type + attrs', () => {
		const before = state(para('b0', 'title', { level: 1 }));
		const ops: TransactionOp[] = [{ kind: 'setBlockType', path: [0], type: 'heading', attrs: { level: 2 } }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('setBlockType restores a block that previously had no attrs', () => {
		const before = state(para('b0', 'plain'));
		const ops: TransactionOp[] = [{ kind: 'setBlockType', path: [0], type: 'heading', attrs: { level: 3 } }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('setBlockAttrs (a merge) restores the exact prior attrs', () => {
		const before = state(para('b0', 'x', { level: 1, checked: false }));
		// forward merges { checked: true } — inverse must restore the FULL prior attrs,
		// not just toggle `checked` back.
		const ops: TransactionOp[] = [{ kind: 'setBlockAttrs', path: [0], attrs: { checked: true, color: 'red' } }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('splitBlock structural inverse (joinBackward) restores the block text', () => {
		const before = state(para('b0', 'hello world'));
		const ops: TransactionOp[] = [{ kind: 'splitBlock', path: [0], offset: 5 }];
		const result = roundTrip(before, ops);
		expect(result.doc.children).toHaveLength(1);
		expect(result.doc.children[0]!.text).toEqual([{ text: 'hello world' }]);
		// the surviving (left) block keeps its original id
		expect(result.doc.children[0]!.id).toBe('b0');
		expect(result.doc).toEqual(before.doc);
	});

	it('joinBackward (text merge) restores both blocks with original ids', () => {
		const before = state(para('b0', 'hello'), para('b1', 'world'));
		const ops: TransactionOp[] = [{ kind: 'joinBackward', path: [1] }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('joinBackward onto a non-text previous block reinserts it', () => {
		const before: EditorState = {
			doc: { type: 'doc', children: [{ id: 'd0', type: 'divider' }, para('b1', 'after')] },
			selection: { anchor: { path: [1], offset: 0 }, head: { path: [1], offset: 0 } },
		};
		const ops: TransactionOp[] = [{ kind: 'joinBackward', path: [1] }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('toggleMark (add) restores plain text', () => {
		const before = state(para('b0', 'hello'));
		const bold: MarkInstance = { type: 'bold' };
		const ops: TransactionOp[] = [{ kind: 'toggleMark', path: [0], from: 0, to: 5, mark: bold }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('toggleMark is NOT self-inverse on a partially-marked range', () => {
		const bold: MarkInstance = { type: 'bold' };
		// "he" already bold, "llo" plain.
		const before: EditorState = {
			doc: { type: 'doc', children: [{ id: 'b0', type: 'paragraph', text: [span('he', [bold]), span('llo')] }] },
			selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
		};
		const ops: TransactionOp[] = [{ kind: 'toggleMark', path: [0], from: 0, to: 5, mark: bold }];

		// sanity: a naive "re-toggle" inverse would wipe the original "he" bold.
		const post = applyAll(before, ops);
		const naive = applyAll(post, ops);
		expect(naive.doc).not.toEqual(before.doc);

		// the real op-based inverse restores the exact original spans.
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('toggleMark with to === -1 (to end of block) round-trips', () => {
		const bold: MarkInstance = { type: 'bold' };
		const before = state(para('b0', 'hello'));
		const ops: TransactionOp[] = [{ kind: 'toggleMark', path: [0], from: 0, to: -1, mark: bold }];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});
});

describe('invertOps — composite / nested / sequencing', () => {
	it('inverts a multi-op transaction (replaceText + setBlockType + toggleMark)', () => {
		const before = state(para('b0', 'hello'));
		const ops: TransactionOp[] = [
			{ kind: 'replaceText', path: [0], from: 5, to: 5, insert: [span(' world')] },
			{ kind: 'setBlockType', path: [0], type: 'heading', attrs: { level: 1 } },
			{ kind: 'toggleMark', path: [0], from: 0, to: 5, mark: { type: 'bold' } },
		];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('inverts ops that touch nested children', () => {
		const before: EditorState = {
			doc: {
				type: 'doc',
				children: [{ id: 'list', type: 'list', children: [para('li0', 'one'), para('li1', 'two')] }],
			},
			selection: { anchor: { path: [0, 0], offset: 0 }, head: { path: [0, 0], offset: 0 } },
		};
		const ops: TransactionOp[] = [
			{ kind: 'replaceText', path: [0, 0], from: 3, to: 3, insert: [span('!')] },
			{ kind: 'insertBlock', path: [0, 2], block: para('li2', 'three') },
			{ kind: 'removeBlock', path: [0, 1] },
		];
		expect(roundTrip(before, ops).doc).toEqual(before.doc);
	});

	it('supports undo then redo (op inverse, then re-apply forward)', () => {
		const before = state(para('b0', 'hello'));
		const ops: TransactionOp[] = [
			{ kind: 'replaceText', path: [0], from: 5, to: 5, insert: [span('!')] },
			{ kind: 'setBlockType', path: [0], type: 'heading', attrs: { level: 2 } },
		];
		const post = applyAll(before, ops);
		const inverse = invertOps(ops, before)!;

		// undo → back to before
		const undone = applyAll(post, inverse);
		expect(undone.doc).toEqual(before.doc);

		// redo → re-apply the original forward ops → back to post
		const redone = applyAll(undone, ops);
		expect(redone.doc).toEqual(post.doc);
	});

	it('supports multiple sequential undos (LIFO, like the history stack)', () => {
		const before0 = state(para('b0', ''));
		const tx1: TransactionOp[] = [{ kind: 'replaceText', path: [0], from: 0, to: 0, insert: [span('A')] }];
		const s1 = applyAll(before0, tx1);
		const inv1 = invertOps(tx1, before0)!;

		const tx2: TransactionOp[] = [{ kind: 'replaceText', path: [0], from: 1, to: 1, insert: [span('B')] }];
		const s2 = applyAll(s1, tx2);
		const inv2 = invertOps(tx2, s1)!;

		// undo tx2 → s1
		const afterUndo2 = applyAll(s2, inv2);
		expect(afterUndo2.doc).toEqual(s1.doc);

		// undo tx1 → before0
		const afterUndo1 = applyAll(afterUndo2, inv1);
		expect(afterUndo1.doc).toEqual(before0.doc);
	});

	it('reproduces the A / B / undo / C trace yielding "AC"', () => {
		// type A, type B, undo (live "A"), type C → live doc "AC".
		const empty = state(para('b0', ''));
		const insA: TransactionOp[] = [{ kind: 'replaceText', path: [0], from: 0, to: 0, insert: [span('A')] }];
		const sA = applyAll(empty, insA);

		const insB: TransactionOp[] = [{ kind: 'replaceText', path: [0], from: 1, to: 1, insert: [span('B')] }];
		const sB = applyAll(sA, insB);
		const invB = invertOps(insB, sA)!;

		// undo B → "A"
		const undone = applyAll(sB, invB);
		expect(undone.doc.children[0]!.text).toEqual([{ text: 'A' }]);

		// type C at offset 1 → "AC"
		const insC: TransactionOp[] = [{ kind: 'replaceText', path: [0], from: 1, to: 1, insert: [span('C')] }];
		const sC = applyAll(undone, insC);
		expect(sC.doc.children[0]!.text).toEqual([{ text: 'AC' }]);
	});
});

describe('invertOps — non-invertible fallback', () => {
	it('returns null when a removed block is absent from the before-state', () => {
		const before = state(para('b0', 'only'));
		const ops: TransactionOp[] = [{ kind: 'removeBlock', path: [99] }];
		expect(invertOps(ops, before)).toBeNull();
	});

	it('returns null when a moved block is absent from the before-state', () => {
		const before = state(para('b0', 'only'));
		const ops: TransactionOp[] = [{ kind: 'moveBlock', from: [99], to: [0] }];
		expect(invertOps(ops, before)).toBeNull();
	});

	it('returns null if ANY op in the batch is non-invertible', () => {
		const before = state(para('b0', 'hello'));
		const ops: TransactionOp[] = [
			{ kind: 'replaceText', path: [0], from: 5, to: 5, insert: [span('!')] },
			{ kind: 'removeBlock', path: [99] },
		];
		expect(invertOps(ops, before)).toBeNull();
	});
});

describe('findBlockPathById', () => {
	it('finds a top-level block', () => {
		const doc = state(para('b0', 'a'), para('b1', 'b')).doc;
		expect(findBlockPathById(doc, 'b1')).toEqual([1]);
	});

	it('finds a nested block', () => {
		const doc: EditorState['doc'] = {
			type: 'doc',
			children: [{ id: 'list', type: 'list', children: [para('li0', 'one'), para('li1', 'two')] }],
		};
		expect(findBlockPathById(doc, 'li1')).toEqual([0, 1]);
	});

	it('returns null when the id is absent', () => {
		const doc = state(para('b0', 'a')).doc;
		expect(findBlockPathById(doc, 'nope')).toBeNull();
	});
});
