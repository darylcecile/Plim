import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type BlockNode,
	type DocumentNode,
	type EditorState,
	type Transaction as TransactionType,
	Transaction,
	applyTransaction,
	blockPlainText,
	newId,
} from '@plim/core';
import { type LedgerRecord, recordFromTransaction } from '@plim/ledger';
import {
	type CollabEditor,
	type CollabMessage,
	type MemoryNetwork,
	type Peer,
	type Transport,
	Collaborator,
	createMemoryNetwork,
} from '@plim/collaboration';

// ---- harness ----------------------------------------------------------------

function para(text: string, type = 'paragraph'): BlockNode {
	return { id: newId(), type, text: text ? [{ text }] : [] };
}

function baseDoc(): DocumentNode {
	return { type: 'doc', children: [para('alpha'), para('bravo'), para('charlie')] };
}

function cloneDoc(doc: DocumentNode): DocumentNode {
	return JSON.parse(JSON.stringify(doc)) as DocumentNode;
}

function stateFrom(doc: DocumentNode): EditorState {
	return { doc, selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } } };
}

/** A minimal editor: setState does NOT fire onTransaction (mirrors the real editor), emit() does. */
function makeEditor(doc: DocumentNode) {
	let state = stateFrom(doc);
	let setStateCalls = 0;
	const listeners = new Set<(tx: TransactionType, st: EditorState) => void>();
	const handle: CollabEditor = {
		getState: () => state,
		setState: (next) => {
			setStateCalls += 1;
			state = next;
		},
		onTransaction: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
	function emit(build: (tx: Transaction) => void): void {
		const tx = new Transaction(state);
		build(tx);
		tx.commit();
		state = applyTransaction(state, tx);
		for (const l of [...listeners]) l(tx, state);
	}
	return { handle, emit, current: () => state, setStateCalls: () => setStateCalls };
}

/** Strip ids (which split mints fresh per-apply) and normalize marks → the real convergence surface. */
function project(doc: DocumentNode): unknown {
	const block = (b: BlockNode): unknown => ({
		type: b.type,
		attrs: b.attrs ?? null,
		text: (b.text ?? []).map((s) => ({ text: s.text, marks: (s.marks ?? []).map((m) => m.type).sort() })),
		children: (b.children ?? []).map(block),
	});
	return doc.children.map(block);
}

function makePeer(net: MemoryNetwork, id: string, doc: DocumentNode, autoStart = true) {
	const editor = makeEditor(cloneDoc(doc));
	const peer: Peer = { id, name: id };
	const collab = new Collaborator({ peer, editor: editor.handle, transport: net.connect(), autoStart });
	return { id, editor, collab };
}

/** Drain the network's simulated-latency timer queue to quiescence. */
function settle(): void {
	let guard = 0;
	while (vi.getTimerCount() > 0 && guard++ < 200_000) vi.advanceTimersToNextTimer();
}

// ---- deterministic PRNG -----------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomEdit(rng: () => number, editor: ReturnType<typeof makeEditor>): void {
	const blocks = editor.current().doc.children;
	if (blocks.length === 0) return;
	const bi = Math.floor(rng() * blocks.length);
	const block = blocks[bi]!;
	const text = blockPlainText(block);
	const choice = rng();
	editor.emit((tx) => {
		if (choice < 0.45) {
			const off = Math.floor(rng() * (text.length + 1));
			tx.insertText([bi], off, 'xyzQ! '[Math.floor(rng() * 6)]!);
		} else if (choice < 0.65 && text.length > 0) {
			const off = Math.floor(rng() * text.length);
			tx.replaceRange([bi], off, off + 1, []);
		} else if (choice < 0.8 && text.length > 1) {
			const off = 1 + Math.floor(rng() * (text.length - 1));
			tx.splitBlock([bi], off);
		} else if (choice < 0.92) {
			tx.setBlockType([bi], block.type === 'heading' ? 'paragraph' : 'heading');
		} else if (text.length > 0) {
			const a = Math.floor(rng() * text.length);
			const b = a + 1 + Math.floor(rng() * (text.length - a));
			tx.toggleMark('bold', { path: [bi], from: a, to: b });
		} else {
			tx.insertText([bi], 0, 'a');
		}
	});
}

