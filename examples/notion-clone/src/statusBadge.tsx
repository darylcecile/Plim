import * as React from 'react';
import {
	defineAction,
	defineExtension,
	defineMark,
	marksAtOffset,
	triggers,
	type ActionContext,
	type BlockNode,
	type EditorHandle,
	type TextSpan,
	type ValidationContext,
} from '@plim/core';
import { ActionPanel, type EditorHandle as ReactEditorHandle } from '@plim/react';

// ──────────────────────────────────────────────────────────────────────────
// Status badge — an "inline block" demo built as an atomic mark.
// ──────────────────────────────────────────────────────────────────────────
//
// Plim has no inline-block primitive: blocks are always paragraph-level
// containers, and inline content is a `TextSpan[]` (text + marks). The
// closest analogue to Notion's `@page` / `@person` / status pills is a
// *mark* whose `toDOM` renders an atomic pill: the underlying span text is
// the badge label ("Ready"), and the mark wraps it in a styled span carrying
// `data-atomic="true"` so the editor treats the run as a single deletable
// unit (Backspace at the trailing edge wipes the whole pill — same contract
// the bundled `mentionMark` uses).
//
// Three behavioural pieces wire it together:
//   1. `statusMark`            — the visual pill (this file).
//   2. `statusBadgeExtension`  — auto-replaces `[[!ready]]` text on input,
//      and registers atomic-Backspace + an event the menu listens for.
//   3. `<StatusBadgeMenu>`     — a React popover that opens on pill click
//      (delegated listener) and on the `showStatusBadgeMenu` async event,
//      letting the user re-pick one of the three statuses.

export type StatusValue = 'ready' | 'pending' | 'cancelled';

export const STATUS_LABELS: Record<StatusValue, string> = {
	ready: 'Ready',
	pending: 'Pending',
	cancelled: 'Cancelled',
};

export const STATUS_VALUES: readonly StatusValue[] = ['ready', 'pending', 'cancelled'];

// Auto-replace recogniser. Case-insensitive on the keyword so users can
// type `[[!READY]]` or `[[!Ready]]` and still get a pill. The full match
// (including the brackets) is what we replace, so we anchor it with `$`
// against the substring up to the caret in `onTransaction` below.
const STATUS_AUTOREPLACE_RE = /\[\[!(ready|pending|cancelled)\]\]$/i;

// ──────────────────────────────────────────────────────────────────────────
// 1. The mark
// ──────────────────────────────────────────────────────────────────────────

export const statusMark = defineMark({
	name: 'status',
	toDOM: (p) => {
		const el = document.createElement('span');
		el.className = 'plim-status';
		const status = (p.attrs?.status as StatusValue | undefined) ?? 'ready';
		el.setAttribute('data-status', status);
		// Atomic = the editor treats the run as a single deletable unit
		// (Backspace removes the whole pill) AND auto-stamps
		// `data-plim-atom-active="true"` on it whenever the caret lands
		// at one of its edges. The pill's CSS uses that attr to draw
		// the focus ring — see `.plim-status[data-plim-atom-active]` in
		// styles.css.
		el.setAttribute('data-atomic', 'true');
		// `contenteditable=false` on the wrapper would also disable editing
		// the label inline; we *don't* set it, so the user can still position
		// the caret around the pill via arrow keys (which is the
		// "selectable via arrowing" half of the spec).
		return el;
	},
});

// ──────────────────────────────────────────────────────────────────────────
// 2. The extension — auto-replace + atomic Backspace
// ──────────────────────────────────────────────────────────────────────────

export const STATUS_BADGE_EVENT = 'showStatusBadgeMenu';

export type StatusBadgeOpenPayload = {
	/** The block path containing the pill the user clicked (or pressed Enter on). */
	path: readonly number[];
	/** The character range of the pill's text run within that block. */
	from: number;
	to: number;
	/** Current status value, used to highlight the active row in the menu. */
	current: StatusValue;
	/** DOM element of the pill — used to anchor the popover. */
	anchor: HTMLElement;
};

