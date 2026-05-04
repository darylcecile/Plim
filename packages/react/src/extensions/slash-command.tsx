import * as React from 'react';
import { defineAction, defineExtension, triggers } from '@plim/core';
import type { EditorHandle } from '../index.js';
import { ActionPanel } from '../index.js';

// ──────────────────────────────────────────────────────────────────────────────
// Slash-command extension
//
// Pairs an action that fires `showSlashCommandMenu` on `/` with a React
// component that listens for that event, renders a filterable menu, and
// commits the user's choice as a `setBlockType` transaction (after stripping
// the trigger `/` left in the document by the keyboard insertion).
// ──────────────────────────────────────────────────────────────────────────────

export type SlashCommandItem = {
	id: string;
	label: string;
	hint: string;
	icon: string;
	keywords: string[];
	/**
	 * How to apply the chosen item to the current block. The default action
	 * for a built-in item runs `setBlockType` with `blockType` and `attrs`.
	 * Pass a custom `apply` to override (e.g. insert nodes, run any
	 * transaction). The default behaviour also strips the trigger `/`
	 * preceding the caret.
	 */
	blockType?: string;
	attrs?: Record<string, unknown>;
	apply?: (ctx: SlashCommandApplyContext) => void;
};

export type SlashCommandApplyContext = {
	editor: NonNullable<ReturnType<EditorHandle['getEditor']>>;
	/** Selection at the moment the menu opened. */
	openSelection: { anchor: { path: number[]; offset: number }; head: { path: number[]; offset: number } };
};

export const DEFAULT_SLASH_ITEMS: readonly SlashCommandItem[] = [
	{ id: 'paragraph', label: 'Text', hint: 'Plain text paragraph', icon: '¶', keywords: ['text', 'paragraph', 'plain'], blockType: 'paragraph' },
	{ id: 'h1', label: 'Heading 1', hint: 'Big section heading', icon: 'H1', keywords: ['h1', 'heading', 'big'], blockType: 'heading', attrs: { level: 1 } },
	{ id: 'h2', label: 'Heading 2', hint: 'Medium section heading', icon: 'H2', keywords: ['h2', 'heading'], blockType: 'heading', attrs: { level: 2 } },
	{ id: 'h3', label: 'Heading 3', hint: 'Small section heading', icon: 'H3', keywords: ['h3', 'heading'], blockType: 'heading', attrs: { level: 3 } },
	{ id: 'bulleted', label: 'Bulleted list', hint: 'A simple bulleted list', icon: '•', keywords: ['bullet', 'list', 'unordered'], blockType: 'bulleted_list_item' },
	{ id: 'numbered', label: 'Numbered list', hint: 'An ordered list', icon: '1.', keywords: ['number', 'numbered', 'list'], blockType: 'numbered_list_item' },
	{ id: 'todo', label: 'To-do list', hint: 'Track tasks', icon: '☐', keywords: ['todo', 'task', 'check'], blockType: 'to_do', attrs: { checked: false } },
	{ id: 'toggle', label: 'Toggle list', hint: 'Collapsible content', icon: '▸', keywords: ['toggle', 'collapse'], blockType: 'toggle', attrs: { open: true } },
	{ id: 'quote', label: 'Quote', hint: 'Capture a quote', icon: '❝', keywords: ['quote', 'callout'], blockType: 'quote' },
	{ id: 'code', label: 'Code', hint: 'Block of code', icon: '</>', keywords: ['code', 'snippet'], blockType: 'code' },
	{ id: 'divider', label: 'Divider', hint: 'Visual divider', icon: '—', keywords: ['divider', 'hr', 'rule'], blockType: 'divider' },
	{ id: 'image', label: 'Image', hint: 'Embed an image by URL', icon: '🖼', keywords: ['image', 'picture', 'photo', 'img'], blockType: 'image' },
	{ id: 'embed', label: 'Embed', hint: 'Embed a URL via iframe', icon: '🔗', keywords: ['embed', 'iframe', 'url', 'link'], blockType: 'embed' },
	{ id: 'raw_html', label: 'Raw HTML', hint: 'Sandboxed HTML snippet', icon: '</>', keywords: ['html', 'raw', 'embed'], blockType: 'raw_html' },
	{
		id: 'table',
		label: 'Table',
		hint: 'Simple data table',
		icon: '⊞',
		keywords: ['table', 'grid', 'rows'],
		blockType: 'table',
		attrs: { data: [['', '', ''], ['', '', '']] },
	},
];

export type SlashCommandExtensionOptions = {
	/** Trigger character. Default `'/'`. */
	character?: string;
	/** Event name dispatched via `triggerAsyncEvent`. Default `'showSlashCommandMenu'`. */
	eventName?: string;
};

/**
 * Extension factory. Add to `PlimDriver`'s `extensions` array.
 *
 * ```ts
 * const plim = new PlimDriver({
 *   extensions: [slashCommandExtension()],
 *   // ...
 * });
 * ```
 */