// ---- tests ------------------------------------------------------------------

describe('Collaborator — optimistic local editing', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('applies local edits instantly and drains pending once confirmed', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 5 });
		const { editor, collab } = makePeer(net, 'a', baseDoc());
		settle(); // handshake

		editor.emit((tx) => tx.insertText([0], 5, '!'));
		expect(blockPlainText(editor.current().doc.children[0]!)).toBe('alpha!'); // optimistic, before ack
		expect(collab.status.pending).toBe(1);
		expect(collab.status.inflight).toBe(true);

		settle();
		expect(collab.status.pending).toBe(0);
		expect(collab.status.inflight).toBe(false);
		expect(blockPlainText(collab.confirmedDocument.children[0]!)).toBe('alpha!');
	});

	it('does not corrupt the doc when two local edits are pending at once (own-ack must not re-rebase)', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 5 });
		const { editor, collab } = makePeer(net, 'a', baseDoc());
		settle();

		// Two quick edits → both pending (one in flight, one queued) with NO remote concurrency.
		editor.emit((tx) => tx.insertText([0], 5, '1'));
		editor.emit((tx) => tx.insertText([0], 6, '2'));
		expect(collab.status.pending).toBe(2);

		settle();
		expect(collab.status.pending).toBe(0);
		expect(blockPlainText(collab.confirmedDocument.children[0]!)).toBe('alpha12');
	});

	it('never rebuilds the editor on a pure self-ack (caret must not be disturbed mid-type)', () => {
		// Regression: a self-ack used to call recomputeEditor → setState, rebuilding the doc under the
		// user's caret for zero visible change. In a real DOM that resets the native caret and the next
		// keystrokes land in the wrong block. The optimistic editor already shows confirmedDoc + pending
		// on a self-ack, so the Collaborator must leave it untouched (no setState).
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 5 });
		const { editor, collab } = makePeer(net, 'a', baseDoc());
		settle(); // handshake

		const setStateBefore = editor.setStateCalls();
		editor.emit((tx) => {
			tx.insertText([0], 5, '!');
			tx.setSelection({ anchor: { path: [0], offset: 6 }, head: { path: [0], offset: 6 } });
		});
		const caretAfterType = editor.current().selection.head;
		expect(collab.status.pending).toBe(1);

		settle(); // the edit round-trips back as a confirmed self-ack

		expect(collab.status.pending).toBe(0);
		// The acked edit must NOT have triggered a view rebuild — that is what steals the caret mid-type.
		expect(editor.setStateCalls()).toBe(setStateBefore);
		// Caret is exactly where the user left it and the doc is correct.
		expect(editor.current().selection.head).toEqual(caretAfterType);
		expect(blockPlainText(editor.current().doc.children[0]!)).toBe('alpha!');
	});
});

describe('Collaborator — two-peer convergence', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('keeps both concurrent inserts and converges to one document', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 5 });
		const a = makePeer(net, 'a', baseDoc());
		const b = makePeer(net, 'b', baseDoc());
		settle();

		// Concurrent: both insert at the very start of block 0 before either confirms.
		a.editor.emit((tx) => tx.insertText([0], 0, 'A'));
		b.editor.emit((tx) => tx.insertText([0], 0, 'B'));
		settle();

		const textA = blockPlainText(a.collab.confirmedDocument.children[0]!);
		expect(textA).toContain('A');
		expect(textA).toContain('B');
		expect(textA.endsWith('alpha')).toBe(true);
		expect(project(a.collab.confirmedDocument)).toEqual(project(b.collab.confirmedDocument));
		expect(project(a.collab.confirmedDocument)).toEqual(project(net.authority.doc));
	});

	it('preserves the local caret across a remote insert (never adopts the remote cursor)', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 5 });
		const a = makePeer(net, 'a', baseDoc());
		const b = makePeer(net, 'b', baseDoc());
		settle();

		// A places its caret at end of "alpha" (offset 5).
		a.editor.emit((tx) => tx.setSelection({ anchor: { path: [0], offset: 5 }, head: { path: [0], offset: 5 } }));
		// B inserts two chars at the start of the same block.
		b.editor.emit((tx) => tx.insertText([0], 0, 'BB'));
		settle();

		// A's caret should have shifted right by 2 to stay after "alpha", not jumped to B's caret.
		expect(a.editor.current().selection.head).toEqual({ path: [0], offset: 7 });
	});
});