export function statusBadgeExtension() {
	// Re-entry guard: when our `onTransaction` listener dispatches a
	// replacement transaction, that transaction will itself re-fire
	// `onTransaction`. Without a flag we'd recurse forever (or at least
	// thrash until the regex stops matching). The flag is set synchronously
	// around `tx.commit()` so the recursive callback bails immediately.
	let suppress = false;
	// Track the previous caret position so the caret-snap pass knows which
	// way the user moved (arrow-left vs arrow-right vs jumped-from-elsewhere)
	// and can pick the *correct* edge of the pill to land on. Without this
	// the user gets trapped: ArrowLeft from the trailing edge moves the
	// caret to runEnd-1 (inside the pill), and a pure nearest-edge snap
	// would push it back to runEnd, defeating the keypress.
	let prevSel: { path: readonly number[]; offset: number } | null = null;

	return defineExtension(() => ({
		name: 'statusBadge',
		registeredMarks: [statusMark],
		registeredActions: [
			// Atomic Backspace — same shape as the mention extension's
			// `mention.deleteBackward`. When the caret sits at the trailing
			// edge of a status-marked run, one Backspace removes the whole
			// pill instead of one character.
			defineAction('statusBadge.deleteBackward', {
				trigger: triggers.keyboard.key('Backspace'),
				triggerValidationRules: ({ predicate, and }) =>
					and(['inTextBlock', predicate(precededByStatus, 'precededByStatus')]),
				perform: (state, ctx) => {
					const sel = state.selection;
					const block = blockAtPath(state.doc, sel.head.path);
					if (!block?.text) return;
					const range = statusRunEndingAt(block.text, sel.head.offset);
					if (!range) return;
					const tx = ctx.createTransaction();
					tx.replaceRange(sel.head.path, range.from, range.to, []);
					tx.commit();
				},
				priority: 11,
			}),
			// Open the menu when the user presses Enter while the caret is
			// at the trailing edge of a pill (the visual "selected" state).
			// Without this you'd need a mouse click — but the spec calls for
			// arrow-and-Enter keyboard discoverability.
			defineAction('statusBadge.openMenu', {
				trigger: triggers.keyboard.key('Enter'),
				triggerValidationRules: ({ predicate, and }) =>
					and(['inTextBlock', predicate(precededByStatus, 'precededByStatus')]),
				perform: async (state, ctx) => {
					const sel = state.selection;
					const block = blockAtPath(state.doc, sel.head.path);
					if (!block?.text) return;
					const range = statusRunEndingAt(block.text, sel.head.offset);
					if (!range) return;
					const status = statusAttrAt(block.text, range.from) ?? 'ready';
					const anchor = findStatusPillDOM(block.id, range.from);
					if (!anchor) return;
					const payload: StatusBadgeOpenPayload = {
						path: sel.head.path,
						from: range.from,
						to: range.to,
						current: status,
						anchor,
					};
					await ctx.triggerAsyncEvent(STATUS_BADGE_EVENT, payload);
				},
				priority: 11,
			}),
		],
		// Auto-replace pipeline. After every transaction we look at the
		// caret block, see if the substring ending at the caret matches our
		// `[[!status]]` pattern, and rewrite that range as a pill in a
		// follow-up transaction. We ignore programmatic ranges (selections
		// where anchor !== head) and any tx we ourselves dispatched.
		onTransaction: (_tx, ctxUnknown) => {
			if (suppress) return;
			const ctx = ctxUnknown as ActionContext;
			const state = ctx.state;
			const sel = state.selection;
			if (!sel) return;
			if (!pathsEqual(sel.anchor.path, sel.head.path) || sel.anchor.offset !== sel.head.offset) {
				prevSel = null;
				return;
			}
			const block = blockAtPath(state.doc, sel.head.path);
			if (!block?.text) {
				prevSel = { path: sel.head.path, offset: sel.head.offset };
				return;
			}
			const offset = sel.head.offset;
			const flat = block.text.map((s) => s.text).join('');

			// ── Caret-snap pass ────────────────────────────────────────────
			// Pills are atomic — the caret must never sit *strictly* inside
			// a status run. If a transaction landed it there (arrow-key
			// traversal, programmatic setSelection, etc.) we move it to
			// the appropriate edge synchronously, before any subsequent
			// keystroke can fire (Enter would otherwise split the pill,
			// typing would extend the marked run with stray chars, etc.).
			const inside = statusRunContaining(block.text, offset);
			if (inside) {
				let target: number;
				if (prevSel && pathsEqual(prevSel.path, sel.head.path)) {
					if (prevSel.offset >= inside.to) {
						// Came from the right (e.g. ArrowLeft at trailing
						// edge) — escape leftwards.
						target = inside.from;
					} else if (prevSel.offset <= inside.from) {
						// Came from the left (e.g. ArrowRight at leading
						// edge) — escape rightwards.
						target = inside.to;
					} else {
						// Already inside (programmatic) — snap to nearest.
						target = offset - inside.from < inside.to - offset ? inside.from : inside.to;
					}
				} else {
					// No prior context — default to nearest edge.
					target = offset - inside.from < inside.to - offset ? inside.from : inside.to;
				}
				suppress = true;
				try {
					const tx = ctx.createTransaction();
					tx.setSelection({
						anchor: { path: [...sel.head.path], offset: target },
						head: { path: [...sel.head.path], offset: target },
					});
					tx.commit();
				} finally {
					suppress = false;
				}
				prevSel = { path: sel.head.path, offset: target };
				return;
			}

			// ── Auto-replace pass ─────────────────────────────────────────
			// Look at the substring ending at the caret; if it matches our
			// `[[!status]]` pattern, rewrite that range as a pill in a
			// follow-up transaction. Skip the rewrite when the caret sits
			// inside an inline-code run — backticks are the user's escape
			// hatch for literal `[[!ready]]` text (docs, examples, …).
			const m = STATUS_AUTOREPLACE_RE.exec(flat.slice(0, offset));
			if (!m) {
				prevSel = { path: sel.head.path, offset };
				return;
			}
			const inheritedMarks = marksAtOffset(block.text, offset);
			if (inheritedMarks.some((mk) => mk.type === 'code')) {
				prevSel = { path: sel.head.path, offset };
				return;
			}
			const status = m[1]!.toLowerCase() as StatusValue;
			const start = offset - m[0].length;
			const end = offset;
			suppress = true;
			try {
				const tx = ctx.createTransaction();
				tx.replaceRange(sel.head.path, start, end, [
					{
						text: STATUS_LABELS[status],
						marks: [{ type: 'status', attrs: { status } }],
					},
				]);
				// Land caret immediately after the pill so the user can
				// keep typing without re-positioning.
				const newOffset = start + STATUS_LABELS[status].length;
				tx.setSelection({
					anchor: { path: [...sel.head.path], offset: newOffset },
					head: { path: [...sel.head.path], offset: newOffset },
				});
				tx.commit();
				prevSel = { path: sel.head.path, offset: newOffset };
			} finally {
				suppress = false;
			}
		},
	}));
}

