import { bench, describe } from 'vitest';
import {
	type BlockNode,
	type CollabEditor,
	type DocumentNode,
	type EditorState,
	type LedgerRecord,
	type Peer,
	type Transaction as TransactionType,
	Collaborator,
	InMemoryAuthority,
	PresenceTracker,
	Transaction,
	applyTransaction,
	createMemoryNetwork,
	newId,
	rebaseRecord,
	recordFromTransaction,
} from '@plim/core';

// ---- shared fixtures --------------------------------------------------------

function para(text: string, type = 'paragraph'): BlockNode {
	return { id: newId(), type, text: text ? [{ text }] : [] };
}

function baseDoc(): DocumentNode {
	return { type: 'doc', children: [para('the quick brown fox jumps over the lazy dog')] };
}

function cloneDoc(doc: DocumentNode): DocumentNode {
	return JSON.parse(JSON.stringify(doc)) as DocumentNode;
}

function stateFrom(doc: DocumentNode): EditorState {
	return { doc, selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } } };
}

/** Author `n` records that each insert one char at the head of block 0 — always
 *  applicable regardless of prior history, so they exercise integrate/rebase
 *  without ever bailing. */
function authorRecords(n: number): LedgerRecord[] {
	const state = stateFrom(baseDoc());
	const out: LedgerRecord[] = [];
	for (let i = 0; i < n; i++) {
		const tx = new Transaction(state);
		tx.insertText([0], 0, String.fromCharCode(97 + (i % 26)));
		tx.commit();
		const record = recordFromTransaction(tx, { source: 'bench', id: `r${i}`, lamport: i });
		record.seq = i + 1;
		out.push(record);
	}
	return out;
}

// ---- record authoring -------------------------------------------------------

describe('collab: record authoring', () => {
	const state = stateFrom(baseDoc());
	const tx = new Transaction(state);
	tx.insertText([0], 10, 'hello world');
	tx.commit();

	bench('recordFromTransaction (insert)', () => {
		recordFromTransaction(tx, { source: 'bench' });
	});
});

// ---- authority integration --------------------------------------------------

describe('collab: authority integrate', () => {
	const records = authorRecords(500);

	bench('submit 500 records, gap-free (fast path)', () => {
		const authority = new InMemoryAuthority(baseDoc());
		for (const r of records) authority.submit(authority.head, [r]);
	});

	bench('submit 150 records, all concurrent (rebase over growing gap)', () => {
		const authority = new InMemoryAuthority(baseDoc());
		for (let i = 0; i < 150; i++) authority.submit(0, [records[i]!]);
	});
});

// ---- rebase primitive -------------------------------------------------------

describe('collab: rebase primitive', () => {
	const over = authorRecords(20);
	const target = authorRecords(21)[20]!;
	const base = baseDoc();

	bench('rebaseRecord over 20 ops', () => {
		rebaseRecord(target, over, base);
	});
});

// ---- presence ---------------------------------------------------------------

describe('collab: presence', () => {
	const tracker = new PresenceTracker({ id: 'self', name: 'self' });
	const peers: Peer[] = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `p${i}` }));
	let clock = 0;

	bench('applyRemote (cursor update from 20 peers)', () => {
		const peer = peers[clock % peers.length]!;
		tracker.applyRemote({
			peer,
			state: { selection: { anchor: { path: [0], offset: clock % 40 }, head: { path: [0], offset: clock % 40 } } },
			clock: ++clock,
		});
	});
});

// ---- end-to-end N-peer round ------------------------------------------------

function makeEditor(doc: DocumentNode) {
	let state = stateFrom(doc);
	const listeners = new Set<(tx: TransactionType, st: EditorState) => void>();
	const handle: CollabEditor = {
		getState: () => state,
		setState: (next) => {
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
	return { handle, emit, current: () => state };
}

describe('collab: end-to-end', () => {
	bench('3 peers × 30 edits each, synchronous propagation + convergence', () => {
		const net = createMemoryNetwork({ origin: baseDoc(), latencyMs: 0 });
		const editors = ['a', 'b', 'c'].map((id) => {
			const editor = makeEditor(cloneDoc(baseDoc()));
			const collab = new Collaborator({ peer: { id, name: id }, editor: editor.handle, transport: net.connect() });
			return { editor, collab };
		});
		for (let round = 0; round < 30; round++) {
			for (const { editor } of editors) {
				editor.emit((tx) => tx.insertText([0], 0, 'x'));
			}
		}
		for (const { collab } of editors) collab.destroy();
	});
});
