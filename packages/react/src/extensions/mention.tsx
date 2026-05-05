import * as React from 'react';
import { defineAction, defineExtension, mentionMark, triggers } from '@plim/core';
import type { BlockNode, TextSpan, ValidationContext } from '@plim/core';
import type { EditorHandle } from '../index.js';
import { ActionPanel } from '../index.js';
import { currentBlockAnchor, currentCaretRect } from './slash-command.js';

// ──────────────────────────────────────────────────────────────────────────────
// Mention extension
//
// Action listens for `@` and dispatches `showMentionSuggestions`. The React
// component renders a filterable user list and inserts the chosen user as a
// `mention` mark whose attrs carry the user's id and an optional href. The
// extension also registers an atomic-Backspace action: when the caret sits
// immediately after a mention-marked run, a single Backspace deletes the
// whole run rather than one character.
// ──────────────────────────────────────────────────────────────────────────────

export type MentionUser = {
	id: string;
	name: string;
	handle: string;
	/** Optional emoji or short string rendered as the avatar. */
	avatar?: string;
	/** Optional secondary descriptor shown on the right. */
	role?: string;
};

export const DEFAULT_MENTION_USERS: readonly MentionUser[] = [
	{ id: 'u1', name: 'Alice Anderson', handle: 'alice', avatar: '🦊', role: 'Engineering' },
	{ id: 'u2', name: 'Ben Becker', handle: 'ben', avatar: '🐻', role: 'Design' },
	{ id: 'u3', name: 'Carla Cruz', handle: 'carla', avatar: '🐱', role: 'Product' },
	{ id: 'u4', name: 'Diego Diaz', handle: 'diego', avatar: '🦅', role: 'Engineering' },
	{ id: 'u5', name: 'Elena Eriksen', handle: 'elena', avatar: '🐺', role: 'Marketing' },
	{ id: 'u6', name: 'Farah Fadel', handle: 'farah', avatar: '🐯', role: 'Operations' },
	{ id: 'u7', name: 'Gabriel Gomes', handle: 'gabriel', avatar: '🦁', role: 'Engineering' },
	{ id: 'u8', name: 'Hana Hashimoto', handle: 'hana', avatar: '🐰', role: 'Research' },
];

export type MentionExtensionOptions = {
	/** Trigger character. Default `'@'`. */
	character?: string;
	/** Event name. Default `'showMentionSuggestions'`. */
	eventName?: string;
	/** Higher number = wins ties with other actions on the same trigger. Default `1`. */
	priority?: number;
};

/**
 * Extension factory. Add to `PlimDriver`'s `extensions` array.
 *
 * ```ts
 * const plim = new PlimDriver({
 *   extensions: [mentionExtension()],
 *   // ...
 * });
 * ```
 */
export function mentionExtension(opts: MentionExtensionOptions = {}) {
	const character = opts.character ?? '@';
	const eventName = opts.eventName ?? 'showMentionSuggestions';
	const priority = opts.priority ?? 1;
	return defineExtension(() => ({
		name: 'mention',
		registeredMarks: [mentionMark],
		registeredActions: [
			defineAction('mention', {
				trigger: triggers.keyboard.character(character),
				triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
				cancellationTriggers: [triggers.keyboard.key('Escape'), triggers.keyboard.key(' ')],
				perform: async (_state, ctx) => {
					return ctx.triggerAsyncEvent(eventName);
				},
				priority,
			}),
			// Atomic Backspace — when the caret sits at the trailing edge of a
			// mention-marked run, delete the entire run with one keystroke. The
			// validation predicate ensures we only intercept Backspace in that
			// exact situation, so normal Backspace behavior is preserved
			// everywhere else (including inside the mention's own text, in
			// case a custom flow allowed editing it).
			defineAction('mention.deleteBackward', {
				trigger: triggers.keyboard.key('Backspace'),
				triggerValidationRules: ({ predicate, and }) =>
					and([
						'inTextBlock',
						predicate(precededByMention, 'precededByMention'),
					]),
				perform: (state, ctx) => {
					const sel = state.selection;
					const block = getBlockFromState(state, sel.head.path);
					if (!block || !block.text) return;
					const range = mentionRunEndingAt(block.text, sel.head.offset);
					if (!range) return;
					const tx = ctx.createTransaction();
					tx.replaceRange(sel.head.path, range.from, range.to, []);
					tx.commit();
				},
				priority: priority + 10,
			}),
		],
	}));
}

