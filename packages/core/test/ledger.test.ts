import { describe, expect, it, vi } from 'vitest';
import {
	type EditorHandle,
	type EditorState,
	type Transaction as TransactionType,
	TransactionLedger,
	Transaction,
	applyTransaction,
	blockPlainText,
	compareRecords,
	diffLedgers,
	mergeLedgers,
	newId,
	recordFromTransaction,
	summarizeRecord,
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

/** A minimal EditorHandle stub exposing just what the ledger touches, plus an `emit` to simulate dispatch. */
function fakeEditor(initial: EditorState) {
	let state = initial;
	const listeners = new Set<(tx: TransactionType, st: EditorState) => void>();
	const handle = {
		getState: () => state,
		setState: (next: EditorState) => {
			state = next;
		},
		onTransaction: (cb: (tx: TransactionType, st: EditorState) => void) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	} as unknown as EditorHandle;
	function emit(build: (tx: Transaction) => void): void {
		const tx = new Transaction(state);
		build(tx);
		tx.commit();
		const after = applyTransaction(state, tx);
		state = after;
		for (const l of listeners) l(tx, after);
	}
	return { handle, emit, current: () => state };
}

/** Thread a sequence of edits through evolving state, recording each. Returns the final state. */
function authored(ledger: TransactionLedger, base: EditorState, edits: Array<(tx: Transaction) => void>): EditorState {
	let st = base;
	let t = 0;
	for (const build of edits) {
		const tx = new Transaction(st);
		build(tx);
		tx.commit();
		ledger.record(tx, { timestamp: ++t });
		st = applyTransaction(st, tx);
	}
	return st;
}

describe('compareRecords', () => {
	it('orders by timestamp, then lamport, then source, then id', () => {
		const base = { ops: [], touches: [] } as const;
		const a = { ...base, id: 'a', timestamp: 1, lamport: 0 };
		const b = { ...base, id: 'b', timestamp: 2, lamport: 0 };
		expect(compareRecords(a, b)).toBeLessThan(0);
		const c = { ...base, id: 'c', timestamp: 1, lamport: 5 };
		expect(compareRecords(a, c)).toBeLessThan(0);
		const d = { ...base, id: 'd', timestamp: 1, lamport: 0, source: 'z' };
		const e = { ...base, id: 'e', timestamp: 1, lamport: 0, source: 'a' };
		expect(compareRecords(d, e)).toBeGreaterThan(0);
	});
});

describe('TransactionLedger', () => {
	it('records transactions with monotonically increasing lamport clocks', () => {
		const ledger = new TransactionLedger({ source: 'A' });
		const state = makeState('hello');
		const tx1 = new Transaction(state);
		tx1.insertText([0], 5, '!');
		tx1.commit();
		const r1 = ledger.record(tx1);
		const tx2 = new Transaction(state);
		tx2.insertText([0], 0, 'x');
		tx2.commit();
		const r2 = ledger.record(tx2);
		expect(r1.lamport).toBe(1);
		expect(r2.lamport).toBe(2);
		expect(r1.source).toBe('A');
		expect(ledger.clock).toBe(2);
	});

	it('keeps records sorted chronologically regardless of insertion order', () => {
		const ledger = new TransactionLedger();
		const state = makeState('hello');
		const late = recordFromTransaction(new Transaction(state), { id: 'late', timestamp: 100, lamport: 1 });
		const early = recordFromTransaction(new Transaction(state), { id: 'early', timestamp: 1, lamport: 1 });
		ledger.append(late);
		ledger.append(early);
		expect(ledger.records.map((r) => r.id)).toEqual(['early', 'late']);
	});

	it('replays recorded edits onto a fresh editor seeded with the same base', () => {
		const base = makeState('hello');
		const ledger = new TransactionLedger({ source: 'A' });
		const final = authored(ledger, base, [
			(tx) => tx.insertText([0], 5, ' world'),
			(tx) => tx.splitBlock([0], 5),
			(tx) => tx.insertText([1], 0, '!'),
		]);

		const target = fakeEditor(structuredClone(base));
		ledger.replay(target.handle);
		const replayed = target.current();
		expect(replayed.doc.children.map((b) => blockPlainText(b))).toEqual(final.doc.children.map((b) => blockPlainText(b)));
	});

	it('apply is a pure fold that does not mutate the input state', () => {
		const base = makeState('hello');
		const ledger = new TransactionLedger();
		authored(ledger, base, [(tx) => tx.insertText([0], 5, ' world')]);
		const out = ledger.apply(base);
		expect(blockPlainText(out.doc.children[0]!)).toBe('hello world');
		expect(blockPlainText(base.doc.children[0]!)).toBe('hello');
	});

	it('dedupes by record id', () => {
		const ledger = new TransactionLedger();
		const state = makeState('hello');
		const rec = recordFromTransaction(new Transaction(state), { id: 'dup', timestamp: 1 });
		expect(ledger.append(rec)).toBe(true);
		expect(ledger.append(rec)).toBe(false);
		expect(ledger.length).toBe(1);
	});

	it('advances its clock to observed remote lamports on append', () => {
		const ledger = new TransactionLedger();
		const state = makeState('hello');
		ledger.append(recordFromTransaction(new Transaction(state), { id: 'remote', timestamp: 1, lamport: 42 }));
		expect(ledger.clock).toBe(42);
	});

	it('notifies onRecord subscribers and supports unsubscribe', () => {
		const ledger = new TransactionLedger();
		const state = makeState('hello');
		const cb = vi.fn();
		const off = ledger.onRecord(cb);
		ledger.append(recordFromTransaction(new Transaction(state), { id: 'r1', timestamp: 1 }));
		expect(cb).toHaveBeenCalledTimes(1);
		off();
		ledger.append(recordFromTransaction(new Transaction(state), { id: 'r2', timestamp: 2 }));
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it('attach records forward transactions and detaches cleanly', () => {
		const base = makeState('hello');
		const editor = fakeEditor(base);
		const ledger = new TransactionLedger({ source: 'A' });
		const detach = ledger.attach(editor.handle);
		editor.emit((tx) => tx.insertText([0], 5, '!'));
		expect(ledger.length).toBe(1);
		detach();
		editor.emit((tx) => tx.insertText([0], 0, 'x'));
		expect(ledger.length).toBe(1);
	});

	it('attach honours a filter', () => {
		const base = makeState('hello');
		const editor = fakeEditor(base);
		const ledger = new TransactionLedger();
		ledger.attach(editor.handle, { filter: (tx) => tx.ops.every((op) => op.kind !== 'setSelection') });
		editor.emit((tx) => tx.setSelection({ anchor: { path: [0], offset: 1 }, head: { path: [0], offset: 1 } }));
		expect(ledger.length).toBe(0);
		editor.emit((tx) => tx.insertText([0], 0, 'x'));
		expect(ledger.length).toBe(1);
	});

	it('serializes and deserializes to an equivalent ledger', () => {
		const base = makeState('hello');
		const ledger = new TransactionLedger({ source: 'A' });
		const final = authored(ledger, base, [(tx) => tx.insertText([0], 5, ' world'), (tx) => tx.splitBlock([0], 5)]);
		const payload = ledger.serialize();
		const parsed = JSON.parse(payload);
		expect(parsed.version).toBe(1);
		expect(parsed.records).toHaveLength(2);

		const restored = TransactionLedger.deserialize(payload);
		expect(restored.length).toBe(2);
		expect(restored.clock).toBe(ledger.clock);
		const out = restored.apply(base);
		expect(out.doc.children.map((b) => blockPlainText(b))).toEqual(final.doc.children.map((b) => blockPlainText(b)));
	});
});

describe('mergeLedgers', () => {
	it('unions records into a single chronological order, deduping by id', () => {
		const state = makeState('hello');
		const a = new TransactionLedger({ source: 'A' });
		const b = new TransactionLedger({ source: 'B' });
		a.append(recordFromTransaction(new Transaction(state), { id: 'x', timestamp: 1 }));
		a.append(recordFromTransaction(new Transaction(state), { id: 'shared', timestamp: 3 }));
		b.append(recordFromTransaction(new Transaction(state), { id: 'shared', timestamp: 3 }));
		b.append(recordFromTransaction(new Transaction(state), { id: 'y', timestamp: 2 }));

		const merged = mergeLedgers(a, b);
		expect(merged.records.map((r) => r.id)).toEqual(['x', 'y', 'shared']);
	});

	it('is exposed as an instance method too', () => {
		const state = makeState('hello');
		const a = new TransactionLedger();
		const b = new TransactionLedger();
		a.append(recordFromTransaction(new Transaction(state), { id: 'a', timestamp: 1 }));
		b.append(recordFromTransaction(new Transaction(state), { id: 'b', timestamp: 2 }));
		expect(a.merge(b).records.map((r) => r.id)).toEqual(['a', 'b']);
	});
});

describe('diffLedgers', () => {
	it('partitions records into onlyInA, onlyInB and common', () => {
		const state = makeState('hello');
		const a = new TransactionLedger();
		const b = new TransactionLedger();
		a.append(recordFromTransaction(new Transaction(state), { id: 'x', timestamp: 1 }));
		a.append(recordFromTransaction(new Transaction(state), { id: 'shared', timestamp: 2 }));
		b.append(recordFromTransaction(new Transaction(state), { id: 'shared', timestamp: 2 }));
		b.append(recordFromTransaction(new Transaction(state), { id: 'y', timestamp: 3 }));

		const diff = diffLedgers(a, b);
		expect(diff.onlyInA.map((r) => r.id)).toEqual(['x']);
		expect(diff.onlyInB.map((r) => r.id)).toEqual(['y']);
		expect(diff.common.map((r) => r.id)).toEqual(['shared']);
	});
});

describe('summarizeRecord', () => {
	it('counts ops by kind and lists distinct touched blocks', () => {
		const state = makeState('hello', 'world');
		const id0 = state.doc.children[0]!.id;
		const tx = new Transaction(state);
		tx.insertText([0], 0, 'x');
		tx.insertText([0], 1, 'y');
		tx.commit();
		const rec = recordFromTransaction(tx, { id: 'r', source: 'A', timestamp: 5, lamport: 2 });
		const summary = summarizeRecord(rec);
		expect(summary).toMatchObject({ id: 'r', source: 'A', timestamp: 5, lamport: 2, ops: 2, opKinds: { replaceText: 2 }, blocks: [id0] });
	});
});
