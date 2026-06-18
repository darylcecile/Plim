// CommentStore — an event-sourced, convergent store of comment threads.
//
// Design: every mutation appends an immutable event to a grow-only `Map` keyed
// by event id (so duplicate delivery is idempotent). The materialized list of
// threads is a pure fold over those events in a deterministic order
// (`clock`, then `actor`, then `id`). Two peers that have observed the same set
// of events therefore compute byte-identical state no matter the arrival order
// — a small CRDT built from a grow-only set + last-writer-wins registers. There
// is no central authority; `CommentSync` just gossips events between stores.
//
// Conflict resolution, per field:
//   - comment body      → LWW register (latest add/edit by clock wins)
//   - thread.resolved   → LWW register (latest resolve/reopen by clock wins)
//   - comment/thread deletion → monotonic tombstone (delete always wins, and is
//     irreversible — you don't "un-delete" a comment by editing it)

import { newId } from '@plim/core';

import type {
	Comment,
	CommentAuthor,
	CommentEvent,
	CommentThread,
} from './types.js';

export type CommentStoreOptions = {
	/** Stable id for this peer; used as the LWW tie-break actor. Auto-generated
	 * if omitted. Keep it stable for the lifetime of a session. */
	actor?: string;
};

/** Inputs to open a new thread (and its first comment) in one shot. */
export type CreateThreadInput = {
	/** Pre-chosen thread id — pass this to keep the doc mark and the store in
	 * lock-step (apply `addCommentMark(tx, range, threadId)` with the same id).
	 * Auto-generated if omitted. */
	id?: string;
	author: CommentAuthor;
	body: string;
};

export type AddCommentInput = {
	id?: string;
	author: CommentAuthor;
	body: string;
};

type Unsubscribe = () => void;

// `clock` then `actor` then `id` is a total order over all events, giving
// deterministic LWW everywhere. Returns true if `a` is "newer" than `b`.
function isNewer(
	a: { clock: number; actor: string; id: string },
	b: { clock: number; actor: string; id: string },
): boolean {
	if (a.clock !== b.clock) return a.clock > b.clock;
	if (a.actor !== b.actor) return a.actor > b.actor;
	return a.id > b.id;
}

export class CommentStore {
	readonly actor: string;
	private clock = 0;
	private readonly events = new Map<string, CommentEvent>();

	// Materialized state is cached and recomputed lazily on read after any
	// change (mutations/ingest just flip `dirty`).
	private cache: CommentThread[] | null = null;

	private readonly listeners = new Set<() => void>();
	private readonly localListeners = new Set<(events: CommentEvent[]) => void>();

	constructor(options: CommentStoreOptions = {}) {
		this.actor = options.actor ?? newId('actor');
	}

	// ---- queries ------------------------------------------------------------

	/** All non-deleted threads, newest first. */
	threads(): CommentThread[] {
		if (!this.cache) this.cache = this.materialize();
		return this.cache;
	}

	getThread(threadId: string): CommentThread | undefined {
		return this.threads().find((t) => t.id === threadId);
	}

	/** Thread ids that currently have at least one visible (non-deleted) comment. */
	openThreadIds(): Set<string> {
		return new Set(this.threads().filter((t) => !t.resolved).map((t) => t.id));
	}

	// ---- local mutations ----------------------------------------------------

	/** Open a new thread with its first comment. Returns the ids so the caller
	 * can stamp the matching `commentMark` onto the document range. */
	createThread(input: CreateThreadInput): { threadId: string; commentId: string } {
		const threadId = input.id ?? newId('thr');
		const commentId = newId('cmt');
		this.commitLocal([
			this.make({ kind: 'thread.create', threadId, author: input.author }),
			this.make({
				kind: 'comment.add',
				threadId,
				commentId,
				author: input.author,
				body: input.body,
			}),
		]);
		return { threadId, commentId };
	}

