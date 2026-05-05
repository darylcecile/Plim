// Floating selection toolbar.
//
// Vanilla DOM, mounted on `document.body` as a fixed-positioned panel
// outside the editor's contenteditable subtree (so clicking it never
// drops the selection). The panel discovers its items dynamically by
// walking `editor.marks` and `editor.blocks` for `toolbar` contributions.
//
// Lifecycle: created once per editor view, kept hidden until the
// selection is non-collapsed AND at least one item passes its
// `visibleWhen` rule. Re-evaluated on every `update()` call (which the
// view fires after each transaction *and* on `selectionchange`).
//
// Positioning: anchored above the selection's bounding rect, recomputed
// on scroll/resize and on every `update()`. Falls back to below the
// rect if there's no room above.
//
// Link popover: items whose `name === 'link'` swap the toolbar button
// row for a URL input on click; submitting applies a `link` mark over
// the current selection. Closing the popover (Escape, Enter without a
// URL, or selection collapse) restores the button row.

import {
	type BlockDescriptor,
	type EditorState,
	type MarkDescriptor,
	type ToolbarItem,
	type Transaction,
	type ValidationContext,
	type ValidationRule,
	builders,
	evalRule,
	flattenBlocks,
	getBlockAt,
	hasMark,
	selectionIsEmpty,
} from '@plim/core';

export type ToolbarMountOptions = {
	root: HTMLElement;
	getState: () => EditorState;
	createTransaction: () => Transaction;
	dispatch: (tx: Transaction) => void;
	supportsDecoration: (blockType: string) => boolean;
	blocks: BlockDescriptor[];
	marks: MarkDescriptor[];
	/**
	 * View-layer block-selection set (block ids). When non-empty the
	 * toolbar switches into "block" mode and only renders items whose
	 * `appliesTo === 'block'`. When empty the toolbar uses the doc-level
	 * text selection and renders `appliesTo === 'selection'` items.
	 */
	getBlockSelection: () => Set<string>;
};

export type ToolbarMount = {
	update(): void;
	destroy(): void;
	readonly element: HTMLElement;
};

type ResolvedItem = {
	item: ToolbarItem;
	source: 'mark' | 'block';
	sourceName: string;
	/** Resolved mode this item participates in (defaulted from source). */
	appliesTo: 'selection' | 'block';
};

/** Collect every toolbar item contributed by the registered marks/blocks. */
function collectItems(blocks: BlockDescriptor[], marks: MarkDescriptor[]): ResolvedItem[] {
	const out: ResolvedItem[] = [];
	for (const m of marks) {
		if (!m.toolbar) continue;
		const items = Array.isArray(m.toolbar) ? m.toolbar : [m.toolbar];
		for (const item of items) out.push({ item, source: 'mark', sourceName: m.name, appliesTo: item.appliesTo ?? 'selection' });
	}
	for (const b of blocks) {
		if (!b.toolbar) continue;
		const items = Array.isArray(b.toolbar) ? b.toolbar : [b.toolbar];
		for (const item of items) out.push({ item, source: 'block', sourceName: b.name, appliesTo: item.appliesTo ?? 'block' });
	}
	return out;
}

/** Default visibility rule for an item that doesn't supply one. */
function defaultVisible(resolved: ResolvedItem): ValidationRule | null {
	if (resolved.appliesTo === 'selection') {
		return builders.and(['selectionNotEmpty', 'blockSupportsDecoration']);
	}
	// Block-mode items: visibility is gated externally by the block-selection
	// set being non-empty. No additional doc-level rule by default.
	return null;
}

/** Default active rule for a mark item that doesn't supply one. */
function defaultActive(resolved: ResolvedItem): ValidationRule | null {
	if (resolved.source === 'mark' && resolved.appliesTo === 'selection') {
		return builders.markActiveInSelection(resolved.sourceName);
	}
	return null;
}