// Walk `block.text` left-to-right, accumulating character offsets, and
// return the [from, to] range of the contiguous mention-marked run that
// ends *exactly* at `offset`. Returns null if the character immediately
// before `offset` is not part of a mention (or if `offset` is 0).
//
// "Same mention" is determined by the mark's `attrs.id` — adjacent runs for
// different users are treated as separate atomic units, so backspacing
// between two pills only deletes the right-hand one.
function mentionRunEndingAt(spans: readonly TextSpan[], offset: number): { from: number; to: number } | null {
	if (offset <= 0) return null;
	let pos = 0;
	let runFrom: number | null = null;
	let runTo: number | null = null;
	let runId: string | undefined;
	for (const span of spans) {
		const start = pos;
		const end = pos + span.text.length;
		const mention = span.marks?.find((m) => m.type === 'mention');
		const id = mention ? ((mention.attrs?.id as string | undefined) ?? '') : undefined;
		if (mention) {
			if (runFrom === null || id !== runId) {
				runFrom = start;
				runId = id;
			}
			runTo = end;
		} else {
			runFrom = null;
			runTo = null;
			runId = undefined;
		}
		// We've covered the byte just before `offset` — decide based on the
		// state of the run at that point.
		if (offset <= end) {
			if (offset === end && runFrom !== null && runTo === offset) {
				return { from: runFrom, to: runTo };
			}
			return null;
		}
		pos = end;
	}
	// offset > total length: treat as caret at end of last span.
	if (runFrom !== null && runTo === pos && offset === pos) {
		return { from: runFrom, to: runTo };
	}
	return null;
}

function precededByMention(ctx: ValidationContext): boolean {
	const block = getBlockFromState(ctx.state, ctx.state.selection.head.path);
	if (!block || !block.text) return false;
	return mentionRunEndingAt(block.text, ctx.state.selection.head.offset) !== null;
}

function getBlockFromState(state: ValidationContext['state'], path: readonly number[]): BlockNode | null {
	let node: { children?: readonly BlockNode[] } = state.doc;
	for (const idx of path) {
		const children: readonly BlockNode[] | undefined = node.children;
		if (!children || idx < 0 || idx >= children.length) return null;
		node = children[idx]!;
	}
	return node as BlockNode;
}

// ──────────────────────────────────────────────────────────────────────────────
// React UI
// ──────────────────────────────────────────────────────────────────────────────

export type MentionMenuProps = {
	editor: EditorHandle;
	/**
	 * Static list of users to filter client-side. Mutually exclusive with
	 * `searchUsers`. If neither is provided, `DEFAULT_MENTION_USERS` is used.
	 */
	users?: readonly MentionUser[];
	/**
	 * Async user-search function. Called whenever the query changes (after
	 * `debounceMs`); the resolved array replaces the menu contents. Stale
	 * responses are discarded if a newer query has been submitted, and the
	 * `signal` is aborted to let consumers cancel in-flight requests.
	 */
	searchUsers?: (query: string, signal: AbortSignal) => Promise<readonly MentionUser[]>;
	/** Debounce window for `searchUsers` calls. Default `150` ms. */
	debounceMs?: number;
	eventName?: string;
	/** How to format the inserted mention's display text. Default `'@{name}'`. */
	formatLabel?: (user: MentionUser) => string;
	/** href used on the inserted link mark. Default `#user-{id}`. */
	mentionHref?: (user: MentionUser) => string;
};

type MentionState = {
	anchor: Element | null;
	caretRect: DOMRect | null;
	/**
	 * Offsets from the anchor block's top-left to the caret at the moment
	 * the menu opened. Stored once so we can synthesize a "caret-position"
	 * rect from the live `block.getBoundingClientRect()` on every
	 * reposition — the menu stays pinned to the `@` glyph even after the
	 * page scrolls or the block reflows.
	 */
	caretOffsetX: number;
	caretOffsetBottom: number;
	resolve: (user: MentionUser | null) => void;
};

