import { describe, expect, it } from 'vitest';
import {
	type EditorState,
	type LedgerRecord,
	Transaction,
	applyLedgerRecord,
	applyOp,
	blockPlainText,
	newId,
	rebaseBlockPath,
	rebaseRecord,
	rebaseRecords,
	rebaseTextPoint,
	recordFromTransaction,
} from '@plim/core';

function p(text: string): { id: string; type: 'paragraph'; text: { text: string }[] } {
	return { id: newId(), type: 'paragraph', text: text ? [{ text }] : [] };
}

function makeState(...paras: string[]): EditorState {
	return {
		doc: { type: 'doc', children: paras.map(p) },
		selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
	};
}

function record(state: EditorState, build: (tx: Transaction) => void, opts: Parameters<typeof recordFromTransaction>[1] = {}): LedgerRecord {
	const tx = new Transaction(state);
	build(tx);
	tx.commit();
	return recordFromTransaction(tx, opts);
}

function texts(state: EditorState): string[] {
	return state.doc.children.map((b) => blockPlainText(b));
}

describe('rebaseTextPoint / rebaseBlockPath', () => {
	it('shifts a text offset after a concurrent insertion earlier in the block', () => {
		const mapped = rebaseTextPoint([0], 11, { kind: 'replaceText', path: [0], from: 0, to: 0, insert: [{ text: 'XX' }] });
		expect(mapped).toEqual({ path: [0], offset: 13 });
	});

	it('moves a sibling index after a concurrent block insertion', () => {
		const mapped = rebaseBlockPath([1], { kind: 'insertBlock', path: [0], block: p('new') });
		expect(mapped).toEqual([2]);
	});

	it('reports a deletion as null', () => {
		const mapped = rebaseBlockPath([0], { kind: 'removeBlock', path: [0] });
		expect(mapped).toBeNull();
	});
});