export function mountToolbar(opts: ToolbarMountOptions): ToolbarMount {
	const doc = opts.root.ownerDocument;
	const win = doc.defaultView ?? window;
	const el = doc.createElement('div');
	el.className = 'plim-toolbar';
	el.setAttribute('data-plim-isolated', 'true');
	// `role="toolbar"` is what AT users expect for a button strip; the
	// child buttons keep their own labels.
	el.setAttribute('role', 'toolbar');
	el.setAttribute('aria-label', 'Formatting');
	el.style.position = 'fixed';
	el.style.zIndex = '1000';
	el.style.display = 'none';
	doc.body.appendChild(el);

	const items = collectItems(opts.blocks, opts.marks);

	// State for the link popover. When `linkActive` is non-null the
	// toolbar shows the URL input instead of the button row.
	let linkActive: { initialHref: string } | null = null;
	// The currently-mounted link-row DOM (if any). We keep it across
	// renders so paste/typing/selectionchange events that fire while
	// the user is filling in the URL don't tear down the input and
	// blow away its focus + value.
	let linkRowEl: HTMLElement | null = null;
	// Track whether the toolbar is "open" — i.e. should be shown for the
	// current selection — so a click inside it doesn't trigger our
	// blur-driven hide path. Pointerdown on `el` sets a one-tick guard.
	let pointerInside = false;
	el.addEventListener('pointerdown', () => {
		pointerInside = true;
		// Reset on next macrotask so subsequent selection changes still
		// hide the toolbar normally.
		setTimeout(() => {
			pointerInside = false;
		}, 0);
	});

	function valCtx(): ValidationContext {
		return { state: opts.getState(), supportsDecoration: opts.supportsDecoration };
	}

	function isVisible(resolved: ResolvedItem, ctx: ValidationContext): boolean {
		const rule = resolved.item.visibleWhen ? resolved.item.visibleWhen(builders) : defaultVisible(resolved);
		if (rule === null) return true;
		return evalRule(rule, ctx);
	}

	function isActive(resolved: ResolvedItem, ctx: ValidationContext): boolean {
		const rule = resolved.item.activeWhen ? resolved.item.activeWhen(builders) : defaultActive(resolved);
		return rule ? evalRule(rule, ctx) : false;
	}

	function isDisabled(resolved: ResolvedItem, ctx: ValidationContext): boolean {
		if (!resolved.item.disabledWhen) return false;
		return evalRule(resolved.item.disabledWhen(builders), ctx);
	}

	function hide() {
		el.style.display = 'none';
		linkActive = null;
		linkRowEl = null;
		el.replaceChildren();
	}

	function existingLinkHrefAtSelection(): string {
		const state = opts.getState();
		const sel = state.selection;
		if (selectionIsEmpty(sel)) return '';
		// Look for any `link` mark on the head block over the selection.
		const block = getBlockAt(state.doc, sel.head.path);
		if (!block?.text) return '';
		const from = Math.min(sel.anchor.offset, sel.head.offset);
		const to = Math.max(sel.anchor.offset, sel.head.offset);
		if (!hasMark(block.text, from, to, 'link')) return '';
		// Pull the first link span's href.
		let pos = 0;
		for (const span of block.text) {
			const start = pos;
			const end = pos + span.text.length;
			if (!(end <= from || start >= to)) {
				const link = span.marks?.find((m) => m.type === 'link');
				if (link) return (link.attrs?.href as string | undefined) ?? '';
			}
			pos = end;
		}
		return '';
	}

	function openLinkPopover() {
		linkActive = { initialHref: existingLinkHrefAtSelection() };
		render();
	}

	function applyLink(href: string) {
		const trimmed = href.trim();
		const state = opts.getState();
		const sel = state.selection;
		if (selectionIsEmpty(sel)) return;
		const tx = opts.createTransaction();
		if (trimmed.length === 0) {
			// Empty URL → remove existing link mark over the selection.
			// `toggleMark` toggles based on whether the range is fully
			// covered, so explicitly removing means we apply `link` only
			// if not already there… simpler: drive a remove-only path by
			// applying with empty href when nothing is there is a no-op.
			// For now: only act when there's an existing link to clear.
			if (existingLinkHrefAtSelection()) {
				tx.toggleMark('link', {
					from: { path: sel.anchor.path, offset: sel.anchor.offset },
					to: { path: sel.head.path, offset: sel.head.offset },
				});
				tx.commit();
			}
			linkActive = null;
			render();
			return;
		}
		// Apply (or update) a link with the supplied href.
		const had = existingLinkHrefAtSelection();
		if (had && had !== trimmed) {
			// Remove the old, then apply the new — `toggleMark` doesn't
			// have an "update attrs" op so we sequence two toggles.
			tx.toggleMark('link', {
				from: { path: sel.anchor.path, offset: sel.anchor.offset },
				to: { path: sel.head.path, offset: sel.head.offset },
			});
			tx.toggleMark(
				'link',
				{
					from: { path: sel.anchor.path, offset: sel.anchor.offset },
					to: { path: sel.head.path, offset: sel.head.offset },
				},
				{ href: trimmed },
			);
		} else if (!had) {
			tx.toggleMark(
				'link',
				{
					from: { path: sel.anchor.path, offset: sel.anchor.offset },
					to: { path: sel.head.path, offset: sel.head.offset },
				},
				{ href: trimmed },
			);
		}
		tx.commit();
		linkActive = null;
		render();
	}

	function buildButtonRow(visible: ResolvedItem[], ctx: ValidationContext) {
		// Group + sort: marks first, then blocks; within each, sort by
		// declared `priority` ascending.
		const byGroup = new Map<string, ResolvedItem[]>();
		for (const r of visible) {
			const g = r.item.group ?? 'misc';
			let arr = byGroup.get(g);
			if (!arr) {
				arr = [];
				byGroup.set(g, arr);
			}
			arr.push(r);
		}
		// Render order: mark, block, then any other groups alpha.
		const orderedGroups: string[] = [];
		if (byGroup.has('mark')) orderedGroups.push('mark');
		if (byGroup.has('block')) orderedGroups.push('block');
		for (const g of [...byGroup.keys()].sort()) {
			if (g === 'mark' || g === 'block') continue;
			orderedGroups.push(g);
		}
		let firstGroup = true;
		for (const g of orderedGroups) {
			const group = byGroup.get(g)!;
			group.sort((a, b) => (a.item.priority ?? 0) - (b.item.priority ?? 0));
			if (!firstGroup) {
				const sep = doc.createElement('div');
				sep.className = 'plim-toolbar-separator';
				el.appendChild(sep);
			}
			firstGroup = false;
			for (const resolved of group) {
				const btn = doc.createElement('button');
				btn.type = 'button';
				btn.className = 'plim-toolbar-button';
				btn.setAttribute('data-toolbar-item', resolved.item.name);
				const label = resolved.item.shortcut
					? `${resolved.item.label} (${resolved.item.shortcut})`
					: resolved.item.label;
				btn.setAttribute('aria-label', label);
				btn.title = label;
				btn.innerHTML = resolved.item.icon ?? resolved.item.label;
				if (isActive(resolved, ctx)) {
					btn.setAttribute('data-active', 'true');
					btn.setAttribute('aria-pressed', 'true');
				} else {
					btn.setAttribute('aria-pressed', 'false');
				}
				if (isDisabled(resolved, ctx)) {
					btn.setAttribute('aria-disabled', 'true');
					btn.setAttribute('disabled', '');
				}
				// Don't let the button's mousedown drop the editor's text
				// selection — that's the whole reason this lives outside
				// the contenteditable.
				btn.addEventListener('mousedown', (ev) => {
					ev.preventDefault();
				});
				btn.addEventListener('click', (ev) => {
					ev.preventDefault();
					if (btn.hasAttribute('disabled')) return;
					if (resolved.item.name === 'link') {
						openLinkPopover();
						return;
					}
					resolved.item.perform({
						state: opts.getState(),
						editor: { createTransaction: opts.createTransaction, dispatch: opts.dispatch },
						anchor: btn,
						close: hide,
						blockSelection: opts.getBlockSelection(),
					});
				});
				el.appendChild(btn);
			}
		}
	}

	function buildLinkRow() {
		const wrap = doc.createElement('div');
		wrap.className = 'plim-toolbar-link';
		const input = doc.createElement('input');
		input.type = 'url';
		input.placeholder = 'Paste link';
		input.className = 'plim-toolbar-link-input';
		input.value = linkActive?.initialHref ?? '';
		input.spellcheck = false;
		// `data-plim-isolated` already set on the parent; nothing else
		// needed to keep input typing from disturbing the doc selection.
		input.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				ev.stopPropagation();
				applyLink(input.value);
			} else if (ev.key === 'Escape') {
				ev.preventDefault();
				// Stop propagation so the document-level Escape handler
				// doesn't also fire `hide()`, which would tear down the
				// freshly-rebuilt button row.
				ev.stopPropagation();
				linkActive = null;
				linkRowEl = null;
				render();
			}
		});
		input.addEventListener('mousedown', (ev) => {
			ev.stopPropagation();
		});
		const apply = doc.createElement('button');
		apply.type = 'button';
		apply.className = 'plim-toolbar-button';
		apply.textContent = 'Apply';
		apply.addEventListener('mousedown', (ev) => ev.preventDefault());
		apply.addEventListener('click', (ev) => {
			ev.preventDefault();
			applyLink(input.value);
		});
		wrap.appendChild(input);
		wrap.appendChild(apply);
		if (linkActive?.initialHref) {
			const remove = doc.createElement('button');
			remove.type = 'button';
			remove.className = 'plim-toolbar-button';
			remove.textContent = 'Remove';
			remove.addEventListener('mousedown', (ev) => ev.preventDefault());
			remove.addEventListener('click', (ev) => {
				ev.preventDefault();
				applyLink('');
			});
			wrap.appendChild(remove);
		}
		el.appendChild(wrap);
		linkRowEl = wrap;
		// Defer focus to next tick so display:flex layout settles.
		queueMicrotask(() => {
			input.focus();
			input.select();
		});
	}

	function position(rect: DOMRect | null): boolean {
		if (!rect) {
			el.style.display = 'none';
			return false;
		}
		// `getBoundingClientRect` returns 0/0 for collapsed selections;
		// guard against accidentally pinning the toolbar to the corner.
		if (rect.width === 0 && rect.height === 0) {
			el.style.display = 'none';
			return false;
		}
		// Make visible to measure the toolbar itself.
		el.style.display = 'flex';
		const tbRect = el.getBoundingClientRect();
		const margin = 8;
		// Default: above the range. Fall back to below if there's no
		// room (rare; happens when caret is in the first visual line).
		let top = rect.top - tbRect.height - margin;
		if (top < margin) top = rect.bottom + margin;
		let left = rect.left + rect.width / 2 - tbRect.width / 2;
		// Clamp to viewport.
		const maxLeft = win.innerWidth - tbRect.width - margin;
		if (left < margin) left = margin;
		else if (left > maxLeft) left = Math.max(margin, maxLeft);
		el.style.top = `${top}px`;
		el.style.left = `${left}px`;
		return true;
	}

	function selectionRect(): DOMRect | null {
		const sel = win.getSelection();
		if (!sel || sel.rangeCount === 0) return null;
		return sel.getRangeAt(0).getBoundingClientRect();
	}

	function blockSelectionRect(ids: Set<string>): DOMRect | null {
		// Union of bounding rects of all selected block elements.
		let top = Infinity;
		let left = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		let any = false;
		for (const id of ids) {
			// We escape via attribute selector — block ids are generated
			// by `newId()` (alphanumerics + underscore) so unescaped is fine.
			const elBlock = opts.root.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
			if (!elBlock) continue;
			const r = elBlock.getBoundingClientRect();
			top = Math.min(top, r.top);
			left = Math.min(left, r.left);
			right = Math.max(right, r.right);
			bottom = Math.max(bottom, r.bottom);
			any = true;
		}
		if (!any) return null;
		return new DOMRect(left, top, right - left, bottom - top);
	}

	function render() {
		const ctx = valCtx();
		const sel = ctx.state.selection;
		const blockSel = opts.getBlockSelection();

		// Mode resolution. Block-selection wins when present.
		const mode: 'selection' | 'block' | null =
			blockSel.size > 0 ? 'block' : selectionIsEmpty(sel) ? null : 'selection';

		// Block-mode opt-out: hide if any selected block's descriptor opts
		// out of the block-transform toolbar. Default rule: atomic blocks
		// (`atomic: true`) opt out automatically — applying a "Heading 1"
		// turn-into to an image/divider/counter would destroy its attrs and
		// replace the block with an empty heading. Descriptors can override
		// either way: `disableToolbar: true` always hides; `disableToolbar:
		// false` keeps the toolbar even for atomic blocks (rare). "Any"
		// (not "all") because a mixed selection containing an opt-out block
		// also can't be safely transformed.
		if (mode === 'block') {
			const flat = flattenBlocks(ctx.state.doc);
			const descByName = new Map(opts.blocks.map((b) => [b.name, b]));
			for (const { block } of flat) {
				if (!blockSel.has(block.id)) continue;
				const desc = descByName.get(block.type);
				const disabled = desc?.disableToolbar ?? desc?.atomic ?? false;
				if (disabled) {
					el.style.display = 'none';
					linkActive = null;
					linkRowEl = null;
					el.replaceChildren();
					return;
				}
			}
		}

		if (mode === null) {
			el.style.display = 'none';
			linkActive = null;
			linkRowEl = null;
			el.replaceChildren();
			return;
		}

		// Don't show if focus has left the editor entirely AND the
		// pointer isn't currently on the toolbar (clicking a button).
		// Block-mode is exempt: drag-handle clicks intentionally move
		// focus around and we still want the toolbar visible. The link
		// popover is also exempt — its <input> owns focus on purpose.
		if (mode === 'selection' && !linkActive) {
			const active = doc.activeElement;
			const insideEditor = active && opts.root.contains(active);
			const insideToolbar = active && el.contains(active);
			if (!insideEditor && !insideToolbar && !pointerInside) {
				el.style.display = 'none';
				linkActive = null;
				linkRowEl = null;
				el.replaceChildren();
				return;
			}
		}

		// Link popover only makes sense in selection mode.
		if (mode === 'selection' && linkActive) {
			// If the link row is already mounted, just reposition. Tearing
			// it down on every selectionchange / paste would lose focus
			// and the partially-typed URL.
			if (linkRowEl && linkRowEl.isConnected) {
				position(selectionRect());
				return;
			}
			el.replaceChildren();
			buildLinkRow();
			position(selectionRect());
			return;
		}
		if (mode === 'block') linkActive = null;

		// Rebuild the button row.
		linkRowEl = null;
		el.replaceChildren();
		const visible = items.filter((r) => r.appliesTo === mode && isVisible(r, ctx));
		if (visible.length === 0) {
			el.style.display = 'none';
			return;
		}
		buildButtonRow(visible, ctx);
		const rect = mode === 'block' ? blockSelectionRect(blockSel) : selectionRect();
		position(rect);
	}

	function onScroll() {
		if (el.style.display === 'none') return;
		render();
	}
	function onResize() {
		if (el.style.display === 'none') return;
		render();
	}
	const onKeyDown = (ev: KeyboardEvent) => {
		if (ev.key === 'Escape' && el.style.display !== 'none') {
			hide();
		}
	};
	win.addEventListener('scroll', onScroll, true);
	win.addEventListener('resize', onResize);
	doc.addEventListener('keydown', onKeyDown);

	return {
		element: el,
		update() {
			render();
		},
		destroy() {
			win.removeEventListener('scroll', onScroll, true);
			win.removeEventListener('resize', onResize);
			doc.removeEventListener('keydown', onKeyDown);
			el.remove();
		},
	};
}