// ──────────────────────────────────────────────────────────────────────────
// 3. React popover — opens on pill click (delegated) + via async event
// ──────────────────────────────────────────────────────────────────────────

export type StatusBadgeMenuProps = {
	editor: ReactEditorHandle;
};

type MenuState = {
	anchor: HTMLElement;
	path: readonly number[];
	from: number;
	to: number;
	current: StatusValue;
	resolve: (next: StatusValue | null) => void;
};

export function StatusBadgeMenu(props: StatusBadgeMenuProps): React.ReactElement | null {
	const { editor } = props;
	const [state, setState] = React.useState<MenuState | null>(null);

	// Keyboard path — the extension's `statusBadge.openMenu` action fires
	// `triggerAsyncEvent('showStatusBadgeMenu', payload)`. We resolve the
	// returned promise with the user's choice (or null on dismiss) so the
	// caller could chain UI on it; here it's just used to close the panel.
	React.useEffect(() => {
		let off: (() => void) | null = null;
		const attach = (): boolean => {
			const e = editor.getEditor();
			if (!e) return false;
			off = e.onAsyncEvent(STATUS_BADGE_EVENT, async (event) => {
				const p = event.payload as StatusBadgeOpenPayload | undefined;
				if (!p) return null;
				return await new Promise<StatusValue | null>((resolve) => {
					setState({
						anchor: p.anchor,
						path: p.path,
						from: p.from,
						to: p.to,
						current: p.current,
						resolve,
					});
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
	}, [editor]);

	// Mouse path — delegate `click` from the editor root. We listen on
	// `mousedown` instead of `click` because the editor's selection logic
	// also runs on mousedown; calling `preventDefault` early stops the
	// caret from moving inside the pill (which would otherwise look
	// jittery as the menu opens).
	React.useEffect(() => {
		const handler = (ev: MouseEvent) => {
			const target = ev.target as Element | null;
			if (!target) return;
			const pill = target.closest('.plim-status[data-mark-type="status"]') as HTMLElement | null;
			if (!pill) return;
			ev.preventDefault();
			ev.stopPropagation();
			const e = editor.getEditor();
			if (!e) return;
			// Locate the pill's run by walking back to its block wrapper and
			// finding the matching span by text-offset position.
			const blockEl = pill.closest('[data-block-id]') as HTMLElement | null;
			if (!blockEl) return;
			const blockId = blockEl.getAttribute('data-block-id');
			if (!blockId) return;
			const found = findRunForPill(e.getState().doc.children, blockId, pill);
			if (!found) return;
			setState({
				anchor: pill,
				path: found.path,
				from: found.from,
				to: found.to,
				current: found.status,
				resolve: () => undefined,
			});
		};
		// Capture phase so we run before the editor's own pointer handlers.
		document.addEventListener('mousedown', handler, true);
		return () => document.removeEventListener('mousedown', handler, true);
	}, [editor]);

	const handleSelect = React.useCallback(
		(next: StatusValue | null) => {
			if (!state) return;
			const e = editor.getEditor();
			if (next && e) {
				const tx = e.createTransaction();
				const blockPath = state.path as number[];
				tx.replaceRange(blockPath, state.from, state.to, [
					{
						text: STATUS_LABELS[next],
						marks: [{ type: 'status', attrs: { status: next } }],
					},
				]);
				const after = state.from + STATUS_LABELS[next].length;
				tx.setSelection({
					anchor: { path: [...state.path], offset: after },
					head: { path: [...state.path], offset: after },
				});
				tx.commit();
			}
			state.resolve(next);
			setState(null);
		},
		[editor, state]
	);

	if (!state) return null;
	return (
		<ActionPanel
			open
			anchor={() => state.anchor}
			placement="bottom-start"
			dismissOnOutsideClick
			onClose={() => {
				state.resolve(null);
				setState(null);
			}}
		>
			<div className="plim-status-menu" role="menu" aria-label="Change status">
				{STATUS_VALUES.map((s) => (
					<button
						key={s}
						type="button"
						role="menuitemradio"
						aria-checked={s === state.current}
						className="plim-status-menu-item"
						data-status={s}
						data-active={s === state.current ? 'true' : 'false'}
						onMouseDown={(ev) => ev.preventDefault()}
						onClick={() => handleSelect(s)}
					>
						<span className="plim-status-menu-dot" />
						<span className="plim-status-menu-label">{STATUS_LABELS[s]}</span>
					</button>
				))}
			</div>
		</ActionPanel>
	);
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function blockAtPath(doc: { children: readonly BlockNode[] }, path: readonly number[]): BlockNode | null {
	let node: { children?: readonly BlockNode[] } = doc;
	for (const idx of path) {
		const children = node.children;
		if (!children || idx < 0 || idx >= children.length) return null;
		node = children[idx]!;
	}
	return node as BlockNode;
}

function pathsEqual(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// Walk `spans` left-to-right and return the [from, to] range of the
// contiguous status-marked run that *ends exactly* at `offset`. Adjacent
// pills are split by their `attrs.status` (so backspacing between two
// pills only nukes the right-hand one). Mirrors the mention extension's
// `mentionRunEndingAt` algorithm.
function statusRunEndingAt(spans: readonly TextSpan[], offset: number): { from: number; to: number } | null {
	if (offset <= 0) return null;
	let pos = 0;
	let runFrom: number | null = null;
	let runTo: number | null = null;
	let runStatus: string | undefined;
	for (const span of spans) {
		const start = pos;
		const end = pos + span.text.length;
		const status = span.marks?.find((m) => m.type === 'status');
		const id = status ? ((status.attrs?.status as string | undefined) ?? '') : undefined;
		if (status) {
			if (runFrom === null || id !== runStatus) {
				runFrom = start;
				runStatus = id;
			}
			runTo = end;
		} else {
			runFrom = null;
			runTo = null;
			runStatus = undefined;
		}
		if (offset <= end) {
			if (offset === end && runFrom !== null && runTo === offset) {
				return { from: runFrom, to: runTo };
			}
			return null;
		}
		pos = end;
	}
	if (runFrom !== null && runTo === pos && offset === pos) {
		return { from: runFrom, to: runTo };
	}
	return null;
}

// Walk `spans` and return the [from, to] range of a status run if the
// given `offset` sits *strictly inside* it (`from < offset < to`). Used
// by the caret-snap pass — `statusRunEndingAt` only matches the trailing
// edge so it can't be reused here. Adjacent same-status pills are
// collapsed into one logical run, which is fine for the snap (any edge
// of the merged run is a safe landing spot).
function statusRunContaining(spans: readonly TextSpan[], offset: number): { from: number; to: number } | null {
	let pos = 0;
	let runFrom: number | null = null;
	let runStatus: string | undefined;
	for (const span of spans) {
		const start = pos;
		const end = pos + span.text.length;
		const status = span.marks?.find((m) => m.type === 'status');
		const id = status ? ((status.attrs?.status as string | undefined) ?? '') : undefined;
		if (status) {
			if (runFrom === null || id !== runStatus) {
				runFrom = start;
				runStatus = id;
			}
			// Look ahead: collapse contiguous spans sharing the same status.
			let runTo = end;
			let j = spans.indexOf(span) + 1;
			while (j < spans.length) {
				const next = spans[j]!;
				const ns = next.marks?.find((m) => m.type === 'status');
				const nsv = ns ? ((ns.attrs?.status as string | undefined) ?? '') : undefined;
				if (!ns || nsv !== runStatus) break;
				runTo += next.text.length;
				j++;
			}
			if (offset > runFrom && offset < runTo) {
				return { from: runFrom, to: runTo };
			}
		} else {
			runFrom = null;
			runStatus = undefined;
		}
		pos = end;
	}
	return null;
}

function statusAttrAt(spans: readonly TextSpan[], from: number): StatusValue | null {
	let pos = 0;
	for (const span of spans) {
		const end = pos + span.text.length;
		if (pos === from) {
			const m = span.marks?.find((mk) => mk.type === 'status');
			if (m) return (m.attrs?.status as StatusValue | undefined) ?? null;
		}
		pos = end;
	}
	return null;
}

function precededByStatus(ctx: ValidationContext): boolean {
	const block = blockAtPath(ctx.state.doc, ctx.state.selection.head.path);
	if (!block?.text) return false;
	return statusRunEndingAt(block.text, ctx.state.selection.head.offset) !== null;
}

// Locate the pill DOM node for a given block id and run-start offset.
// Uses the editor's `data-block-id` wrapper + a text-offset walk through
// `[data-block-content]` to find the marked span at `from`.
function findStatusPillDOM(blockId: string, from: number): HTMLElement | null {
	const wrap = document.querySelector(`[data-block-id="${cssEscape(blockId)}"]`) as HTMLElement | null;
	if (!wrap) return null;
	const content = wrap.querySelector('[data-block-content]') as HTMLElement | null;
	if (!content) return null;
	let pos = 0;
	const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
	let node: Node | null = walker.nextNode();
	while (node) {
		const text = node.textContent ?? '';
		if (pos === from) {
			// The text node sits inside its mark wrapper(s). Walk up to find
			// the `.plim-status` ancestor.
			let cur: HTMLElement | null = (node.parentNode as HTMLElement | null) ?? null;
			while (cur && cur !== content) {
				if (cur.classList?.contains('plim-status')) return cur;
				cur = cur.parentElement;
			}
		}
		pos += text.length;
		node = walker.nextNode();
	}
	return null;
}

// Given the doc tree, the block id, and a clicked pill DOM element,
// return the block path + character range + current status. Walks the
// block's spans to find the run whose mark.attrs.status matches the
// pill's `data-status` AND whose text matches the pill's textContent.
// (Status pills with the same status next to each other still resolve
// correctly because we track the running offset.)
function findRunForPill(
	children: readonly BlockNode[],
	blockId: string,
	pill: HTMLElement
): { path: number[]; from: number; to: number; status: StatusValue } | null {
	const targetStatus = (pill.getAttribute('data-status') as StatusValue | null) ?? null;
	if (!targetStatus) return null;
	const targetText = pill.textContent ?? '';

	// We need to find the pill's *position* within its block content, not
	// just any run with the same status. Walk the DOM up to find the index
	// of this pill among `.plim-status` siblings inside the same
	// `[data-block-content]` (so duplicate statuses still resolve).
	const blockEl = pill.closest('[data-block-id]') as HTMLElement | null;
	if (!blockEl) return null;
	const content = blockEl.querySelector('[data-block-content]') as HTMLElement | null;
	if (!content) return null;
	const allPills = Array.from(content.querySelectorAll('.plim-status'));
	const pillIdx = allPills.indexOf(pill);
	if (pillIdx < 0) return null;

	// Find the block in the doc by id.
	const found = locateBlockById(children, blockId, []);
	if (!found) return null;
	const { node, path } = found;
	if (!node.text) return null;

	// Walk the spans counting status runs; pick the `pillIdx`-th run.
	let pos = 0;
	let runIdx = -1;
	let inRun = false;
	let runStart = 0;
	let runStatus: StatusValue | null = null;
	for (const span of node.text) {
		const status = span.marks?.find((m) => m.type === 'status');
		const s = status ? ((status.attrs?.status as StatusValue | undefined) ?? null) : null;
		if (s) {
			if (!inRun || s !== runStatus) {
				inRun = true;
				runStart = pos;
				runStatus = s;
				runIdx++;
				if (runIdx === pillIdx) {
					// Extend to end of contiguous run with same status.
					let end = pos + span.text.length;
					// Look ahead through the rest of spans (re-walk).
					let lookPos = end;
					let i = node.text.indexOf(span) + 1;
					while (i < node.text.length) {
						const next = node.text[i]!;
						const ns = next.marks?.find((m) => m.type === 'status');
						const nsv = ns ? ((ns.attrs?.status as StatusValue | undefined) ?? null) : null;
						if (nsv !== runStatus) break;
						end = lookPos + next.text.length;
						lookPos = end;
						i++;
					}
					return { path, from: runStart, to: end, status: runStatus };
				}
			}
		} else {
			inRun = false;
			runStatus = null;
		}
		pos += span.text.length;
	}
	// Fallback: text match if offset walk failed.
	const t = targetText;
	let p = 0;
	for (const span of node.text) {
		const status = span.marks?.find((m) => m.type === 'status');
		if (status && span.text === t) {
			return { path, from: p, to: p + t.length, status: targetStatus };
		}
		p += span.text.length;
	}
	return null;
}

function locateBlockById(
	children: readonly BlockNode[],
	id: string,
	prefix: readonly number[]
): { node: BlockNode; path: number[] } | null {
	for (let i = 0; i < children.length; i++) {
		const child = children[i]!;
		if (child.id === id) return { node: child, path: [...prefix, i] };
		if (child.children) {
			const r = locateBlockById(child.children, id, [...prefix, i]);
			if (r) return r;
		}
	}
	return null;
}

function cssEscape(s: string): string {
	// Modern browsers ship CSS.escape; fall back to a basic regex strip for
	// older test environments.
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
	return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// ──────────────────────────────────────────────────────────────────────────
// Caret-adjacency highlight
// ──────────────────────────────────────────────────────────────────────────
//
// The editor itself stamps `data-plim-atom-active="true"` on any
// `[data-atomic="true"]` descendant of a block-content element when the
// caret lands on one of its edges (see `reapplyAtomActiveAfterRender`
// in `@plim/editor/view.ts`). The status pill picks that up via CSS —
// no per-extension subscription required.

// Re-export EditorHandle type so the host doesn't need a separate import.
export type { EditorHandle };
