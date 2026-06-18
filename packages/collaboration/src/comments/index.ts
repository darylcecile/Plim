// @plim/collaboration/comments — Notion-style comments & threaded replies.
//
// Out of the box: register `commentMark`, drop in the default `comments.css`,
// create a `CommentStore`, and (optionally) a `CommentSync` over any
// `@plim/transports` channel. Easy to extend: the store is a plain observable,
// the doc helpers are pure, and the toolbar button is decoupled via a DOM event
// (`COMMENT_COMPOSE_EVENT`) so you can build any UI on top.

export type {
	CommentAuthor,
	Comment,
	CommentThread,
	CommentEvent,
	CommentEventBase,
	CommentEventKind,
	CommentMessage,
} from './types.js';

export {
	CommentStore,
	type CommentStoreOptions,
	type CreateThreadInput,
	type AddCommentInput,
} from './store.js';

export {
	COMMENT_MARK_NAME,
	COMMENT_THREAD_ATTR,
	type DocRange,
	findCommentRanges,
	commentMarkRanges,
	allCommentThreadIds,
	commentThreadIdsInSelection,
	addCommentMark,
	removeCommentMark,
} from './doc.js';

export {
	commentMark,
	COMMENT_COMPOSE_EVENT,
	type CommentComposeDetail,
} from './mark.js';

export { CommentSync, createCommentSync } from './sync.js';