export function slashCommandExtension(opts: SlashCommandExtensionOptions = {}) {
	const character = opts.character ?? '/';
	const eventName = opts.eventName ?? 'showSlashCommandMenu';
	return defineExtension(() => ({
		name: 'slashCommand',
		registeredActions: [
			defineAction('slashCommand', {
				trigger: triggers.keyboard.character(character),
				triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
				cancellationTriggers: [triggers.keyboard.key('Escape')],
				perform: async (_state, ctx) => {
					return ctx.triggerAsyncEvent(eventName);
				},
			}),
		],
	}));
}

// ──────────────────────────────────────────────────────────────────────────────
// React UI
// ──────────────────────────────────────────────────────────────────────────────

export type SlashCommandMenuProps = {
	editor: EditorHandle;
	/** Override or extend the default item list. */
	items?: readonly SlashCommandItem[];
	/** Event name to listen for. Must match the extension. Default `'showSlashCommandMenu'`. */
	eventName?: string;
	/** Width of the slash menu panel. */
	className?: string;
};

type SlashState = {
	anchor: Element | null;
	caretRect: DOMRect | null;
	resolve: (id: string | null) => void;
};

export function SlashCommandMenu(props: SlashCommandMenuProps): React.ReactElement | null {
	const { editor, items = DEFAULT_SLASH_ITEMS, eventName = 'showSlashCommandMenu' } = props;
	const [state, setState] = React.useState<SlashState | null>(null);

	// Self-register the async event listener on the underlying agnostic editor
	// the moment it becomes available. We re-attach if the handle's editor
	// reference changes (e.g. driver swap).
	React.useEffect(() => {
		let off: (() => void) | null = null;
		const attach = () => {
			const e = editor.getEditor();
			if (!e) return false;
			off = e.onAsyncEvent(eventName, async () => {
				return await new Promise<string | null>((resolve) => {
					const rect = currentCaretRect();
					const anchor = currentBlockAnchor();
					setState({ anchor, caretRect: rect, resolve });
				});
			});
			return true;
		};
		if (!attach()) {
			// Editor not ready yet — poll a couple of frames.
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
		(id: string | null) => {
			const e = editor.getEditor();
			if (!e) {
				state?.resolve(id);
				setState(null);
				return;
			}
			if (id) {
				const it = items.find((x) => x.id === id);
				const sel = e.getState().selection;
				const tx = e.createTransaction();
				if (sel.head.offset > 0) {
					tx.replaceRange(sel.head.path, sel.head.offset - 1, sel.head.offset, []);
				}
				if (it) {
					if (it.apply) {
						it.apply({ editor: e, openSelection: sel });
					} else if (it.blockType) {
						tx.setBlockType(sel.head.path, it.blockType, it.attrs);
					}
				}
				tx.commit();
			}
			state?.resolve(id);
			setState(null);
		},
		[editor, items, state]
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
			<SlashList items={items} onSelect={handleSelect} />
		</ActionPanel>
	);
}

function SlashList({ items, onSelect }: { items: readonly SlashCommandItem[]; onSelect: (id: string | null) => void }) {
	const [query, setQuery] = React.useState('');
	const [active, setActive] = React.useState(0);
	const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

	const filtered = React.useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items;
		return items.filter((i) => i.label.toLowerCase().includes(q) || i.keywords.some((k) => k.includes(q)));
	}, [items, query]);

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
			if (ev.key === 'Enter') {
				ev.preventDefault();
				ev.stopPropagation();
				const it = filtered[active];
				onSelect(it ? it.id : null);
				return;
			}
			if (ev.key === 'Backspace') {
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
	}, [active, filtered, onSelect]);

	return (
		<div className="slash-menu" role="listbox">
			<div className="slash-menu-header">{query ? `Filtering: "${query}"` : 'Basic blocks'}</div>
			<div className="slash-menu-list">
				{filtered.length === 0 ? (
					<div className="slash-menu-empty">No results</div>
				) : (
					filtered.map((it, i) => (
						<button
							key={it.id}
							ref={(el) => {
								itemRefs.current[i] = el;
							}}
							className={`slash-menu-item${i === active ? ' active' : ''}`}
							onMouseDown={(e) => {
								e.preventDefault();
								onSelect(it.id);
							}}
							onMouseEnter={() => setActive(i)}
						>
							<span className="slash-icon">{it.icon}</span>
							<span className="slash-label">{it.label}</span>
							<span className="slash-hint">{it.hint}</span>
						</button>
					))
				)}
			</div>
		</div>
	);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers shared by both menus
// ──────────────────────────────────────────────────────────────────────────────

export function currentCaretRect(): DOMRect | null {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0).cloneRange();
	range.collapse(true);
	const rects = range.getClientRects();
	if (rects.length > 0) return rects[0]!;
	const node = range.startContainer;
	if (node instanceof Element) return node.getBoundingClientRect();
	return null;
}

export function currentBlockAnchor(): Element | null {
	const sel = window.getSelection();
	const node = sel?.anchorNode ?? null;
	if (!node) return null;
	const el = node instanceof Element ? node : node.parentElement;
	return el?.closest('[data-block-id]') ?? null;
}