	/** Append a reply to an existing thread. Returns the new comment id. */
	addComment(threadId: string, input: AddCommentInput): string {
		const commentId = input.id ?? newId('cmt');
		this.commitLocal([
			this.make({
				kind: 'comment.add',
				threadId,
				commentId,
				author: input.author,
				body: input.body,
			}),
		]);
		return commentId;
	}

	editComment(commentId: string, body: string): void {
		this.commitLocal([this.make({ kind: 'comment.edit', commentId, body })]);
	}

	deleteComment(commentId: string): void {
		this.commitLocal([this.make({ kind: 'comment.delete', commentId })]);
	}

	resolveThread(threadId: string, by?: CommentAuthor): void {
		this.commitLocal([this.make(by ? { kind: 'thread.resolve', threadId, by } : { kind: 'thread.resolve', threadId })]);
	}

	reopenThread(threadId: string, by?: CommentAuthor): void {
		this.commitLocal([this.make(by ? { kind: 'thread.reopen', threadId, by } : { kind: 'thread.reopen', threadId })]);
	}

	deleteThread(threadId: string): void {
		this.commitLocal([this.make({ kind: 'thread.delete', threadId })]);
	}

	// ---- sync surface -------------------------------------------------------

	/** The full event log — send to a freshly-joined peer. */
	snapshot(): CommentEvent[] {
		return [...this.events.values()];
	}

	/** Merge remote events. Idempotent (dedupes by event id) and echo-free
	 * (does NOT notify `onLocalEvents`). Notifies UI subscribers if anything
	 * actually changed. */
	ingest(events: readonly CommentEvent[]): void {
		let changed = false;
		for (const ev of events) {
			if (this.events.has(ev.id)) continue;
			this.events.set(ev.id, ev);
			// Advance our clock past anything we've seen (Lamport receive rule).
			if (ev.clock > this.clock) this.clock = ev.clock;
			changed = true;
		}
		if (changed) this.invalidate();
	}