describe('rebaseRecord — text edits', () => {
	it('rebases a later text edit over a concurrent earlier insertion (and converges both ways)', () => {
		const base = makeState('hello world');
		const over = record(base, (tx) => tx.insertText([0], 0, 'XX'), { id: 'over' });
		const r = record(base, (tx) => tx.insertText([0], 11, '!'), { id: 'r' });

		// Our side: apply `over`, then the rebased `r`.
		const afterOver = applyLedgerRecord(base, over);
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(true);
		if (!rebased.ok) return;
		expect(rebased.record.id).toBe('r'); // identity preserved
		expect(rebased.record.ops[0]).toMatchObject({ kind: 'replaceText', path: [0], from: 13, to: 13 });
		const ours = applyLedgerRecord(afterOver, rebased.record);
		expect(texts(ours)).toEqual(['XXhello world!']);

		// Their side: apply `r`, then `over` rebased over `r`. Must converge to the same doc.
		const afterR = applyLedgerRecord(base, r);
		const rebasedOver = rebaseRecord(over, r, base.doc);
		expect(rebasedOver.ok).toBe(true);
		if (!rebasedOver.ok) return;
		const theirs = applyLedgerRecord(afterR, rebasedOver.record);
		expect(texts(theirs)).toEqual(['XXhello world!']);
	});

	it('recomputes touches into the post-over document space', () => {
		const base = makeState('hello world');
		const over = record(base, (tx) => tx.insertText([0], 0, 'XX'), { id: 'over' });
		const r = record(base, (tx) => tx.replaceRange([0], 6, 11, [{ text: 'there' }]), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(true);
		if (!rebased.ok) return;
		// Original range [6,11) shifts to [8,13) after "XX" is prepended.
		expect(rebased.record.touches[0]).toMatchObject({ scope: 'text', from: 8, to: 13 });
	});

	it('bails when a concurrent split tears a text range across two blocks', () => {
		const base = makeState('hello world');
		const over = record(base, (tx) => tx.splitBlock([0], 5), { id: 'over' });
		const r = record(base, (tx) => tx.replaceRange([0], 3, 8, [{ text: 'X' }]), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(false);
		if (rebased.ok) return;
		expect(rebased.reason).toMatch(/split/i);
	});
});

describe('rebaseRecord — structural edits', () => {
	it('shifts an edit past a concurrent block insertion', () => {
		const base = makeState('a', 'b');
		const over = record(base, (tx) => tx.insertBlock([0], p('new')), { id: 'over' });
		const r = record(base, (tx) => tx.replaceRange([1], 0, 1, [{ text: 'B' }]), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(true);
		if (!rebased.ok) return;
		expect(rebased.record.ops[0]).toMatchObject({ kind: 'replaceText', path: [2] });
		const out = applyLedgerRecord(applyLedgerRecord(base, over), rebased.record);
		expect(texts(out)).toEqual(['new', 'a', 'B']);
	});

	it('shifts an edit back past a concurrent block removal', () => {
		const base = makeState('a', 'b', 'c');
		const over = record(base, (tx) => tx.removeBlock([0]), { id: 'over' });
		const r = record(base, (tx) => tx.replaceRange([2], 0, 1, [{ text: 'C' }]), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(true);
		if (!rebased.ok) return;
		expect(rebased.record.ops[0]).toMatchObject({ kind: 'replaceText', path: [1] });
		const out = applyLedgerRecord(applyLedgerRecord(base, over), rebased.record);
		expect(texts(out)).toEqual(['b', 'C']);
	});

	it('bails when the concurrent change removed the block this record edits', () => {
		const base = makeState('a', 'b');
		const over = record(base, (tx) => tx.removeBlock([1]), { id: 'over' });
		const r = record(base, (tx) => tx.insertText([1], 0, 'z'), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(false);
	});

	it('drops a removal already satisfied by the concurrent change', () => {
		const base = makeState('a', 'b');
		const over = record(base, (tx) => tx.removeBlock([1]), { id: 'over' });
		const r = record(base, (tx) => tx.removeBlock([1]), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(true);
		if (!rebased.ok) return;
		expect(rebased.record.ops).toHaveLength(0); // nothing left to do
	});

	it('moves a text offset into the right-hand block after a concurrent split', () => {
		const base = makeState('hello world');
		const over = record(base, (tx) => tx.splitBlock([0], 5), { id: 'over' });
		const r = record(base, (tx) => tx.insertText([0], 8, '!'), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(true);
		if (!rebased.ok) return;
		expect(rebased.record.ops[0]).toMatchObject({ kind: 'replaceText', path: [1], from: 3, to: 3 });
		const out = applyLedgerRecord(applyLedgerRecord(base, over), rebased.record);
		expect(texts(out)).toEqual(['hello', ' wo!rld']);
	});

	it('survives a concurrent move of an unrelated block but bails on the moved block', () => {
		const base = makeState('a', 'b', 'c');
		const over = record(base, (tx) => tx.moveBlock([2], [0]), { id: 'over' });
		const unrelated = record(base, (tx) => tx.insertText([0], 1, 'X'), { id: 'unrelated' });
		const onMoved = record(base, (tx) => tx.insertText([2], 1, 'Y'), { id: 'onMoved' });
		expect(rebaseRecord(unrelated, over, base.doc).ok).toBe(true);
		expect(rebaseRecord(onMoved, over, base.doc).ok).toBe(false);
	});

	// Exhaustive ground-truth check: for a flat doc, a concurrent moveBlock must map
	// every bystander block to exactly the index where `applyOp` lands it, for BOTH
	// forward (from < to) and backward (from > to) moves. A backward move makes the
	// destination remap a no-op, so a forward case is required to catch double-adjust
	// regressions in the move→insert composition.
	it('maps bystander paths to applyOp ground truth for every single-level move', () => {
		const N = 5;
		const labels = ['a', 'b', 'c', 'd', 'e'];
		for (let from = 0; from < N; from++) {
			for (let to = 0; to < N; to++) {
				if (from === to) continue;
				const base = makeState(...labels);
				const ids = base.doc.children.map((b) => b.id);
				const op = { kind: 'moveBlock' as const, from: [from], to: [to] };
				const moved = applyOp(base, op);
				const finalIndexById = new Map(moved.doc.children.map((b, i) => [b.id, i]));
				for (let k = 0; k < N; k++) {
					const mapped = rebaseBlockPath([k], op);
					if (k === from) {
						// The moved block itself is a conflict surface → bail (null).
						expect(mapped, `moved block from=${from} to=${to}`).toBeNull();
					} else {
						const expected = finalIndexById.get(ids[k]!)!;
						expect(mapped, `bystander k=${k} from=${from} to=${to}`).toEqual([expected]);
					}
				}
			}
		}
	});

	it('maps a forward move bystander correctly (regression: [A,B,C,D], move [1]->[2])', () => {
		// Final order is [A,C,B,D]; C (originally [2]) lands at [1], D stays at [3].
		const op = { kind: 'moveBlock' as const, from: [1], to: [2] };
		expect(rebaseBlockPath([2], op)).toEqual([1]);
		expect(rebaseBlockPath([3], op)).toEqual([3]);
		expect(rebaseBlockPath([0], op)).toEqual([0]);
		expect(rebaseBlockPath([1], op)).toBeNull();
	});
});

describe('rebaseRecord — joins', () => {
	it('rebases an edit to the block that received a concurrent join', () => {
		const base = makeState('hello', 'world');
		// `over` joins block [1] into [0] → single block "helloworld".
		const over = record(base, (tx) => tx.joinBackward([1]), { id: 'over' });
		// `r` edits the first block's existing text, which is untouched by the append.
		const r = record(base, (tx) => tx.insertText([0], 0, 'X'), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(true);
		if (!rebased.ok) return;
		const out = applyLedgerRecord(applyLedgerRecord(base, over), rebased.record);
		expect(texts(out)).toEqual(['Xhelloworld']);
	});

	it('bails on an edit to the block that a concurrent join removed', () => {
		const base = makeState('hello', 'world');
		const over = record(base, (tx) => tx.joinBackward([1]), { id: 'over' });
		const r = record(base, (tx) => tx.insertText([1], 0, 'Z'), { id: 'r' });
		const rebased = rebaseRecord(r, over, base.doc);
		expect(rebased.ok).toBe(false);
	});
});

describe('rebaseRecords', () => {
	it('rebases a batch, collecting failures rather than aborting', () => {
		const base = makeState('hello world', 'second');
		const over = record(base, (tx) => tx.splitBlock([0], 5), { id: 'over' });
		const ok = record(base, (tx) => tx.insertText([1], 0, 'Z'), { id: 'ok' }); // unrelated block
		const bad = record(base, (tx) => tx.replaceRange([0], 3, 8, [{ text: 'X' }]), { id: 'bad' }); // torn by split
		const { rebased, failed } = rebaseRecords([ok, bad], over, base.doc);
		expect(rebased.map((r) => r.id)).toEqual(['ok']);
		expect(failed.map((f) => f.record.id)).toEqual(['bad']);
		// The unrelated edit lands on the now-third block (split pushed "second" from [1] to [2]).
		expect(rebased[0]!.ops[0]).toMatchObject({ kind: 'replaceText', path: [2] });
	});
});
