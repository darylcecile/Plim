// `commentMark` — the in-document highlight that anchors a comment thread.
//
// It renders as `<span class="plim-comment" data-comment-thread="…">`, is NOT
// atomic (text inside stays normally editable), and contributes a "Comment"
// button to the floating selection toolbar. Because the React/UI layer and the
// vanilla toolbar must stay decoupled, the button does not open any UI itself —
// it dispatches a `plim:comment-compose` CustomEvent on `document` carrying the
// selection and any thread ids already under it. A `<CommentsLayer>` (or your
// own listener) reacts by opening a composer and, on submit, creating the
// thread in the store and stamping the mark via `addCommentMark`.

import type { Selection } from '@plim/core';
import { defineMark } from '@plim/core';

import { COMMENT_MARK_NAME, COMMENT_THREAD_ATTR, commentThreadIdsInSelection } from './doc.js';

/** DOM event dispatched on `document` when the toolbar "Comment" button fires. */
export const COMMENT_COMPOSE_EVENT = 'plim:comment-compose';

/** `detail` shape of the {@link COMMENT_COMPOSE_EVENT} CustomEvent. */
export type CommentComposeDetail = {
	/** The selection the comment should anchor to. */
	selection: Selection;
	/** Thread ids already present in that selection (may be empty). */
	threadIds: string[];
	/** The toolbar button element, for popover positioning. */
	anchor: HTMLElement;
};

const COMMENT_ICON =
	'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
	'<path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2.5V11.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" ' +
	'stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

export const commentMark = defineMark({
	name: COMMENT_MARK_NAME,
	toDOM: (p) => {
		const el = document.createElement('span');
		el.className = 'plim-comment';
		const threadId = p.attrs?.[COMMENT_THREAD_ATTR] as string | undefined;
		if (threadId) el.setAttribute('data-comment-thread', threadId);
		return el;
	},
	toolbar: {
		name: COMMENT_MARK_NAME,
		label: 'Comment',
		icon: COMMENT_ICON,
		group: 'mark',
		priority: 100,
		perform: ({ state, anchor }) => {
			const detail: CommentComposeDetail = {
				selection: state.selection,
				threadIds: commentThreadIdsInSelection(state.doc, state.selection),
				anchor,
			};
			document.dispatchEvent(new CustomEvent(COMMENT_COMPOSE_EVENT, { detail }));
		},
	},
});