	/** Subscribe to materialized-state changes (for UI re-render). */
	subscribe(listener: () => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Subscribe to *locally authored* events only (for fan-out by `CommentSync`).
	 * Remote events ingested via `ingest` do NOT fire this — prevents echo loops. */
	onLocalEvents(listener: (events: CommentEvent[]) => void): Unsubscribe {
		this.localListeners.add(listener);
		return () => this.localListeners.delete(listener);
	}

	// ---- internals ----------------------------------------------------------

	private make<E extends Omit<CommentEvent, 'id' | 'clock' | 'actor' | 'at'>>(
		body: E,
	): CommentEvent {
		this.clock += 1;
		return {
			...(body as object),
			id: newId('evt'),
			clock: this.clock,
			actor: this.actor,
			at: Date.now(),
		} as CommentEvent;
	}

	private commitLocal(events: CommentEvent[]): void {
		for (const ev of events) this.events.set(ev.id, ev);
		this.invalidate();
		if (this.localListeners.size) {
			for (const l of this.localListeners) l(events);
		}
	}

	private invalidate(): void {
		this.cache = null;
		for (const l of this.listeners) l();
	}

	// Fold the grow-only event set into threads in deterministic order.
	private materialize(): CommentThread[] {
		const ordered = [...this.events.values()].sort((a, b) => (isNewer(a, b) ? 1 : -1));

		type ThreadAcc = {
			id: string;
			author: CommentAuthor;
			createdAt: number;
			deleted: boolean;
			resolved: boolean;
			resolvedAt?: number;
			resolvedBy?: CommentAuthor;
			resolvedClock?: { clock: number; actor: string; id: string };
			order: number; // insertion order for stable "newest first"
		};
		type CommentAcc = {
			id: string;
			threadId: string;
			author: CommentAuthor;
			createdAt: number;
			updatedAt: number;
			body: string;
			edited: boolean;
			deleted: boolean;
			bodyClock: { clock: number; actor: string; id: string };
			addStamp: { clock: number; actor: string; id: string };
		};

		const threads = new Map<string, ThreadAcc>();
		const comments = new Map<string, CommentAcc>();
		let seq = 0;

		for (const ev of ordered) {
			switch (ev.kind) {
				case 'thread.create': {
					if (!threads.has(ev.threadId)) {
						threads.set(ev.threadId, {
							id: ev.threadId,
							author: ev.author,
							createdAt: ev.at,
							deleted: false,
							resolved: false,
							order: seq++,
						});
					}
					break;
				}
				case 'comment.add': {
					// Tolerate a missing thread.create (out-of-order/lost) by
					// synthesizing the thread from the first comment we see.
					if (!threads.has(ev.threadId)) {
						threads.set(ev.threadId, {
							id: ev.threadId,
							author: ev.author,
							createdAt: ev.at,
							deleted: false,
							resolved: false,
							order: seq++,
						});
					}
					if (!comments.has(ev.commentId)) {
						comments.set(ev.commentId, {
							id: ev.commentId,
							threadId: ev.threadId,
							author: ev.author,
							createdAt: ev.at,
							updatedAt: ev.at,
							body: ev.body,
							edited: false,
							deleted: false,
							bodyClock: { clock: ev.clock, actor: ev.actor, id: ev.id },
							addStamp: { clock: ev.clock, actor: ev.actor, id: ev.id },
						});
					}
					break;
				}
				case 'comment.edit': {
					const c = comments.get(ev.commentId);
					if (c && isNewer(ev, c.bodyClock)) {
						c.body = ev.body;
						c.updatedAt = ev.at;
						c.edited = true;
						c.bodyClock = { clock: ev.clock, actor: ev.actor, id: ev.id };
					}
					break;
				}
				case 'comment.delete': {
					const c = comments.get(ev.commentId);
					if (c) c.deleted = true; // monotonic tombstone
					break;
				}
				case 'thread.resolve':
				case 'thread.reopen': {
					const t = threads.get(ev.threadId);
					if (!t) break;
					const stamp = { clock: ev.clock, actor: ev.actor, id: ev.id };
					if (!t.resolvedClock || isNewer(stamp, t.resolvedClock)) {
						t.resolvedClock = stamp;
						t.resolved = ev.kind === 'thread.resolve';
						if (t.resolved) {
							t.resolvedAt = ev.at;
							if (ev.by) t.resolvedBy = ev.by;
						} else {
							delete t.resolvedAt;
							delete t.resolvedBy;
						}
					}
					break;
				}
				case 'thread.delete': {
					const t = threads.get(ev.threadId);
					if (t) t.deleted = true; // monotonic tombstone
					break;
				}
			}
		}

		const byThread = new Map<string, CommentAcc[]>();
		for (const c of comments.values()) {
			if (c.deleted) continue;
			const list = byThread.get(c.threadId) ?? [];
			list.push(c);
			byThread.set(c.threadId, list);
		}

		const out: CommentThread[] = [];
		for (const t of threads.values()) {
			if (t.deleted) continue;
			const accs = (byThread.get(t.id) ?? []).sort((a, b) => (isNewer(a.addStamp, b.addStamp) ? 1 : -1));
			const list: Comment[] = accs.map((c) => ({
				id: c.id,
				threadId: c.threadId,
				author: c.author,
				body: c.body,
				createdAt: c.createdAt,
				updatedAt: c.updatedAt,
				edited: c.edited,
			}));
			const thread: CommentThread = {
				id: t.id,
				author: t.author,
				createdAt: t.createdAt,
				resolved: t.resolved,
				comments: list,
			};
			if (t.resolvedAt !== undefined) thread.resolvedAt = t.resolvedAt;
			if (t.resolvedBy !== undefined) thread.resolvedBy = t.resolvedBy;
			out.push(thread);
		}
		// Newest threads first (reverse insertion order).
		out.sort((a, b) => {
			const ta = threads.get(a.id)!;
			const tb = threads.get(b.id)!;
			return tb.order - ta.order;
		});
		return out;
	}
}
