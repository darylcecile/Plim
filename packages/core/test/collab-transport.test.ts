import { describe, expect, it } from 'vitest';
import {
	type CollabMessage,
	type EditorState,
	type HubClient,
	type LedgerRecord,
	type Peer,
	CollabHub,
	InMemoryAuthority,
	Transaction,
	blockPlainText,
	coversRecord,
	createMemoryNetwork,
	mergeVersionVectors,
	newId,
	recordFromTransaction,
	recordsAfter,
	versionVectorOf,
} from '@plim/core';

function doc(...paras: string[]): EditorState {
	return {
		doc: { type: 'doc', children: paras.map((t) => ({ id: newId(), type: 'paragraph', text: t ? [{ text: t }] : [] })) },
		selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
	};
}

function rec(source: string, seq: number, lamport: number, build: (tx: Transaction) => void, base: EditorState): LedgerRecord {
	const tx = new Transaction(base);
	build(tx);
	tx.commit();
	const r = recordFromTransaction(tx, { source, lamport });
	r.seq = seq;
	return r;
}

function plain(state: { doc: { children: { text?: { text: string }[] }[] } }): string {
	return state.doc.children.map((b) => blockPlainText(b as never)).join('|');
}

describe('version vectors', () => {
	const records: LedgerRecord[] = [
		{ id: 'a1', ops: [], timestamp: 1, lamport: 1, source: 'a', seq: 1, touches: [] },
		{ id: 'a2', ops: [], timestamp: 2, lamport: 2, source: 'a', seq: 2, touches: [] },
		{ id: 'b1', ops: [], timestamp: 3, lamport: 3, source: 'b', seq: 1, touches: [] },
	];

	it('summarizes the highest seq per source', () => {
		expect(versionVectorOf(records)).toEqual({ a: 2, b: 1 });
	});

	it('coversRecord reflects what a vector has seen', () => {
		const vv = { a: 1 };
		expect(coversRecord(vv, records[0]!)).toBe(true); // a@1 <= 1
		expect(coversRecord(vv, records[1]!)).toBe(false); // a@2 > 1
		expect(coversRecord(vv, records[2]!)).toBe(false); // b unseen
	});

	it('recordsAfter returns only the unseen suffix', () => {
		expect(recordsAfter(records, { a: 1 }).map((r) => r.id)).toEqual(['a2', 'b1']);
		expect(recordsAfter(records, { a: 2, b: 1 })).toEqual([]);
	});

	it('mergeVersionVectors takes the pointwise max', () => {
		expect(mergeVersionVectors({ a: 2, b: 1 }, { b: 5, c: 1 })).toEqual({ a: 2, b: 5, c: 1 });
	});
});