describe('Collaborator — presence', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('shares awareness between peers without touching the ledger', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 5 });
		const a = makePeer(net, 'a', baseDoc());
		const b = makePeer(net, 'b', baseDoc());
		settle();

		a.collab.setPresence({ status: 'editing', selection: { anchor: { path: [1], offset: 2 }, head: { path: [1], offset: 2 } } });
		settle();

		expect(b.collab.peers.map((p) => p.peer.id)).toContain('a');
		expect(b.collab.peers.find((p) => p.peer.id === 'a')?.state.status).toBe('editing');
		expect(a.collab.ledger.length).toBe(0); // presence never logged
		expect(b.collab.ledger.length).toBe(0);
	});

	it('drops a peer from presence when it leaves', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 5 });
		const a = makePeer(net, 'a', baseDoc());
		const b = makePeer(net, 'b', baseDoc());
		settle();
		a.collab.setPresence({ status: 'here' });
		settle();
		expect(b.collab.peers).toHaveLength(1);

		a.collab.destroy();
		settle();
		expect(b.collab.peers).toHaveLength(0);
	});
});

describe('Collaborator — late join / delta sync', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('replays the full backlog onto a peer that joins after edits happened', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 5 });
		const a = makePeer(net, 'a', baseDoc());
		settle();
		a.editor.emit((tx) => tx.insertText([0], 5, ' edited'));
		a.editor.emit((tx) => tx.setBlockType([1], 'heading'));
		settle();

		// B joins late.
		const b = makePeer(net, 'b', baseDoc());
		settle();
		expect(b.collab.status.head).toBe(a.collab.status.head);
		expect(project(b.collab.confirmedDocument)).toEqual(project(a.collab.confirmedDocument));
		expect(project(b.collab.confirmedDocument)).toEqual(project(net.authority.doc));
	});
});

describe('Collaborator — fuzz convergence (regression guard)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	for (const seed of [1, 7, 42, 1337, 90210]) {
		it(`N peers + random concurrent schedules converge (seed ${seed})`, () => {
			const rng = mulberry32(seed);
			const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: () => 1 + Math.floor(rng() * 8) });
			const peers = ['a', 'b', 'c', 'd'].map((id) => makePeer(net, id, baseDoc()));
			settle();

			for (let round = 0; round < 40; round++) {
				// Each peer independently maybe makes an edit this round; edits pile up concurrently.
				for (const p of peers) {
					if (rng() < 0.7) randomEdit(rng, p.editor);
				}
				// Sometimes flush the wire mid-round (partial delivery → deeper concurrency), sometimes not.
				if (rng() < 0.4) {
					const steps = 1 + Math.floor(rng() * 5);
					for (let s = 0; s < steps && vi.getTimerCount() > 0; s++) vi.advanceTimersToNextTimer();
				}
			}

			// Drain everything to quiescence, then keep flushing until all pending chains resolve.
			settle();
			let guard = 0;
			while (peers.some((p) => p.collab.status.pending > 0 || p.collab.status.inflight) && guard++ < 100) settle();

			// Every peer drained to empty and converged on the canonical document.
			for (const p of peers) {
				expect(p.collab.status.pending).toBe(0);
				expect(p.collab.status.inflight).toBe(false);
				expect(project(p.collab.confirmedDocument)).toEqual(project(net.authority.doc));
				expect(project(p.editor.current().doc)).toEqual(project(net.authority.doc));
			}
		});
	}
});

