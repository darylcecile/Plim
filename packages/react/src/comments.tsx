import * as React from 'react';
import type { CommentAuthor, CommentStore, CommentThread, Comment } from '@plim/collaboration';
import {
	COMMENT_COMPOSE_EVENT,
	type CommentComposeDetail,
	addCommentMark,
	removeCommentMark,
} from '@plim/collaboration';
import type { EditorHandle } from './index.js';
import { ActionPanel } from './index.js';

// ──────────────────────────────────────────────────────────────────────────────
// @plim/react comments — drop-in UI for the @plim/collaboration comments core.
//
// `<CommentsLayer>` is the one component you mount alongside `<PlimEditor>`. It:
//   - opens a composer when the toolbar "Comment" button fires
//     (`COMMENT_COMPOSE_EVENT`), and on submit creates the thread in the store
//     and stamps the `commentMark` over the selection;
//   - opens a thread popover when a highlighted span is clicked;
//   - keeps each highlight's `data-comment-resolved` / `data-comment-active`
//     attributes in sync with the store after every render (the marks live in
//     the doc; resolved/active state lives in the store).
//
// Everything below the layer (`CommentThreadCard`, `CommentCard`,
// `CommentComposer`) is exported too so you can compose your own UI. Styling is
// class-based; import `@plim/collaboration/comments.css` for the defaults.
// ──────────────────────────────────────────────────────────────────────────────

/** Subscribe to a store and get its current threads, re-rendering on change. */
export function useComments(store: CommentStore): { threads: CommentThread[] } {
	const subscribe = React.useCallback((cb: () => void) => store.subscribe(cb), [store]);
	const threads = React.useSyncExternalStore(
		subscribe,
		() => store.threads(),
		() => store.threads(),
	);
	return { threads };
}

/** Bounding rect of the current (non-collapsed) DOM selection, in viewport coords. */
export function currentSelectionRect(): DOMRect | null {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	const rect = range.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) {
		const rects = range.getClientRects();
		if (rects.length > 0) return rects[0]!;
		return null;
	}
	return rect;
}

function initials(author: CommentAuthor): string {
	const src = author.name?.trim() || author.id;
	const parts = src.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return '?';
	if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
	return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Compact relative-time formatter used as the default `formatTime`. */
export function formatRelativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 45_000) return 'just now';
	const mins = Math.round(diff / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(diff / 3_600_000);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(diff / 86_400_000);
	if (days < 7) return `${days}d`;
	return new Date(ms).toLocaleDateString();
}

// ──────────────────────────────────────────────────────────────────────────────
// Composer
// ──────────────────────────────────────────────────────────────────────────────

export type CommentComposerProps = {
	onSubmit: (body: string) => void;
	onCancel?: () => void;
	placeholder?: string;
	submitLabel?: string;
	autoFocus?: boolean;
	initialValue?: string;
};

export function CommentComposer(props: CommentComposerProps): React.ReactElement {
	const { onSubmit, onCancel, placeholder = 'Add a comment…', submitLabel = 'Comment', autoFocus = true } = props;
	const [value, setValue] = React.useState(props.initialValue ?? '');
	const ref = React.useRef<HTMLTextAreaElement | null>(null);

	React.useEffect(() => {
		if (autoFocus) ref.current?.focus();
	}, [autoFocus]);

	const submit = () => {
		const body = value.trim();
		if (!body) return;
		onSubmit(body);
		setValue('');
	};

	return (
		<div className="plim-comment-composer">
			<textarea
				ref={ref}
				className="plim-comment-composer__input"
				value={value}
				placeholder={placeholder}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						submit();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						onCancel?.();
					}
					e.stopPropagation();
				}}
			/>
			<div className="plim-comment-composer__actions">
				{onCancel ? (
					<button type="button" className="plim-comment-btn plim-comment-btn--ghost" onClick={onCancel}>
						Cancel
					</button>
				) : null}
				<button
					type="button"
					className="plim-comment-btn plim-comment-btn--primary"
					onClick={submit}
					disabled={value.trim().length === 0}
				>
					{submitLabel}
				</button>
			</div>
		</div>
	);
}