export function MentionMenu(props: MentionMenuProps): React.ReactElement | null {
	const {
		editor,
		users,
		searchUsers,
		debounceMs = 150,
		eventName = 'showMentionSuggestions',
		formatLabel = (u) => `@${u.name}`,
		mentionHref = (u) => `#user-${u.id}`,
	} = props;
	const [state, setState] = React.useState<MentionState | null>(null);

	// Build a stable async source. If `searchUsers` is provided we use it; if
	// `users` is provided we filter it client-side; otherwise we fall back to
	// the bundled defaults. The wrapper signature unifies both paths so the
	// list component only ever calls `source(query, signal)`.
	const source = React.useMemo<MentionSource>(() => {
		if (searchUsers) {
			return (q, signal) => Promise.resolve(searchUsers(q, signal));
		}
		const list = users ?? DEFAULT_MENTION_USERS;
		return (q) => Promise.resolve(filterUsers(list, q));
	}, [users, searchUsers]);
	const isAsync = !!searchUsers;

	React.useEffect(() => {
		let off: (() => void) | null = null;
		const attach = () => {
			const e = editor.getEditor();
			if (!e) return false;
			off = e.onAsyncEvent(eventName, async () => {
				return await new Promise<MentionUser | null>((resolve) => {
					const rect = currentCaretRect();
					const anchor = currentBlockAnchor();
					const blockRect = anchor?.getBoundingClientRect() ?? null;
					const caretOffsetX = rect && blockRect ? rect.left - blockRect.left : 0;
					const caretOffsetBottom = rect && blockRect ? rect.bottom - blockRect.top : 0;
					setState({ anchor, caretRect: rect, caretOffsetX, caretOffsetBottom, resolve });
				});
			});
			return true;
		};
		if (!attach()) {
			const id = window.setInterval(() => {
				if (attach()) window.clearInterval(id);
			}, 16);
			return () => {
				window.clearInterval(id);
				off?.();
			};
		}
		return () => {
			off?.();
		};
	}, [editor, eventName]);

	const handleSelect = React.useCallback(
		(user: MentionUser | null) => {
			const e = editor.getEditor();
			if (!e) {
				state?.resolve(user);
				setState(null);
				return;
			}
			if (user) {
				const sel = e.getState().selection;
				const tx = e.createTransaction();
				if (sel.head.offset > 0) {
					tx.replaceRange(sel.head.path, sel.head.offset - 1, sel.head.offset, [
						{
							text: formatLabel(user),
							marks: [
								{
									type: 'mention',
									attrs: { id: user.id, href: mentionHref(user) },
								},
							],
						},
						{ text: ' ' },
					]);
				}
				tx.commit();
			}
			state?.resolve(user);
			setState(null);
		},
		[editor, formatLabel, mentionHref, state]
	);

	if (!state) return null;
	// Compute a fresh "caret-position" rect on every reposition by reading
	// the live block's `getBoundingClientRect()` and adding the offsets we
	// captured at open time. This pins the menu under the `@` glyph even
	// when the page scrolls — using the frozen `caretRect` directly would
	// leave the menu stranded after a scroll. Falls back to the snapshot
	// rect if the block element is unreachable (e.g. detached mid-flow).
	const anchorFn = (): DOMRect | null => {
		if (state.anchor) {
			const r = state.anchor.getBoundingClientRect();
			return new DOMRect(r.left + state.caretOffsetX, r.top + state.caretOffsetBottom, 0, 0);
		}
		return state.caretRect;
	};
	const boundary = state.anchor?.closest('.plim-editor') ?? null;
	return (
		<ActionPanel
			open
			anchor={anchorFn}
			placement="bottom-start"
			boundary={boundary}
			onClose={() => {
				state.resolve(null);
				setState(null);
			}}
			dismissOnOutsideClick
		>
			<MentionList source={source} isAsync={isAsync} debounceMs={debounceMs} onSelect={handleSelect} />
		</ActionPanel>
	);
}

type MentionSource = (query: string, signal: AbortSignal) => Promise<readonly MentionUser[]>;

function filterUsers(users: readonly MentionUser[], query: string): readonly MentionUser[] {
	const q = query.trim().toLowerCase();
	if (!q) return users;
	return users.filter(
		(u) =>
			u.name.toLowerCase().includes(q) ||
			u.handle.toLowerCase().includes(q) ||
			(u.role ? u.role.toLowerCase().includes(q) : false)
	);
}