describe('Collaborator — presence liveness (opt-in heartbeat + TTL)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('reclaims a peer that vanished without a `bye`, while keeping peers that keep heartbeating', () => {
		// Synchronous wire (latency 0 ⇒ no delivery timers) so the ONLY timers in
		// play are the heartbeat intervals — making the teardown leak-check exact.
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 0 });
		const HEARTBEAT = 1000;
		const TTL = 2500;

		// Observer A heartbeats and prunes anyone it hasn't heard from within TTL.
		const aEditor = makeEditor(cloneDoc(baseDoc()));
		const a = new Collaborator({
			peer: { id: 'a', name: 'a' },
			editor: aEditor.handle,
			transport: net.connect(),
			heartbeatMs: HEARTBEAT,
			ttlMs: TTL,
		});

		// B announces once then goes dark — no heartbeat, never sends `bye` (a crash / closed tab).
		const bEditor = makeEditor(cloneDoc(baseDoc()));
		const b = new Collaborator({
			peer: { id: 'b', name: 'b' },
			editor: bEditor.handle,
			transport: net.connect(),
		});

		// C keeps heartbeating, so A must keep it alive across TTL windows.
		const cEditor = makeEditor(cloneDoc(baseDoc()));
		const c = new Collaborator({
			peer: { id: 'c', name: 'c' },
			editor: cEditor.handle,
			transport: net.connect(),
			heartbeatMs: HEARTBEAT,
		});

		// Make A aware of both peers up front (latency 0 ⇒ delivered synchronously).
		b.setPresence({ status: 'editing' });
		c.setPresence({ status: 'editing' });
		expect(a.peers.map((p) => p.peer.id).sort()).toEqual(['b', 'c']);

		// Advance well past the TTL. C heartbeats (A refreshes it); B stays silent.
		vi.advanceTimersByTime(HEARTBEAT * 4);

		const ids = a.peers.map((p) => p.peer.id).sort();
		expect(ids).toContain('c'); // kept alive by its heartbeats
		expect(ids).not.toContain('b'); // reclaimed by TTL after the silent disconnect

		// Graceful teardown clears every heartbeat interval — no leaked timers.
		a.destroy();
		b.destroy();
		c.destroy();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not arm a heartbeat timer when heartbeatMs is unset (default off)', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 0 });
		const editor = makeEditor(cloneDoc(baseDoc()));
		const solo = new Collaborator({ peer: { id: 'solo', name: 'solo' }, editor: editor.handle, transport: net.connect() });
		// No heartbeat opt-in ⇒ no recurring timer (keeps `settle()`-style drains finite for every other test).
		expect(vi.getTimerCount()).toBe(0);
		solo.destroy();
	});
});

