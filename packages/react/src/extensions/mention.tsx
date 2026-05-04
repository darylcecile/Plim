import * as React from 'react';
import { defineAction, defineExtension, triggers } from '@plim/core';
import type { EditorHandle } from '../index.js';
import { ActionPanel } from '../index.js';
import { currentBlockAnchor, currentCaretRect } from './slash-command.js';

// ──────────────────────────────────────────────────────────────────────────────
// Mention extension
//
// Action listens for `@` and dispatches `showMentionSuggestions`. The React
// component renders a filterable user list and inserts the chosen user as a
// `link` mark whose href is `mentionHref(user)` (default `#user-{id}`).
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
		],
	}));
}

// ──────────────────────────────────────────────────────────────────────────────
// React UI
// ──────────────────────────────────────────────────────────────────────────────

export type MentionMenuProps = {
	editor: EditorHandle;
	users?: readonly MentionUser[];
	eventName?: string;
	/** How to format the inserted mention's display text. Default `'@{name}'`. */
	formatLabel?: (user: MentionUser) => string;
	/** href used on the inserted link mark. Default `#user-{id}`. */
	mentionHref?: (user: MentionUser) => string;
};

type MentionState = {
	anchor: Element | null;
	caretRect: DOMRect | null;
	resolve: (user: MentionUser | null) => void;
};

export function MentionMenu(props: MentionMenuProps): React.ReactElement | null {
	const {
		editor,
		users = DEFAULT_MENTION_USERS,
		eventName = 'showMentionSuggestions',
		formatLabel = (u) => `@${u.name}`,
		mentionHref = (u) => `#user-${u.id}`,
	} = props;
	const [state, setState] = React.useState<MentionState | null>(null);

	React.useEffect(() => {
		let off: (() => void) | null = null;
		const attach = () => {
			const e = editor.getEditor();
			if (!e) return false;
			off = e.onAsyncEvent(eventName, async () => {
				return await new Promise<MentionUser | null>((resolve) => {
					const rect = currentCaretRect();
					const anchor = currentBlockAnchor();
					setState({ anchor, caretRect: rect, resolve });
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
						{ text: formatLabel(user), marks: [{ type: 'link', attrs: { href: mentionHref(user) } }] },
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
	return (
		<ActionPanel
			open
			anchor={() => (state.anchor ?? state.caretRect) as Element | DOMRect | null}
			placement="bottom-start"
			onClose={() => {
				state.resolve(null);
				setState(null);
			}}
			dismissOnOutsideClick
		>
			<MentionList users={users} onSelect={handleSelect} />
		</ActionPanel>
	);
}

function MentionList({ users, onSelect }: { users: readonly MentionUser[]; onSelect: (u: MentionUser | null) => void }) {
	const [query, setQuery] = React.useState('');
	const [active, setActive] = React.useState(0);
	const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

	const filtered = React.useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return users;
		return users.filter(
			(u) =>
				u.name.toLowerCase().includes(q) ||
				u.handle.toLowerCase().includes(q) ||
				(u.role ? u.role.toLowerCase().includes(q) : false)
		);
	}, [users, query]);

	React.useEffect(() => setActive(0), [query]);
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
				setActive((a) => Math.min(filtered.length - 1, a + 1));
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
				const u = filtered[active];
				onSelect(u ?? null);
				return;
			}
			if (ev.key === ' ') {
				// Match the action's cancellationTriggers — Space dismisses.
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
	}, [active, filtered, onSelect, query]);

	return (
		<div className="mention-menu" role="listbox">
			<div className="mention-menu-header">{query ? `Filtering: "${query}"` : 'Mention a person'}</div>
			<div className="mention-menu-list">
				{filtered.length === 0 ? (
					<div className="mention-menu-empty">No people match "{query}"</div>
				) : (
					filtered.map((u, i) => (
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