describe('InMemoryAuthority', () => {
	it('appends records authored against head with no rebase', () => {
		const base = doc('hello');
		const authority = new InMemoryAuthority(base.doc);
		const r = rec('a', 1, 1, (tx) => tx.insertText([0], 5, ' world'), base);
		const result = authority.submit(0, [r]);
		expect(result.order).toBe(0);
		expect(result.records).toHaveLength(1);
		expect(authority.head).toBe(1);
		expect(plain({ doc: authority.doc } as never)).toBe('hello world');
	});

	it('rebases a concurrent submission over the gap so both edits survive', () => {
		const base = doc('hello');
		const authority = new InMemoryAuthority(base.doc);
		// Two clients both insert at the very start of the same block, authored against the same base.
		const a = rec('a', 1, 1, (tx) => tx.insertText([0], 0, 'A'), base);
		const b = rec('b', 1, 1, (tx) => tx.insertText([0], 0, 'B'), base);
		authority.submit(0, [a]); // canonical: "Ahello"
		const result = authority.submit(0, [b]); // b was authored against "hello" (base 0); gap = [a]
		expect(result.order).toBe(1);
		expect(result.dropped).toHaveLength(0);
		// b rebased over a's insert → both characters present, a wins the earlier slot (canonical order).
		const text = blockPlainText(authority.doc.children[0] as never);
		expect(text).toContain('A');
		expect(text).toContain('B');
		expect(text.endsWith('hello')).toBe(true);
		expect(text).toHaveLength('hello'.length + 2);
	});

	it('is idempotent: re-submitting an already-canonical record is a no-op', () => {
		const base = doc('x');
		const authority = new InMemoryAuthority(base.doc);
		const r = rec('a', 1, 1, (tx) => tx.insertText([0], 1, 'y'), base);
		authority.submit(0, [r]);
		const again = authority.submit(0, [r]);
		expect(again.records).toHaveLength(0);
		expect(authority.head).toBe(1);
	});

	it('drops a submission the concurrent change made ambiguous (removed its block)', () => {
		const base = doc('one', 'two');
		const authority = new InMemoryAuthority(base.doc);
		const remove = rec('a', 1, 1, (tx) => tx.removeBlock([1]), base);
		const edit = rec('b', 1, 1, (tx) => tx.insertText([1], 3, '!'), base); // edits block that 'a' removes
		authority.submit(0, [remove]);
		const result = authority.submit(0, [edit]);
		expect(result.records).toHaveLength(0);
		expect(result.dropped).toHaveLength(1);
		expect(authority.head).toBe(1);
	});

	it('since() returns the canonical tail for delta sync', () => {
		const base = doc('a');
		const authority = new InMemoryAuthority(base.doc);
		for (let i = 0; i < 3; i++) {
			// Authored against the current head (gap-free), so each applies raw.
			const r = rec('a', i + 1, i + 1, (tx) => tx.insertText([0], 0, String(i)), base);
			authority.submit(authority.head, [r]);
		}
		expect(authority.head).toBe(3);
		expect(authority.since(1)).toHaveLength(2);
		expect(authority.versionVector()).toEqual({ a: 3 });
	});
});

describe('createMemoryNetwork', () => {
	it('handshake replies with welcome and the full backlog', () => {
		const base = doc('seed');
		const net = createMemoryNetwork({ origin: base.doc });
		// Pre-load one canonical record directly through the authority.
		const r = rec('x', 1, 1, (tx) => tx.insertText([0], 4, '!'), base);
		net.authority.submit(0, [r]);

		const inbox: CollabMessage[] = [];
		const t = net.connect();
		t.onMessage((m) => inbox.push(m));
		t.send({ type: 'hello', peer: { id: 'me' }, head: 0 });

		const welcome = inbox.find((m) => m.type === 'welcome');
		const confirm = inbox.find((m) => m.type === 'confirm');
		expect(welcome).toMatchObject({ type: 'welcome', head: 1 });
		expect(confirm).toMatchObject({ type: 'confirm', order: 0 });
		expect(confirm && confirm.type === 'confirm' && confirm.records).toHaveLength(1);
	});

	it('broadcasts confirmed records to every peer including the sender', () => {
		const base = doc('hi');
		const net = createMemoryNetwork({ origin: base.doc });
		const peerA: Peer = { id: 'a' };
		const peerB: Peer = { id: 'b' };
		const inboxA: CollabMessage[] = [];
		const inboxB: CollabMessage[] = [];
		const ta = net.connect();
		const tb = net.connect();
		ta.onMessage((m) => inboxA.push(m));
		tb.onMessage((m) => inboxB.push(m));
		ta.send({ type: 'hello', peer: peerA, head: 0 });
		tb.send({ type: 'hello', peer: peerB, head: 0 });

		const r = rec('a', 1, 1, (tx) => tx.insertText([0], 2, '!'), base);
		ta.send({ type: 'submit', from: 'a', base: 0, records: [r] });

		const confirmsA = inboxA.filter((m) => m.type === 'confirm' && m.records.length > 0);
		const confirmsB = inboxB.filter((m) => m.type === 'confirm' && m.records.length > 0);
		expect(confirmsA.at(-1)).toMatchObject({ type: 'confirm', order: 0 });
		expect(confirmsB.at(-1)).toMatchObject({ type: 'confirm', order: 0 });
	});

	it('relays presence to other peers but not the sender, and announces bye on close', () => {
		const net = createMemoryNetwork();
		const inboxA: CollabMessage[] = [];
		const inboxB: CollabMessage[] = [];
		const ta = net.connect();
		const tb = net.connect();
		ta.onMessage((m) => inboxA.push(m));
		tb.onMessage((m) => inboxB.push(m));
		ta.send({ type: 'hello', peer: { id: 'a' }, head: 0 });
		tb.send({ type: 'hello', peer: { id: 'b' }, head: 0 });

		ta.send({ type: 'presence', peer: { id: 'a' }, state: { selection: null }, clock: 1 });
		expect(inboxB.some((m) => m.type === 'presence')).toBe(true);
		expect(inboxA.some((m) => m.type === 'presence')).toBe(false);

		ta.close();
		expect(inboxB.some((m) => m.type === 'bye' && m.peerId === 'a')).toBe(true);
	});

	it('caches presence so a late joiner sees existing cursors immediately', () => {
		const net = createMemoryNetwork();
		const ta = net.connect();
		ta.send({ type: 'hello', peer: { id: 'a' }, head: 0 });
		ta.send({ type: 'presence', peer: { id: 'a' }, state: { selection: { anchor: { path: [0], offset: 1 }, head: { path: [0], offset: 1 } } }, clock: 1 });

		const inboxB: CollabMessage[] = [];
		const tb = net.connect();
		tb.onMessage((m) => inboxB.push(m));
		tb.send({ type: 'hello', peer: { id: 'b' }, head: 0 });
		expect(inboxB.some((m) => m.type === 'presence' && m.peer.id === 'a')).toBe(true);
	});
});

