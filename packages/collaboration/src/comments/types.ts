// Public data shapes for the comments feature.
//
// A *comment* is an in-document mark (`commentMark`, carrying `attrs.threadId`)
// so the highlighted range rides the editor's OT/collab rebasing for free. The
// *thread content* below (text, replies, author, resolved state) lives OUTSIDE
// the doc ledger in a `CommentStore`, synced over its own `Transport`. These
// types describe that out-of-band content and the events that mutate it.

/** Who authored a comment. Only `id` is required; the rest is display sugar. */
export type CommentAuthor = {
	id: string;
	name?: string;
	/** CSS color used for the author's accent (avatar ring, name). */
	color?: string;
	avatarUrl?: string;
};

/** A single comment — either the opening comment of a thread or a reply. */
export type Comment = {
	id: string;
	threadId: string;
	author: CommentAuthor;
	body: string;
	/** Wall-clock creation time (ms). For display/sort only — ordering across
	 * peers uses the event log's logical clock, not this. */
	createdAt: number;
	/** Wall-clock time of the last edit (ms); equals `createdAt` if never edited. */
	updatedAt: number;
	/** True once the comment's last edit was an edit (vs. its original post). */
	edited: boolean;
};

/** A comment thread anchored to a range of the document via `id` (= threadId). */
export type CommentThread = {
	id: string;
	author: CommentAuthor;
	createdAt: number;
	resolved: boolean;
	resolvedAt?: number;
	resolvedBy?: CommentAuthor;
	/** Non-deleted comments, oldest first. Index 0 is the opening comment. */
	comments: Comment[];
};

// ---- event log --------------------------------------------------------------
//
// The store is event-sourced: every mutation appends an immutable event to a
// grow-only set. Materialized threads are a deterministic fold over that set,
// so any two peers that have seen the same events converge regardless of the
// order or duplication with which the events arrived (best-effort transports).

/** Fields shared by every event. `clock`+`actor` give a total order for LWW. */
export type CommentEventBase = {
	/** Globally-unique event id (dedupe key). */
	id: string;
	/** Lamport clock — monotonic per actor, advanced on receive. */
	clock: number;
	/** Stable id of the peer that authored the event (LWW tie-break). */
	actor: string;
	/** Wall-clock time the event was created (ms) — for display only. */
	at: number;
};

export type CommentEvent =
	| (CommentEventBase & { kind: 'thread.create'; threadId: string; author: CommentAuthor })
	| (CommentEventBase & {
			kind: 'comment.add';
			threadId: string;
			commentId: string;
			author: CommentAuthor;
			body: string;
	  })
	| (CommentEventBase & { kind: 'comment.edit'; commentId: string; body: string })
	| (CommentEventBase & { kind: 'comment.delete'; commentId: string })
	| (CommentEventBase & { kind: 'thread.resolve'; threadId: string; by?: CommentAuthor })
	| (CommentEventBase & { kind: 'thread.reopen'; threadId: string; by?: CommentAuthor })
	| (CommentEventBase & { kind: 'thread.delete'; threadId: string });

export type CommentEventKind = CommentEvent['kind'];

// ---- sync protocol ----------------------------------------------------------

/** Messages exchanged by `CommentSync` over a `Transport<CommentMessage>`. */
export type CommentMessage =
	/** "I just joined" — prompts peers to reply with a `snapshot`. */
	| { type: 'hello'; actor: string }
	/** Full event log, sent in response to `hello` (late-join catch-up). */
	| { type: 'snapshot'; events: CommentEvent[] }
	/** Incremental fan-out of newly authored events. */
	| { type: 'events'; events: CommentEvent[] };