function MentionList({
	source,
	isAsync,
	debounceMs,
	onSelect,
}: {
	source: MentionSource;
	isAsync: boolean;
	debounceMs: number;
	onSelect: (u: MentionUser | null) => void;
}) {
	const [query, setQuery] = React.useState('');
	const [results, setResults] = React.useState<readonly MentionUser[]>([]);
	const [loading, setLoading] = React.useState<boolean>(isAsync);
	const [active, setActive] = React.useState(0);
	const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

	// Run the source whenever the query changes. Async sources are debounced
	// and stale responses are discarded via an abort controller; synchronous
	// sources resolve in the same microtask so `loading` only briefly flips
	// (and only on the first render in the async case).
	React.useEffect(() => {
		const controller = new AbortController();
		let cancelled = false;
		const run = () => {
			if (isAsync) setLoading(true);
			source(query, controller.signal).then(
				(items) => {
					if (cancelled) return;
					setResults(items);
					setLoading(false);
				},
				(err) => {
					if (cancelled) return;
					// Aborts are expected — every keystroke aborts the previous request.
					if ((err as { name?: string } | null | undefined)?.name === 'AbortError') return;
					setResults([]);
					setLoading(false);
				}
			);
		};
		const delay = isAsync ? debounceMs : 0;
		const handle = delay > 0 ? window.setTimeout(run, delay) : (run(), 0);
		return () => {
			cancelled = true;
			controller.abort();
			if (delay > 0) window.clearTimeout(handle);
		};
	}, [source, isAsync, debounceMs, query]);

	React.useEffect(() => setActive(0), [results]);
	React.useEffect(() => {
		const el = itemRefs.current[active];
		if (el) el.scrollIntoView({ block: 'nearest' });
	}, [active]);

	React.useEffect(() => {
		function onKey(ev: KeyboardEvent) {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				ev.stopPropagation();
				onSelect(null);
				return;
			}
			if (ev.key === 'ArrowDown') {
				ev.preventDefault();
				ev.stopPropagation();
				setActive((a) => Math.min(results.length - 1, a + 1));
				return;
			}
			if (ev.key === 'ArrowUp') {
				ev.preventDefault();
				ev.stopPropagation();
				setActive((a) => Math.max(0, a - 1));
				return;
			}
			if (ev.key === 'Enter' || ev.key === 'Tab') {
				ev.preventDefault();
				ev.stopPropagation();
				const u = results[active];
				onSelect(u ?? null);
				return;
			}
			if (ev.key === ' ') {
				ev.preventDefault();
				ev.stopPropagation();
				onSelect(null);
				return;
			}
			if (ev.key === 'Backspace') {
				if (query.length === 0) {
					ev.preventDefault();
					ev.stopPropagation();
					onSelect(null);
					return;
				}
				ev.preventDefault();
				ev.stopPropagation();
				setQuery((q) => q.slice(0, -1));
				return;
			}
			if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) {
				ev.preventDefault();
				ev.stopPropagation();
				setQuery((q) => q + ev.key);
			}
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [active, results, onSelect, query]);

	const showSpinner = loading && results.length === 0;
	const showEmpty = !loading && results.length === 0;

	return (
		<div className="mention-menu" role="listbox">
			<div className="mention-menu-header">{query ? `Filtering: "${query}"` : 'Mention a person'}</div>
			<div className="mention-menu-list" aria-busy={loading || undefined}>
				{showSpinner ? (
					<div className="mention-menu-loading">Searching…</div>
				) : showEmpty ? (
					<div className="mention-menu-empty">{query ? `No people match "${query}"` : 'No suggestions'}</div>
				) : (
					results.map((u, i) => (
						<button
							key={u.id}
							ref={(el) => {
								itemRefs.current[i] = el;
							}}
							className={`mention-menu-item${i === active ? ' active' : ''}`}
							onMouseDown={(e) => {
								e.preventDefault();
								onSelect(u);
							}}
							onMouseEnter={() => setActive(i)}
						>
							{u.avatar !== undefined ? <span className="mention-avatar">{u.avatar}</span> : null}
							<span className="mention-primary">
								<span className="mention-name">{u.name}</span>
								<span className="mention-handle">@{u.handle}</span>
							</span>
							{u.role !== undefined ? <span className="mention-role">{u.role}</span> : null}
						</button>
					))
				)}
			</div>
		</div>
	);
}