describe('CollabHub (transport-agnostic server)', () => {
function client(inbox: CollabMessage[]): HubClient {
return { send: (m) => inbox.push(m) };
}

it('handshake replies with welcome + backlog, replays cached presence, and linearizes submits to all', () => {
const base = doc('seed');
const hub = new CollabHub(base.doc);
const inboxA: CollabMessage[] = [];
const inboxB: CollabMessage[] = [];
const a = client(inboxA);
const b = client(inboxB);

hub.add(a);
hub.receive(a, { type: 'hello', peer: { id: 'a' }, head: 0 });
expect(inboxA.find((m) => m.type === 'welcome')).toMatchObject({ head: 0 });
expect(inboxA.find((m) => m.type === 'confirm')).toMatchObject({ order: 0 });
expect(hub.peers()).toEqual(['a']);

// A announces presence; B joins late and must see A's cursor in its handshake replay.
hub.receive(a, { type: 'presence', peer: { id: 'a' }, state: { selection: null }, clock: 1 });
hub.add(b);
hub.receive(b, { type: 'hello', peer: { id: 'b' }, head: 0 });
expect(inboxB.some((m) => m.type === 'presence' && m.peer.id === 'a')).toBe(true);

// A submit is broadcast to BOTH peers (sender included) in canonical position.
const r = rec('a', 1, 1, (tx) => tx.insertText([0], 4, '!'), base);
inboxA.length = 0;
inboxB.length = 0;
hub.receive(a, { type: 'submit', from: 'a', base: 0, records: [r] });
expect(inboxA.at(-1)).toMatchObject({ type: 'confirm', order: 0 });
expect(inboxB.at(-1)).toMatchObject({ type: 'confirm', order: 0 });
expect(hub.authority.head).toBe(1);
});

it('remove announces bye to the rest and forgets the departed peer cached presence', () => {
const hub = new CollabHub();
const inboxB: CollabMessage[] = [];
const a = client([]);
const b = client(inboxB);
hub.add(a);
hub.add(b);
hub.receive(a, { type: 'hello', peer: { id: 'a' }, head: 0 });
hub.receive(b, { type: 'hello', peer: { id: 'b' }, head: 0 });
hub.receive(a, { type: 'presence', peer: { id: 'a' }, state: { selection: null }, clock: 1 });

hub.remove(a);
expect(inboxB.some((m) => m.type === 'bye' && m.peerId === 'a')).toBe(true);
expect(hub.peers()).toEqual(['b']);

// A fresh late joiner must NOT inherit the removed peer's stale cursor.
const inboxC: CollabMessage[] = [];
const c = client(inboxC);
hub.add(c);
hub.receive(c, { type: 'hello', peer: { id: 'c' }, head: 0 });
expect(inboxC.some((m) => m.type === 'presence' && m.peer.id === 'a')).toBe(false);
});
});