// ──────────────────────────────────────────────────────────────────────────────
// Single comment card
// ──────────────────────────────────────────────────────────────────────────────

export type CommentCardProps = {
	comment: Comment;
	currentUser: CommentAuthor;
	onEdit?: (body: string) => void;
	onDelete?: () => void;
	formatTime?: (ms: number) => string;
};

export function CommentCard(props: CommentCardProps): React.ReactElement {
	const { comment, currentUser, onEdit, onDelete, formatTime = formatRelativeTime } = props;
	const [editing, setEditing] = React.useState(false);
	const mine = comment.author.id === currentUser.id;
	const avatarStyle = comment.author.color ? { background: comment.author.color } : undefined;

	return (
		<div className="plim-comment-card">
			<div className="plim-comment-card__head">
				{comment.author.avatarUrl ? (
					<img className="plim-comment-card__avatar" src={comment.author.avatarUrl} alt="" style={avatarStyle} />
				) : (
					<span className="plim-comment-card__avatar" style={avatarStyle} aria-hidden="true">
						{initials(comment.author)}
					</span>
				)}
				<span className="plim-comment-card__author">{comment.author.name ?? comment.author.id}</span>
				<span className="plim-comment-card__time">{formatTime(comment.createdAt)}</span>
				{comment.edited ? <span className="plim-comment-card__edited">· edited</span> : null}
			</div>
			{editing ? (
				<CommentComposer
					initialValue={comment.body}
					submitLabel="Save"
					onSubmit={(body) => {
						onEdit?.(body);
						setEditing(false);
					}}
					onCancel={() => setEditing(false)}
				/>
			) : (
				<p className="plim-comment-card__body">{comment.body}</p>
			)}
			{mine && !editing && (onEdit || onDelete) ? (
				<div className="plim-comment-card__actions">
					{onEdit ? (
						<button type="button" className="plim-comment-btn" onClick={() => setEditing(true)}>
							Edit
						</button>
					) : null}
					{onDelete ? (
						<button type="button" className="plim-comment-btn" onClick={onDelete}>
							Delete
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

// ──────────────────────────────────────────────────────────────────────────────
// Thread card (header + comments + reply composer)
// ──────────────────────────────────────────────────────────────────────────────

export type CommentThreadCardProps = {
	thread: CommentThread;
	currentUser: CommentAuthor;
	onReply: (body: string) => void;
	onEditComment: (commentId: string, body: string) => void;
	onDeleteComment: (commentId: string) => void;
	onResolve: () => void;
	onReopen: () => void;
	onClose?: () => void;
	formatTime?: (ms: number) => string;
};

export function CommentThreadCard(props: CommentThreadCardProps): React.ReactElement {
	const { thread, currentUser, onReply, onEditComment, onDeleteComment, onResolve, onReopen, onClose, formatTime } =
		props;
	return (
		<div className={`plim-comment-thread${thread.resolved ? ' plim-comment-thread--resolved' : ''}`}>
			<div className="plim-comment-thread__header">
				<span className="plim-comment-thread__title">Comments</span>
				<span style={{ display: 'flex', gap: 8 }}>
					<button
						type="button"
						className="plim-comment-btn plim-comment-btn--ghost"
						onClick={thread.resolved ? onReopen : onResolve}
					>
						{thread.resolved ? 'Reopen' : 'Resolve'}
					</button>
					{onClose ? (
						<button type="button" className="plim-comment-btn plim-comment-btn--ghost" onClick={onClose}>
							Close
						</button>
					) : null}
				</span>
			</div>
			<div className="plim-comment-thread__scroll">
				{thread.comments.map((c) => (
					<CommentCard
						key={c.id}
						comment={c}
						currentUser={currentUser}
						onEdit={(body) => onEditComment(c.id, body)}
						onDelete={() => onDeleteComment(c.id)}
						{...(formatTime ? { formatTime } : {})}
					/>
				))}
			</div>
			<CommentComposer placeholder="Reply…" submitLabel="Reply" autoFocus={false} onSubmit={onReply} />
		</div>
	);
}

// ──────────────────────────────────────────────────────────────────────────────
// The orchestrator
// ──────────────────────────────────────────────────────────────────────────────

export type CommentsLayerProps = {
	/** The same handle you pass to `<PlimEditor>`. */
	editor: EditorHandle;
	/** The shared comment store. */
	store: CommentStore;
	/** Who authors new comments and replies. */
	currentUser: CommentAuthor;
	/** Optional element used to clamp popovers (typically the editor container). */
	boundary?: Element | null;
	/** Override the timestamp formatter. */
	formatTime?: (ms: number) => string;
};

type ComposeState = { selection: CommentComposeDetail['selection']; rect: DOMRect };

export function CommentsLayer(props: CommentsLayerProps): React.ReactElement | null {
	const { editor, store, currentUser, boundary = null, formatTime } = props;
	const { threads } = useComments(store);

	const [compose, setCompose] = React.useState<ComposeState | null>(null);
	const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null);
	const activeElRef = React.useRef<HTMLElement | null>(null);

	// Keep a live ref to the active thread so closures stay current.
	const activeThread = activeThreadId ? threads.find((t) => t.id === activeThreadId) ?? null : null;

	// --- attach editor-side listeners --------------------------------------
	// Both listeners live on `document` and read the editor lazily, so they
	// work no matter when the agnostic editor / its view become ready (no
	// polling race) and survive the editor re-rendering its view in place.
	React.useEffect(() => {
		const onCompose = (e: Event) => {
			const detail = (e as CustomEvent<CommentComposeDetail>).detail;
			const rect = currentSelectionRect();
			if (!rect) return;
			// Selection already commented? Open the (first) existing thread.
			if (detail.threadIds.length > 0) {
				const id = detail.threadIds[0]!;
				const el = findCommentElement(editor, id);
				activeElRef.current = el;
				setActiveThreadId(id);
				setCompose(null);
				return;
			}
			setActiveThreadId(null);
			setCompose({ selection: detail.selection, rect });
		};

		const onClick = (ev: MouseEvent) => {
			const target = ev.target;
			if (!(target instanceof Element)) return;
			const span = target.closest<HTMLElement>('.plim-comment[data-comment-thread]');
			if (!span) return;
			// Ignore highlights that belong to a different editor on the page.
			const root = editor.getEditor()?.view?.root;
			if (root && !root.contains(span)) return;
			const id = span.getAttribute('data-comment-thread');
			if (!id) return;
			activeElRef.current = span;
			setCompose(null);
			setActiveThreadId(id);
		};

		document.addEventListener(COMMENT_COMPOSE_EVENT, onCompose as EventListener);
		document.addEventListener('click', onClick);
		return () => {
			document.removeEventListener(COMMENT_COMPOSE_EVENT, onCompose as EventListener);
			document.removeEventListener('click', onClick);
		};
	}, [editor]);

	// --- keep highlight attributes in sync with the store --------------------
	const resolvedIds = React.useMemo(
		() => new Set(threads.filter((t) => t.resolved).map((t) => t.id)),
		[threads],
	);
	const knownIds = React.useMemo(() => new Set(threads.map((t) => t.id)), [threads]);

	const syncHighlights = React.useCallback(() => {
		const root = editor.getEditor()?.view?.root;
		if (!root) return;
		const spans = root.querySelectorAll<HTMLElement>('.plim-comment[data-comment-thread]');
		for (const span of spans) {
			const id = span.getAttribute('data-comment-thread');
			if (!id) continue;
			if (resolvedIds.has(id)) span.setAttribute('data-comment-resolved', 'true');
			else span.removeAttribute('data-comment-resolved');
			if (id === activeThreadId) span.setAttribute('data-comment-active', 'true');
			else span.removeAttribute('data-comment-active');
		}
		// An active thread whose highlight no longer exists (text deleted, or the
		// thread was never in this doc) should drop its popover.
		if (activeThreadId && !root.querySelector(`.plim-comment[data-comment-thread="${cssEscape(activeThreadId)}"]`)) {
			// keep the popover only if the thread still exists in the store
			if (!knownIds.has(activeThreadId)) setActiveThreadId(null);
		}
	}, [editor, resolvedIds, activeThreadId, knownIds]);

	// Re-sync after store/selection changes and after each editor transaction
	// (the view re-renders spans and drops our attributes).
	React.useEffect(() => {
		syncHighlights();
		let off: (() => void) | null = null;
		const e = editor.getEditor();
		if (e) {
			off = e.onTransaction(() => queueMicrotask(syncHighlights));
		}
		return () => off?.();
	}, [editor, syncHighlights]);

	// --- actions -------------------------------------------------------------
	const submitNewComment = (body: string) => {
		if (!compose) return;
		const e = editor.getEditor();
		if (!e) return;
		const { threadId } = store.createThread({ author: currentUser, body });
		const tx = e.createTransaction();
		addCommentMark(tx, { from: compose.selection.anchor, to: compose.selection.head }, threadId);
		tx.commit();
		setCompose(null);
		queueMicrotask(() => {
			activeElRef.current = findCommentElement(editor, threadId);
			setActiveThreadId(threadId);
		});
	};

	const removeThreadEverywhere = (threadId: string) => {
		const e = editor.getEditor();
		if (e) {
			const tx = e.createTransaction();
			removeCommentMark(tx, e.getState().doc, threadId);
			tx.commit();
		}
		store.deleteThread(threadId);
		setActiveThreadId(null);
	};

	// --- render --------------------------------------------------------------
	return (
		<>
			{compose ? (
				<ActionPanel
					open
					className="plim-comments-popover"
					anchor={compose.rect}
					placement="bottom-start"
					boundary={boundary}
					onClose={() => setCompose(null)}
					dismissOnOutsideClick
				>
					<CommentComposer onSubmit={submitNewComment} onCancel={() => setCompose(null)} />
				</ActionPanel>
			) : null}

			{activeThread ? (
				<ActionPanel
					open
					className="plim-comments-popover"
					anchor={() => activeElRef.current ?? null}
					placement="bottom-start"
					boundary={boundary}
					onClose={() => setActiveThreadId(null)}
					dismissOnOutsideClick
				>
					<CommentThreadCard
						thread={activeThread}
						currentUser={currentUser}
						onReply={(body) => store.addComment(activeThread.id, { author: currentUser, body })}
						onEditComment={(commentId, body) => store.editComment(commentId, body)}
						onDeleteComment={(commentId) => {
							// Deleting the last visible comment removes the whole thread + mark.
							if (activeThread.comments.length <= 1) removeThreadEverywhere(activeThread.id);
							else store.deleteComment(commentId);
						}}
						onResolve={() => store.resolveThread(activeThread.id, currentUser)}
						onReopen={() => store.reopenThread(activeThread.id)}
						onClose={() => setActiveThreadId(null)}
						{...(formatTime ? { formatTime } : {})}
					/>
				</ActionPanel>
			) : null}
		</>
	);
}

function findCommentElement(editor: EditorHandle, threadId: string): HTMLElement | null {
	const root = editor.getEditor()?.view?.root;
	if (!root) return null;
	return root.querySelector<HTMLElement>(`.plim-comment[data-comment-thread="${cssEscape(threadId)}"]`);
}

function cssEscape(value: string): string {
	const fn = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
	if (fn) return fn(value);
	return value.replace(/["\\]/g, '\\$&');
}