describe('Collaborator — reconnect / backlog replay', () => {
	// A controllable transport: capture what the Collaborator sends, and hand-deliver inbound messages.
	function mockTransport() {
		let handler: ((m: CollabMessage) => void) | null = null;
		const sent: CollabMessage[] = [];
		const transport: Transport = {
			send: (m) => sent.push(m),
			onMessage: (h) => {
				handler = h;
				return () => {
					handler = null;
				};
			},
			close: () => {},
		};
		return { transport, sent, deliver: (m: CollabMessage) => handler?.(m) };
	}

	// Mint a genuine remote record authored by another peer against `origin`.
	function remoteRecord(origin: DocumentNode, build: (tx: TransactionType) => void, source: string, seq: number): LedgerRecord {
		const tx = new Transaction(stateFrom(cloneDoc(origin)));
		build(tx);
		tx.commit();
		const rec = recordFromTransaction(tx, { source, lamport: seq });
		rec.seq = seq;
		return rec;
	}

	const lastSubmit = (sent: CollabMessage[]): Extract<CollabMessage, { type: 'submit' }> | undefined =>
		[...sent].reverse().find((m): m is Extract<CollabMessage, { type: 'submit' }> => m.type === 'submit');

	it('converges when a reconnect backlog mixes our own canonical record with an unseen remote record', () => {
		// Regression: the hub answers a (re)`hello`/`sync` with the WHOLE canonical backlog from our
		// confirmed head in one `confirm`. If our socket dropped after a record we authored was appended
		// canonically but before its confirm arrived, that backlog legitimately interleaves our own
		// now-canonical record with remote edits made while we were away. The Collaborator must fold the
		// batch and converge — it used to throw on this "mixed" batch and wedge the tab on every reconnect.
		const origin = baseDoc();
		const { transport, sent, deliver } = mockTransport();
		const editor = makeEditor(cloneDoc(origin));
		const me = new Collaborator({ peer: { id: 'a', name: 'a' }, editor: editor.handle, transport });

		// We author P and it reaches the authority (it is in flight), but its confirm never comes back.
		editor.emit((tx) => tx.insertText([0], 0, 'X')); // 'alpha' -> 'Xalpha'
		const P = lastSubmit(sent)!.records[0]!;
		expect(me.status.pending).toBe(1);
		expect(me.status.inflight).toBe(true);

		// While we were disconnected, peer 'b' inserted into a different block; canonical order is [P, R].
		const R = remoteRecord(origin, (tx) => tx.insertText([1], 0, 'Z'), 'b', 1); // 'bravo' -> 'Zbravo'

		// Reconnect: the hub replays the full backlog from order 0 in one batch.
		expect(() => deliver({ type: 'confirm', order: 0, records: [P, R] })).not.toThrow();

		// Converged: our record acked (pending drained), remote folded, canonical doc == origin + P + R.
		expect(me.status.pending).toBe(0);
		expect(me.status.inflight).toBe(false);
		expect(me.status.head).toBe(2);
		expect(blockPlainText(me.confirmedDocument.children[0]!)).toBe('Xalpha');
		expect(blockPlainText(me.confirmedDocument.children[1]!)).toBe('Zbravo');
		// The visible editor equals the confirmed doc (no pending left).
		expect(project(me.document)).toEqual(project(me.confirmedDocument));

		me.destroy();
	});

	it('keeps and resubmits a surviving pending edit when the reconnect backlog also acks our in-flight record', () => {
		// Two local edits: P is in flight, Q is queued behind it. The reconnect backlog acks P and also
		// carries a remote record R. P must be acked, R folded, and Q must SURVIVE — rebased over R only
		// (not over P, which was already part of Q's optimistic base) — then flushed as the next submit.
		const origin = baseDoc();
		const { transport, sent, deliver } = mockTransport();
		const editor = makeEditor(cloneDoc(origin));
		const me = new Collaborator({ peer: { id: 'a', name: 'a' }, editor: editor.handle, transport });

		editor.emit((tx) => tx.insertText([0], 0, 'X')); // P: 'alpha' -> 'Xalpha'
		editor.emit((tx) => tx.insertText([0], 1, 'Y')); // Q: 'Xalpha' -> 'XYalpha'
		const P = lastSubmit(sent)!.records[0]!;
		expect(me.status.pending).toBe(2);

		const R = remoteRecord(origin, (tx) => tx.insertText([1], 0, 'Z'), 'b', 1); // 'bravo' -> 'Zbravo'

		// Reconnect backlog: [P (ack), R (remote)] — Q is still pending and not in the batch.
		deliver({ type: 'confirm', order: 0, records: [P, R] });

		// P acked + R folded → head 2; Q survives and is flushed as the next in-flight submit.
		expect(me.status.head).toBe(2);
		expect(me.status.pending).toBe(1);
		expect(me.status.inflight).toBe(true);
		const Q = lastSubmit(sent)!.records[0]!;
		expect(Q.id).not.toBe(P.id);
		// Optimistic editor shows confirmed (Xalpha / Zbravo) + Q (the 'Y') => 'XYalpha' / 'Zbravo'.
		expect(blockPlainText(me.document.children[0]!)).toBe('XYalpha');
		expect(blockPlainText(me.document.children[1]!)).toBe('Zbravo');

		// Finally the authority confirms Q → fully drained and converged.
		deliver({ type: 'confirm', order: 2, records: [Q] });
		expect(me.status.pending).toBe(0);
		expect(blockPlainText(me.confirmedDocument.children[0]!)).toBe('XYalpha');

		me.destroy();
	});
});
