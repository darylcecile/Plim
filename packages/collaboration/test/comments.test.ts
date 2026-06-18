import { describe, expect, it } from 'vitest';
import {
	type DocumentNode,
	type EditorState,
	Transaction,
	applyTransaction,
	newId,
} from '@plim/core';
import { createMemoryTransportPair } from '@plim/transports';
import {
	type CommentAuthor,
	type CommentMessage,
	CommentStore,
	CommentSync,
	addCommentMark,
	allCommentThreadIds,
	commentMarkRanges,
	commentThreadIdsInSelection,
	findCommentRanges,
	removeCommentMark,
} from '@plim/collaboration';

const alice: CommentAuthor = { id: 'alice', name: 'Alice' };
const bob: CommentAuthor = { id: 'bob', name: 'Bob' };

function shuffle<T>(arr: readonly T[], seed: number): T[] {
	const out = [...arr];
	let s = seed;
	for (let i = out.length - 1; i > 0; i--) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		const j = s % (i + 1);
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

describe('CommentStore — materialization', () => {
	it('creates a thread with its opening comment', () => {
		const store = new CommentStore({ actor: 'alice' });
		const { threadId, commentId } = store.createThread({ author: alice, body: 'first!' });
		const threads = store.threads();
		expect(threads).toHaveLength(1);
		expect(threads[0]!.id).toBe(threadId);
		expect(threads[0]!.resolved).toBe(false);
		expect(threads[0]!.comments).toHaveLength(1);
		expect(threads[0]!.comments[0]!.id).toBe(commentId);
		expect(threads[0]!.comments[0]!.body).toBe('first!');
		expect(threads[0]!.comments[0]!.edited).toBe(false);
	});

	it('appends replies in chronological order', () => {
		const store = new CommentStore({ actor: 'alice' });
		const { threadId } = store.createThread({ author: alice, body: 'q' });
		store.addComment(threadId, { author: bob, body: 'a1' });
		store.addComment(threadId, { author: alice, body: 'a2' });
		const bodies = store.getThread(threadId)!.comments.map((c) => c.body);
		expect(bodies).toEqual(['q', 'a1', 'a2']);
	});

	it('edits a comment (last edit wins, marks edited)', () => {
		const store = new CommentStore({ actor: 'alice' });
		const { commentId } = store.createThread({ author: alice, body: 'typo' });
		store.editComment(commentId, 'fixed');
		const c = store.threads()[0]!.comments[0]!;
		expect(c.body).toBe('fixed');
		expect(c.edited).toBe(true);
	});

	it('deletes a comment (tombstone removes it from view)', () => {
		const store = new CommentStore({ actor: 'alice' });
		const { threadId } = store.createThread({ author: alice, body: 'q' });
		const replyId = store.addComment(threadId, { author: bob, body: 'oops' });
		store.deleteComment(replyId);
		expect(store.getThread(threadId)!.comments.map((c) => c.body)).toEqual(['q']);
	});

	it('resolves and reopens a thread', () => {
		const store = new CommentStore({ actor: 'alice' });
		const { threadId } = store.createThread({ author: alice, body: 'q' });
		store.resolveThread(threadId, bob);
		expect(store.getThread(threadId)!.resolved).toBe(true);
		expect(store.getThread(threadId)!.resolvedBy).toEqual(bob);
		store.reopenThread(threadId);
		expect(store.getThread(threadId)!.resolved).toBe(false);
		expect(store.getThread(threadId)!.resolvedBy).toBeUndefined();
	});

	it('deletes a whole thread', () => {
		const store = new CommentStore({ actor: 'alice' });
		const { threadId } = store.createThread({ author: alice, body: 'q' });
		store.deleteThread(threadId);
		expect(store.threads()).toHaveLength(0);
	});

	it('notifies subscribers on change and stops after unsubscribe', () => {
		const store = new CommentStore({ actor: 'alice' });
		let count = 0;
		const off = store.subscribe(() => {
			count++;
		});
		store.createThread({ author: alice, body: 'a' });
		expect(count).toBe(1);
		off();
		store.createThread({ author: alice, body: 'b' });
		expect(count).toBe(1);
	});
});

describe('CommentStore — convergence', () => {
	it('two stores fed the same events in shuffled/duplicated order converge', () => {
		const source = new CommentStore({ actor: 'alice' });
		const { threadId, commentId } = source.createThread({ author: alice, body: 'q' });
		const r1 = source.addComment(threadId, { author: bob, body: 'r1' });
		source.editComment(commentId, 'q (edited)');
		source.resolveThread(threadId, bob);
		source.addComment(threadId, { author: alice, body: 'r2' });
		source.deleteComment(r1);
		source.reopenThread(threadId);

		const log = source.snapshot();

		const a = new CommentStore({ actor: 'x' });
		const b = new CommentStore({ actor: 'y' });
		// b receives a shuffled stream with every event duplicated once.
		a.ingest(log);
		b.ingest(shuffle([...log, ...log], 7));

		expect(b.threads()).toEqual(a.threads());
		expect(b.threads()).toEqual(source.threads());
		// final state sanity: thread reopened, edit applied, r1 deleted
		const t = b.getThread(threadId)!;
		expect(t.resolved).toBe(false);
		expect(t.comments.map((c) => c.body)).toEqual(['q (edited)', 'r2']);
	});

	it('concurrent edits resolve deterministically by (clock, actor)', () => {
		const base = new CommentStore({ actor: 'seed' });
		const { commentId } = base.createThread({ author: alice, body: 'orig' });
		const seed = base.snapshot();

		// Two peers diverge from the same seed and each edit the same comment.
		const p1 = new CommentStore({ actor: 'aaa' });
		const p2 = new CommentStore({ actor: 'zzz' });
		p1.ingest(seed);
		p2.ingest(seed);
		p1.editComment(commentId, 'from-aaa');
		p2.editComment(commentId, 'from-zzz');

		// Exchange.
		const merged1 = new CommentStore({ actor: 'm1' });
		const merged2 = new CommentStore({ actor: 'm2' });
		merged1.ingest([...p1.snapshot(), ...p2.snapshot()]);
		merged2.ingest([...p2.snapshot(), ...p1.snapshot()]);
		expect(merged1.threads()).toEqual(merged2.threads());
	});
});

describe('CommentSync — over a transport pair', () => {
	it('replicates a thread + reply across a loopback pair', () => {
		const [tA, tB] = createMemoryTransportPair<CommentMessage>();
		const a = new CommentStore({ actor: 'alice' });
		const b = new CommentStore({ actor: 'bob' });
		const syncA = new CommentSync(a, tA);
		const syncB = new CommentSync(b, tB);

		const { threadId } = a.createThread({ author: alice, body: 'hello' });
		b.addComment(threadId, { author: bob, body: 'hi back' });

		expect(b.getThread(threadId)!.comments.map((c) => c.body)).toEqual(['hello', 'hi back']);
		expect(a.getThread(threadId)!.comments.map((c) => c.body)).toEqual(['hello', 'hi back']);

		syncA.close();
		syncB.close();
	});

	it('late joiner catches up via snapshot exchange on hello', () => {
		const [tA, tB] = createMemoryTransportPair<CommentMessage>();
		const a = new CommentStore({ actor: 'alice' });
		new CommentSync(a, tA);
		// A has history before B joins.
		a.createThread({ author: alice, body: 'old thread' });

		const b = new CommentStore({ actor: 'bob' });
		new CommentSync(b, tB); // sends hello -> A replies with snapshot
		expect(b.threads().map((t) => t.comments[0]!.body)).toEqual(['old thread']);
	});

	it('stops relaying after close', () => {
		const [tA, tB] = createMemoryTransportPair<CommentMessage>();
		const a = new CommentStore({ actor: 'alice' });
		const b = new CommentStore({ actor: 'bob' });
		const syncA = new CommentSync(a, tA);
		new CommentSync(b, tB);
		syncA.close();
		a.createThread({ author: alice, body: 'after close' });
		expect(b.threads()).toHaveLength(0);
	});
});

// ---- document helpers -------------------------------------------------------

function makeState(text: string): EditorState {
	return {
		doc: { type: 'doc', children: [{ id: newId(), type: 'paragraph', text: text ? [{ text }] : [] }] },
		selection: { anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } },
	};
}

