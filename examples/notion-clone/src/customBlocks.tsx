import * as React from 'react';
import { defineBlock } from '@plim/core';
import type { AgnosticEditor } from '@plim/editor';

// ──────────────────────────────────────────────────────────────────────────
// Callout (toDOM example)
// ──────────────────────────────────────────────────────────────────────────
//
// A custom block defined entirely with a DOM `toDOM` function. The editor
// pre-renders the block's text spans into a `[data-block-content]` element
// (using the registered marks) and exposes it via `payload.content`. The
// descriptor wraps that content with a tone-coloured pill on the left and
// stamps a `data-callout-tone` attribute on the wrapper so CSS can style
// each tone independently. Enter splits the callout the same way it splits
// a paragraph, Backspace at the start joins it with the previous block —
// all the standard editing behaviour Just Works because the descriptor
// opted into the same `[data-block-content]` contract built-in blocks use.

export type CalloutTone = 'info' | 'success' | 'warn' | 'danger';

const CALLOUT_ICONS: Record<CalloutTone, string> = {
	info: '💡',
	success: '✅',
	warn: '⚠️',
	danger: '🛑',
};

export const calloutBlock = defineBlock({
	name: 'callout',
	type: 'standalone',
	supportsDecoration: true,
	toDOM: (payload) => {
		const tone = (payload.attrs.tone as CalloutTone | undefined) ?? 'info';
		const wrap = document.createElement('div');
		wrap.className = 'plim-callout';
		wrap.setAttribute('data-tone', tone);

		const icon = document.createElement('span');
		icon.className = 'plim-callout-icon';
		icon.setAttribute('contenteditable', 'false');
		icon.textContent = CALLOUT_ICONS[tone];
		wrap.appendChild(icon);

		// `payload.content` is a `[contentEl]` array containing the editor's
		// pre-rendered `<div data-block-content>` with all the text spans
		// (and any nested mark wrappers) already mounted. Place it where
		// the editable text should appear inside the callout.
		for (const node of payload.content as HTMLElement[]) wrap.appendChild(node);
		return wrap;
	},
});

// ──────────────────────────────────────────────────────────────────────────
// Counter (toComponent example)
// ──────────────────────────────────────────────────────────────────────────
//
// A custom block defined with a React `toComponent`. The view layer is
// framework-agnostic so it can't import React directly; instead `<PlimEditor>`
// bridges by mounting a React root into a stable host element the editor
// places inside the block wrapper. The bridge re-renders the component on
// every transaction (passing fresh props from `payload.attrs`) but keeps
// the same host element so component-local state (`useState`, refs, etc.)
// survives across edits. Component-driven blocks are atomic from the
// editor's perspective: the caret can't enter them and `payload.content`
// is empty — the React tree owns its DOM entirely.
//
// Demonstrated capabilities:
//  - `payload.attrs` flows in as props on every render.
//  - `useState` survives transactions on other blocks (component identity
//    is preserved by the stable host).
//  - The component can commit transactions itself by closing over the
//    editor handle, e.g. to persist data into `attrs` so the count
//    survives a reload / undo.

function CounterCard(props: {
	editor: AgnosticEditor | null;
	id: string;
	title: string;
	persistedCount: number;
}) {
	// Local UI state. Kept in `useState` so we can show optimistic updates
	// without round-tripping every click through a transaction. The
	// persisted count flows in via props from `attrs.count` so the value
	// survives reloads / undo / serialization.
	const [optimistic, setOptimistic] = React.useState(props.persistedCount);
	// If the canonical value changes (e.g. via undo), re-sync the optimistic
	// counter so the two don't drift.
	React.useEffect(() => {
		setOptimistic(props.persistedCount);
	}, [props.persistedCount]);

	const persist = (next: number) => {
		setOptimistic(next);
		const editor = props.editor;
		if (!editor) return;
		const path = findPathForBlockId(editor, props.id);
		if (!path) return;
		const tx = editor.createTransaction();
		tx.setBlockAttrs(path, { count: next });
		tx.commit();
	};

	return (
		<div className="plim-counter">
			<div className="plim-counter-title">{props.title}</div>
			<div className="plim-counter-row">
				<button
					type="button"
					className="plim-counter-btn"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => persist(optimistic - 1)}
					aria-label="Decrement"
				>
					−
				</button>
				<span className="plim-counter-value" aria-live="polite">
					{optimistic}
				</span>
				<button
					type="button"
					className="plim-counter-btn"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => persist(optimistic + 1)}
					aria-label="Increment"
				>
					+
				</button>
			</div>
		</div>
	);
}

// Walk the editor's current doc to find the path of a given block id. The
// custom block doesn't have direct access to its own path because the doc
// can be re-arranged (drag, splits) between renders, so we look it up at
// commit time rather than caching.
function findPathForBlockId(editor: AgnosticEditor, id: string): number[] | null {
	const walk = (children: { id: string; children?: { id: string }[] }[], parent: number[]): number[] | null => {
		for (let i = 0; i < children.length; i++) {
			const c = children[i];
			if (!c) continue;
			if (c.id === id) return [...parent, i];
			if (c.children) {
				const found = walk(c.children as { id: string; children?: { id: string }[] }[], [...parent, i]);
				if (found) return found;
			}
		}
		return null;
	};
	return walk(editor.getState().doc.children as { id: string; children?: { id: string }[] }[], []);
}

// `toComponent` returns a React element built from the descriptor payload.
// We thread the editor handle in via a closure factory so the component
// can commit transactions back into the doc.
export function makeCounterBlock(getEditor: () => AgnosticEditor | null) {
	return defineBlock({
		name: 'counter',
		type: 'standalone',
		atomic: true,
		supportsDecoration: false,
		toComponent: (payload) => (
			<CounterCard
				editor={getEditor()}
				id={payload.id}
				title={String(payload.attrs.title ?? 'Counter')}
				persistedCount={Number(payload.attrs.count ?? 0)}
			/>
		),
	});
}