function caret(path: number[], offset: number): EditorState['selection'] {
	return { anchor: { path, offset }, head: { path, offset } };
}

function range(path: number[], from: number, to: number): EditorState['selection'] {
	return { anchor: { path, offset: from }, head: { path, offset: to } };
}

describe('comment doc helpers', () => {
	it('addCommentMark stamps a mark that findCommentRanges recovers', () => {
		const state = makeState('Hello brave world');
		const tx = new Transaction(state);
		addCommentMark(tx, { path: [0], from: 6, to: 11 }, 'thr1');
		const next = applyTransaction(state, tx);

		expect(findCommentRanges(next.doc)).toEqual([
			{ threadId: 'thr1', path: [0], from: 6, to: 11 },
		]);
		expect(allCommentThreadIds(next.doc)).toEqual(['thr1']);
		expect(commentMarkRanges(next.doc, 'thr1')).toEqual([{ path: [0], from: 6, to: 11 }]);
	});

	it('commentThreadIdsInSelection finds overlapping and under-caret threads', () => {
		const state = makeState('Hello brave world');
		const tx = new Transaction(state);
		addCommentMark(tx, { path: [0], from: 6, to: 11 }, 'thr1');
		const doc: DocumentNode = applyTransaction(state, tx).doc;

		// caret inside "brave"
		expect(commentThreadIdsInSelection(doc, caret([0], 8))).toEqual(['thr1']);
		// caret outside
		expect(commentThreadIdsInSelection(doc, caret([0], 2))).toEqual([]);
		// range overlapping the tail of "brave"
		expect(commentThreadIdsInSelection(doc, range([0], 9, 14))).toEqual(['thr1']);
		// range entirely after
		expect(commentThreadIdsInSelection(doc, range([0], 12, 17))).toEqual([]);
	});

	it('removeCommentMark removes only the targeted thread, leaving neighbors', () => {
		const state = makeState('one two three');
		const tx = new Transaction(state);
		addCommentMark(tx, { path: [0], from: 0, to: 3 }, 'A'); // "one"
		addCommentMark(tx, { path: [0], from: 8, to: 13 }, 'B'); // "three"
		const doc = applyTransaction(state, tx).doc;
		expect(allCommentThreadIds(doc).sort()).toEqual(['A', 'B']);

		const tx2 = new Transaction({ doc, selection: caret([0], 0) });
		removeCommentMark(tx2, doc, 'A');
		const doc2 = applyTransaction({ doc, selection: caret([0], 0) }, tx2).doc;
		expect(allCommentThreadIds(doc2)).toEqual(['B']);
		expect(commentMarkRanges(doc2, 'B')).toEqual([{ path: [0], from: 8, to: 13 }]);
	});
});
