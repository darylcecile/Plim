import {
	type ActionContext,
	type BlockDescriptor,
	type BlockNode,
	type BlockPayload,
	type EditorState,
	type MarkDescriptor,
	type MarkPayload,
	type Selection as PSelection,
	type TextSpan,
	type Transaction,
	blockTextLength,
	flattenBlocks,
	isMacLike,
	newId,
} from '@plim/core';
import { sliceFromBlockSelection, sliceFromTextRange, writeClipboardMarkdown } from './clipboard.js';

export type ViewOptions = {
	container: HTMLElement;
	readonly: boolean;
	blocks: BlockDescriptor[];
	marks: MarkDescriptor[];
	getState: () => EditorState;
	dispatch: (tx: Transaction) => void;
	editor: { triggerAsyncEvent: (n: string, p?: unknown) => Promise<unknown>; createTransaction(): Transaction };
	onKeyboardEvent: (ev: KeyboardEvent) => void;
	onClipboardEvent: (action: 'cut' | 'copy' | 'paste', ev: ClipboardEvent) => void;
	onBeforeInput: (text: string) => void;
	// Paste pipeline. Called for every paste event after `preventDefault`.
	// Receives the normalised payload extracted from the native event.
	// Returning `true` means the caller has fully handled the paste; the
	// view will skip its legacy plain-text fallback. Returning `false`
	// means "fall back" — the view will pass the plain text through
	// `onBeforeInput` as before. The native event continues to fire
	// `onClipboardEvent('paste', ev)` either way so action triggers keyed
	// to the clipboard channel still run.
	onPaste?: (data: { text: string; html: string; files: File[]; plim?: string }) => boolean;
	// Optional bridge to render a custom block whose `BlockDescriptor.toComponent`
	// is defined (e.g., a React component). The view creates a stable host
	// element inside the block wrapper and hands it to this hook on every
	// render so the consumer can mount/update its component tree. The view
	// itself remains framework-agnostic.
	renderReactBlock?: (host: HTMLElement, payload: BlockPayload, desc: BlockDescriptor) => void;
};

export type View = {
	update(state: EditorState): void;
	focus(): void;
	destroy(): void;
	readonly root: HTMLElement;
};

const DATA_BLOCK_ID = 'data-block-id';
const DATA_BLOCK_TYPE = 'data-block-type';
const DATA_BLOCK_CONTENT = 'data-block-content';
// Marks a subtree the editor should treat as opaque: native browser
// `contenteditable` handling owns input, the doc's selection state is not
// synced from caret moves inside it, and `beforeinput`/`keydown` handlers
// bail before dispatching transactions. Used for image captions, embed URL
// inputs, raw-HTML editors, and resize handles — anything that lives inside
// a block's chrome but isn't part of the block's text spans.
const DATA_PLIM_ISOLATED = 'data-plim-isolated';

function isolatedAncestor(node: Node | null): HTMLElement | null {
	let cur: Node | null = node;
	while (cur) {
		if (cur instanceof HTMLElement && cur.hasAttribute(DATA_PLIM_ISOLATED)) return cur;
		cur = cur.parentNode;
	}
	return null;
}

// Find this block's editable text container. Built-in / `toDOM` blocks place
// `[data-block-content]` as a direct child of the wrapper, so the fast path
// matches today's behavior. Editable React blocks render the slot inside their
// React tree (one or more elements deep), so we fall back to a descendant
// search that excludes anything inside a nested `[data-block-id]` (those
// belong to child blocks and are reachable via path recursion). Returns null
// for atomic / non-text blocks.
function findBlockContent(blockEl: HTMLElement): HTMLElement | null {
	const direct = blockEl.querySelector(`:scope > [${DATA_BLOCK_CONTENT}]`) as HTMLElement | null;
	if (direct) return direct;
	const candidates = blockEl.querySelectorAll(`[${DATA_BLOCK_CONTENT}]`);
	for (const c of Array.from(candidates)) {
		// Reject any candidate whose nearest block ancestor isn't this block —
		// that would mean it lives inside a nested child block.
		const ownerBlock = c.parentElement?.closest(`[${DATA_BLOCK_ID}]`);
		if (ownerBlock === blockEl) return c as HTMLElement;
	}
	return null;
}

// Walk up from `node` looking for the nearest ancestor with
// `data-atomic="true"`, stopping at `boundary` (typically the block-
// content wrapper) so we never escape into a parent block. Returns the
// atomic element or null. Used by the atom-active highlight pass.
function atomicAncestor(node: Node, boundary: HTMLElement): HTMLElement | null {
	let cur: HTMLElement | null = (node.parentNode as HTMLElement | null) ?? null;
	while (cur && cur !== boundary) {
		if (cur.getAttribute && cur.getAttribute('data-atomic') === 'true') return cur;
		cur = cur.parentElement;
	}
	return null;
}

export function mountView(opts: ViewOptions): View {
	const root = document.createElement('div');
	root.className = 'plim-editor';
	root.setAttribute('contenteditable', opts.readonly ? 'false' : 'true');
	root.setAttribute('spellcheck', 'true');
	root.setAttribute('role', 'textbox');
	root.setAttribute('aria-multiline', 'true');
	(root.style as CSSStyleDeclaration).outline = 'none';
	opts.container.appendChild(root);

	let composing = false;
	let updating = false;

	// ---- Block selection (multi-block) ----
	// View-layer selection state: a Set of currently-selected block ids,
	// plus a separate anchor (pivot for shift+click range / shift+arrow
	// extension) and active id (cursor end for arrow extension). Never
	// persisted into the doc's `selection` (which is a text-range model).
	// Visualised via `data-plim-block-selected="true"` on each wrapper.
	const selection: { ids: Set<string>; anchorId: string | null; activeId: string | null } = {
		ids: new Set<string>(),
		anchorId: null,
		activeId: null,
	};
	function blockElById(id: string): HTMLElement | null {
		return root.querySelector<HTMLElement>(`[${DATA_BLOCK_ID}="${cssAttrEscape(id)}"]`);
	}
	function applySelectionAttrs() {
		// Re-stamp `data-plim-block-selected` on every wrapper from the
		// current `selection.ids` set. Strips the attribute from any
		// wrappers no longer in the set. Cheap because there are
		// typically very few selected blocks.
		for (const b of root.querySelectorAll('[data-plim-block-selected="true"]')) {
			const id = b.getAttribute(DATA_BLOCK_ID);
			if (!id || !selection.ids.has(id)) b.removeAttribute('data-plim-block-selected');
		}
		for (const id of selection.ids) {
			const el = blockElById(id);
			if (el && el.getAttribute('data-plim-block-selected') !== 'true') {
				el.setAttribute('data-plim-block-selected', 'true');
			}
		}
	}
	function selectionSet(ids: Iterable<string>, anchorId: string | null = null, activeId: string | null = null) {
		selection.ids = new Set(ids);
		selection.anchorId = anchorId;
		selection.activeId = activeId;
		if (selection.ids.size > 0) {
			// Drop the DOM caret + steal focus when the selection is
			// non-empty so subsequent keydowns route to root.
			root.ownerDocument.getSelection()?.removeAllRanges();
			root.focus({ preventScroll: true });
		}
		applySelectionAttrs();
	}
	function selectionClear() {
		if (selection.ids.size === 0 && !selection.anchorId && !selection.activeId) return;
		selectionSet([]);
	}
	function selectionAdd(id: string) {
		if (selection.ids.has(id)) return;
		selection.ids.add(id);
		if (selection.anchorId === null) selection.anchorId = id;
		selection.activeId = id;
		applySelectionAttrs();
		root.ownerDocument.getSelection()?.removeAllRanges();
		root.focus({ preventScroll: true });
	}
	function selectionToggle(id: string) {
		if (selection.ids.has(id)) {
			selection.ids.delete(id);
			if (selection.anchorId === id) selection.anchorId = selection.ids.values().next().value ?? null;
			if (selection.activeId === id) selection.activeId = selection.anchorId;
		} else {
			selection.ids.add(id);
			if (selection.anchorId === null) selection.anchorId = id;
			selection.activeId = id;
		}
		applySelectionAttrs();
		root.ownerDocument.getSelection()?.removeAllRanges();
		root.focus({ preventScroll: true });
	}
	function selectionReplaceWith(id: string) {
		selectionSet([id], id, id);
	}
	function selectionRange(targetId: string) {
		// Shift+click / shift+arrow target: select every block from the
		// anchor through `targetId` (inclusive) in flat-document order.
		// If there's no anchor, behave like a plain click.
		if (!selection.anchorId) return selectionReplaceWith(targetId);
		const flat = flattenBlocks(opts.getState().doc);
		const aIdx = flat.findIndex((e) => e.block.id === selection.anchorId);
		const tIdx = flat.findIndex((e) => e.block.id === targetId);
		if (aIdx < 0 || tIdx < 0) return selectionReplaceWith(targetId);
		const [lo, hi] = aIdx <= tIdx ? [aIdx, tIdx] : [tIdx, aIdx];
		const ids: string[] = [];
		for (let i = lo; i <= hi; i++) ids.push(flat[i]!.block.id);
		// Preserve the existing anchor; active becomes the click target.
		selectionSet(ids, selection.anchorId, targetId);
	}
	function reapplyBlockSelectedAfterRender() {
		// After a render that may have wiped/recreated wrappers, re-stamp
		// the attribute on whichever wrapper now hosts each selected id,
		// and prune ids that no longer exist in the doc (e.g. blocks
		// removed by the transaction we just rendered).
		const liveIds = new Set<string>();
		const stateNow = opts.getState();
		for (const e of flattenBlocks(stateNow.doc)) liveIds.add(e.block.id);
		const next: string[] = [];
		for (const id of selection.ids) if (liveIds.has(id)) next.push(id);
		selection.ids = new Set(next);
		if (selection.anchorId && !liveIds.has(selection.anchorId)) selection.anchorId = next[0] ?? null;
		if (selection.activeId && !liveIds.has(selection.activeId)) selection.activeId = selection.anchorId;
		applySelectionAttrs();
	}

	// Generic inline-atom highlight. Any descendant of a block-content
	// element that carries `data-atomic="true"` (typically the wrapper
	// emitted by an atomic mark's `toDOM` — mentions, status pills,
	// custom inline tokens, etc.) becomes a "selectable atom": when the
	// caret lands at one of its edges via arrow keys / click /
	// programmatic selection, the editor stamps `data-plim-atom-active=
	// "true"` on it so consumers can paint a focus ring purely from CSS,
	// without each extension wiring its own subscription. Trailing edge
	// wins on boundary ties (caret between an atom and a regular text
	// run highlights the atom). The stamp is a view-layer DOM attr,
	// never written into the doc, and is cleared every render so stale
	// highlights can't outlive the transaction that produced them.
	function reapplyAtomActiveAfterRender(sel: PSelection) {
		// Clear previous stamps first — cheap because atoms are sparse.
		root.querySelectorAll<HTMLElement>('[data-plim-atom-active="true"]').forEach((el) => {
			el.removeAttribute('data-plim-atom-active');
		});
		// Only highlight on a collapsed caret in a single block.
		if (!pathsEqual(sel.anchor.path, sel.head.path) || sel.anchor.offset !== sel.head.offset) return;
		const blockEl = blockElementAtPath(root, sel.head.path);
		if (!blockEl) return;
		const content = findBlockContent(blockEl);
		if (!content) return;
		const targetOffset = sel.head.offset;
		// Walk text descendants accumulating a doc-style offset. Two
		// passes are conceptually run in one walk: first preferring a
		// text node ending at the caret (trailing edge of an atom);
		// then, only if no atom was found there, a text node starting
		// at the caret (leading edge). Trailing-edge wins on boundary
		// ties because Notion-like UIs place the cursor *after* the
		// just-typed/inserted item, so that's where the eye expects the
		// highlight.
		const walker = root.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT);
		let pos = 0;
		let trailingMatch: HTMLElement | null = null;
		let leadingMatch: HTMLElement | null = null;
		let node = walker.nextNode();
		while (node) {
			const len = (node.textContent ?? '').length;
			const start = pos;
			const end = pos + len;
			if (start === targetOffset && !leadingMatch) {
				const atom = atomicAncestor(node, content);
				if (atom) leadingMatch = atom;
			}
			if (end === targetOffset && !trailingMatch) {
				const atom = atomicAncestor(node, content);
				if (atom) trailingMatch = atom;
			}
			if (start > targetOffset) break;
			pos = end;
			node = walker.nextNode();
		}
		const target = trailingMatch ?? leadingMatch;
		if (target) target.setAttribute('data-plim-atom-active', 'true');
	}

	function deleteSelectedBlocks() {
		if (selection.ids.size === 0) return;
		const state = opts.getState();
		// Find paths for every selected id, then remove in reverse-path
		// order so earlier paths stay valid as later ones are spliced
		// out. Caret lands at the end of the previous flat block of the
		// FIRST removed (top-most), or start of the next.
		const flat = flattenBlocks(state.doc);
		const targets = flat.filter((e) => selection.ids.has(e.block.id));
		if (targets.length === 0) {
			selectionClear();
			return;
		}
		const firstFlatIdx = flat.findIndex((e) => e.block.id === targets[0]!.block.id);
		const prevEntry = firstFlatIdx > 0 ? flat[firstFlatIdx - 1] : undefined;
		const lastFlatIdx = flat.findIndex((e) => e.block.id === targets[targets.length - 1]!.block.id);
		const nextEntry = lastFlatIdx >= 0 && lastFlatIdx + 1 < flat.length ? flat[lastFlatIdx + 1] : undefined;
		// Only consider next-entry as a fallback if it's NOT itself selected.
		const nextEntrySafe = nextEntry && !selection.ids.has(nextEntry.block.id) ? nextEntry : undefined;
		const editor = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor;
		const tx = editor.createTransaction();
		// Sort targets by path descending (deepest/last first) for safe removal.
		const removeOrder = [...targets].sort((a, b) => comparePaths(b.path, a.path));
		for (const t of removeOrder) tx.removeBlock(t.path);
		if (prevEntry && !selection.ids.has(prevEntry.block.id)) {
			const off = prevEntry.block.text !== undefined ? blockTextLength(prevEntry.block) : 0;
			tx.setSelection({ anchor: { path: prevEntry.path, offset: off }, head: { path: prevEntry.path, offset: off } });
		} else if (nextEntrySafe) {
			// Approximate post-removal path: count how many selected blocks
			// share each ancestor segment of nextEntry.path and shift down.
			const adjusted = adjustPathAfterRemovals(nextEntrySafe.path, targets.map((t) => t.path));
			tx.setSelection({ anchor: { path: adjusted, offset: 0 }, head: { path: adjusted, offset: 0 } });
		}
		tx.commit();
		selectionClear();
	}

	function comparePaths(a: readonly number[], b: readonly number[]): number {
		const min = Math.min(a.length, b.length);
		for (let i = 0; i < min; i++) {
			if (a[i]! !== b[i]!) return a[i]! - b[i]!;
		}
		return a.length - b.length;
	}
	function adjustPathAfterRemovals(target: readonly number[], removed: readonly (readonly number[])[]): number[] {
		// For each removed path, if it shares the same parent as `target`
		// at the same depth, and its index is less than target's at that
		// depth, the target's index drops by one.
		const result = target.slice();
		for (const r of removed) {
			if (r.length > result.length) continue;
			const parentDepth = r.length - 1;
			const sameParent = r.slice(0, parentDepth).every((seg, i) => seg === result[i]);
			if (!sameParent) continue;
			if (r[parentDepth]! < result[parentDepth]!) result[parentDepth] = result[parentDepth]! - 1;
		}
		return result;
	}

	function moveCaretFromBlockSelection(direction: 'before' | 'after') {
		if (selection.ids.size === 0) return;
		const state = opts.getState();
		const flat = flattenBlocks(state.doc);
		// Use first/last selected (in flat order) as the boundary, depending on direction.
		const selFlat = flat.filter((e) => selection.ids.has(e.block.id));
		if (selFlat.length === 0) {
			selectionClear();
			return;
		}
		const boundary = direction === 'before' ? selFlat[0]! : selFlat[selFlat.length - 1]!;
		const idx = flat.findIndex((e) => e.block.id === boundary.block.id);
		const target = direction === 'before' ? (idx > 0 ? flat[idx - 1] : undefined) : (idx >= 0 ? flat[idx + 1] : undefined);
		if (!target) return selectionClear();
		// Atomic neighbour: collapse selection to it.
		if (target.block.text === undefined) {
			selectionReplaceWith(target.block.id);
			return;
		}
		const off = direction === 'before' ? blockTextLength(target.block) : 0;
		const editor = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor;
		const tx = editor.createTransaction();
		tx.setSelection({ anchor: { path: target.path, offset: off }, head: { path: target.path, offset: off } });
		tx.commit();
		selectionClear();
	}

	function selectionExtend(direction: 'before' | 'after') {
		if (selection.ids.size === 0 || !selection.anchorId) return;
		const state = opts.getState();
		const flat = flattenBlocks(state.doc);
		const activeIdx = flat.findIndex((e) => e.block.id === (selection.activeId ?? selection.anchorId));
		if (activeIdx < 0) return;
		const nextIdx = direction === 'before' ? Math.max(0, activeIdx - 1) : Math.min(flat.length - 1, activeIdx + 1);
		if (nextIdx === activeIdx) return; // edge of doc
		const newActiveId = flat[nextIdx]!.block.id;
		// Recompute the inclusive range from anchor → new active.
		const aIdx = flat.findIndex((e) => e.block.id === selection.anchorId);
		const [lo, hi] = aIdx <= nextIdx ? [aIdx, nextIdx] : [nextIdx, aIdx];
		const ids: string[] = [];
		for (let i = lo; i <= hi; i++) ids.push(flat[i]!.block.id);
		selectionSet(ids, selection.anchorId, newActiveId);
	}

	function cssAttrEscape(s: string): string {
		// Escape backslashes and double quotes so the value is safe inside
		// `[attr="..."]` selectors. CSS.escape would also work but isn't
		// universally available in older test environments.
		return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	}

	function render(state: EditorState) {
		updating = true;
		try {
			renderBlocks(root, state.doc.children, opts);
			applySelection(root, state.selection);
			reapplyBlockSelectedAfterRender();
			reapplyAtomActiveAfterRender(state.selection);
		} finally {
			updating = false;
		}
	}

	function applySelection(rootEl: HTMLElement, sel: PSelection) {
		const win = rootEl.ownerDocument.defaultView ?? window;
		const selection = win.getSelection();
		if (!selection) return;
		// Mark the block containing the head selection so CSS can show a
		// placeholder only for the focused empty block (Notion-style).
		const allBlocks = rootEl.querySelectorAll<HTMLElement>('[data-block-id]');
		const headBlockEl = blockElementAtPath(rootEl, sel.head.path);
		for (const b of allBlocks) {
			if (b === headBlockEl) {
				if (b.getAttribute('data-caret-active') !== 'true') b.setAttribute('data-caret-active', 'true');
			} else if (b.hasAttribute('data-caret-active')) {
				b.removeAttribute('data-caret-active');
			}
		}
		const anchor = locateOffsetInDOM(rootEl, sel.anchor.path, sel.anchor.offset);
		const head = locateOffsetInDOM(rootEl, sel.head.path, sel.head.offset);
		if (!anchor || !head) return;
		try {
			selection.removeAllRanges();
			const range = rootEl.ownerDocument.createRange();
			range.setStart(anchor.node, anchor.offset);
			range.setEnd(head.node, head.offset);
			// If anchor != head visually different, use addRange but extend
			if (anchor.node !== head.node || anchor.offset !== head.offset) {
				selection.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
			} else {
				selection.addRange(range);
			}
		} catch {
			/* ignore */
		}
	}

	function readSelectionFromDOM(): PSelection | null {
		const win = root.ownerDocument.defaultView ?? window;
		const sel = win.getSelection();
		if (!sel || sel.rangeCount === 0) return null;
		if (!root.contains(sel.anchorNode)) return null;
		const anchor = locatePathOffsetFromNode(root, sel.anchorNode!, sel.anchorOffset);
		const head = locatePathOffsetFromNode(root, sel.focusNode!, sel.focusOffset);
		if (!anchor || !head) return null;
		return { anchor, head };
	}

	// ---- Event wiring ----
	function selectionInIsolated(): HTMLElement | null {
		const sel = root.ownerDocument.getSelection();
		if (!sel || sel.rangeCount === 0) return null;
		return isolatedAncestor(sel.anchorNode);
	}

	const onSelectionChange = () => {
		if (updating || composing) return;
		// Skip selection sync when the caret lives inside an isolated subtree
		// (e.g. an image caption). The doc's selection stays at whatever
		// block was last focused; mapping the caret to a (path, offset) on
		// the host block would corrupt subsequent typing.
		if (selectionInIsolated()) return;
		const sel = readSelectionFromDOM();
		if (!sel) return;
		const state = opts.getState();
		const cur = state.selection;
		// avoid feedback loop
		if (
			cur.anchor.offset === sel.anchor.offset &&
			cur.head.offset === sel.head.offset &&
			pathsEqual(cur.anchor.path, sel.anchor.path) &&
			pathsEqual(cur.head.path, sel.head.path)
		)
			return;
		const t = createSelTx(opts, sel);
		opts.dispatch(t);
	};

	root.ownerDocument.addEventListener('selectionchange', onSelectionChange);

	// Click-anywhere clears any prior block-selection. Selection itself
	// is now driven exclusively by the drag-handle click (see
	// `ensureBlockHandles`); clicking the block body — even on atomic
	// blocks — falls through to native behavior (caret placement on
	// text blocks, no-op on atomic ones). Isolated subtrees (caption,
	// resize handle, toolbar) get native handling and must NOT clear
	// selection on a sibling.
	// Marquee (rubber-band) selection. Pointerdown in the editor's
	// "empty" area — root background, between/below blocks, or in the
	// left gutter — starts a drag that builds a multi-block selection
	// by hit-testing each block's bounding box against the marquee
	// rect. Suppresses the native caret placement so the user gets a
	// clean rubber-band gesture matching Notion.
	let marquee:
		| {
				pointerId: number;
				startX: number;
				startY: number;
				overlay: HTMLDivElement;
				baseSet: Set<string>; // selection at marquee-start, for additive shift+drag
				additive: boolean;
		  }
		| null = null;
	const onRootPointerDown = (ev: PointerEvent) => {
		const targetNode = ev.target as Node | null;
		if (isolatedAncestor(targetNode)) return;
		// The drag handle's own pointerdown handler stopPropagation's
		// before this listener sees it (so a handle click won't clear
		// the selection it just established).
		const targetEl = targetNode instanceof Element ? targetNode : null;
		const inBlock = targetEl?.closest?.(`[${DATA_BLOCK_ID}]`);
		const inHandle = targetEl?.closest?.('.plim-block-handles');
		if (!opts.readonly && !inBlock && !inHandle && ev.button === 0) {
			// Empty-space click. Start a marquee. Don't preventDefault
			// yet — we only do that on the first pointermove that
			// crosses the threshold so an idle click still clears
			// selection like before.
			const overlay = document.createElement('div');
			overlay.className = 'plim-marquee';
			overlay.setAttribute('contenteditable', 'false');
			overlay.style.position = 'absolute';
			overlay.style.pointerEvents = 'none';
			overlay.style.zIndex = '5';
			overlay.style.background = 'rgba(35,131,226,0.10)';
			overlay.style.border = '1px solid rgba(35,131,226,0.35)';
			overlay.style.borderRadius = '2px';
			overlay.style.display = 'none';
			root.appendChild(overlay);
			marquee = {
				pointerId: ev.pointerId,
				startX: ev.clientX,
				startY: ev.clientY,
				overlay,
				baseSet: ev.shiftKey || ev.metaKey || ev.ctrlKey ? new Set(selection.ids) : new Set(),
				additive: ev.shiftKey || ev.metaKey || ev.ctrlKey,
			};
			try {
				root.setPointerCapture(ev.pointerId);
			} catch {
				/* ignored in some test environments */
			}
		}
		if (!marquee) selectionClear();
	};
	const onRootPointerMove = (ev: PointerEvent) => {
		if (!marquee || ev.pointerId !== marquee.pointerId) return;
		const dx = ev.clientX - marquee.startX;
		const dy = ev.clientY - marquee.startY;
		// Don't clear caret/selection until we've moved past the threshold —
		// idle pointerdowns shouldn't visually start a marquee.
		const threshold = 16;
		const movedEnough = dx * dx + dy * dy > threshold;
		if (!movedEnough) return;
		// First crossing of the threshold: prevent the default text
		// selection / caret placement and clear any prior selection so
		// we have a clean canvas (unless additive).
		if (marquee.overlay.style.display === 'none') {
			marquee.overlay.style.display = 'block';
			ev.preventDefault();
			if (!marquee.additive) selectionClear();
			root.ownerDocument.getSelection()?.removeAllRanges();
		}
		const rootRect = root.getBoundingClientRect();
		const x1 = Math.min(marquee.startX, ev.clientX);
		const x2 = Math.max(marquee.startX, ev.clientX);
		const y1 = Math.min(marquee.startY, ev.clientY);
		const y2 = Math.max(marquee.startY, ev.clientY);
		marquee.overlay.style.left = `${x1 - rootRect.left}px`;
		marquee.overlay.style.top = `${y1 - rootRect.top}px`;
		marquee.overlay.style.width = `${x2 - x1}px`;
		marquee.overlay.style.height = `${y2 - y1}px`;
		// Hit-test top-level blocks only — selecting nested blocks via
		// marquee tends to feel unpredictable to users (and parent
		// selection visually covers descendants anyway).
		const ids = new Set<string>(marquee.baseSet);
		for (const el of root.querySelectorAll<HTMLElement>(`:scope > [${DATA_BLOCK_ID}]`)) {
			const r = el.getBoundingClientRect();
			const intersects = r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2;
			if (intersects) {
				const id = el.getAttribute(DATA_BLOCK_ID);
				if (id) ids.add(id);
			}
		}
		// Anchor = first block to enter the marquee, active = last;
		// arbitrary but consistent for shift+arrow extension afterwards.
		const arr = Array.from(ids);
		selectionSet(arr, arr[0] ?? null, arr[arr.length - 1] ?? null);
	};
	const onRootPointerUp = (ev: PointerEvent) => {
		if (!marquee || ev.pointerId !== marquee.pointerId) return;
		try {
			root.releasePointerCapture(marquee.pointerId);
		} catch {
			/* noop */
		}
		marquee.overlay.remove();
		marquee = null;
	};
	root.addEventListener('pointerdown', onRootPointerDown);
	root.addEventListener('pointermove', onRootPointerMove);
	root.addEventListener('pointerup', onRootPointerUp);
	root.addEventListener('pointercancel', onRootPointerUp);

	const onBeforeInput = (ev: InputEvent) => {
		if (composing) return;
		const type = ev.inputType;
		// Isolated subtree handling. The browser's native contenteditable
		// owns the input — we only intercept structural keys (Enter:
		// exit the region and create a paragraph after the host block;
		// Shift+Enter / line break: swallow). Everything else (text,
		// delete, replace) is left to the browser; the host of the
		// isolated region (e.g. caption blur handler) syncs back to
		// `attrs` when focus leaves.
		const targetNode = (ev.target as Node | null) ?? null;
		const iso = isolatedAncestor(targetNode) ?? (function () {
			const sel = root.ownerDocument.getSelection();
			return sel && sel.rangeCount > 0 ? isolatedAncestor(sel.anchorNode) : null;
		})();
		if (iso) {
			if (type === 'insertParagraph') {
				ev.preventDefault();
				handleIsolatedExit(opts, iso);
				return;
			}
			if (type === 'insertLineBreak') {
				ev.preventDefault();
				return;
			}
			// Let the browser handle text/delete natively inside the region.
			return;
		}
		// Enter
		if (type === 'insertParagraph') {
			ev.preventDefault();
			handleInsertParagraph(opts);
			return;
		}
		if (type === 'insertLineBreak') {
			ev.preventDefault();
			handleInsertLineBreak(opts);
			return;
		}
		if (type === 'insertText') {
			const text = ev.data ?? '';
			if (text) {
				ev.preventDefault();
				opts.onBeforeInput(text);
			}
			return;
		}
		if (type === 'insertReplacementText') {
			ev.preventDefault();
			const text = ev.data ?? '';
			if (text) opts.onBeforeInput(text);
			return;
		}
		if (type === 'deleteContentBackward') {
			ev.preventDefault();
			handleDeleteBackward(opts);
			return;
		}
		if (type === 'deleteContentForward') {
			ev.preventDefault();
			handleDeleteForward(opts);
			return;
		}
		if (type === 'deleteWordBackward') {
			ev.preventDefault();
			handleDeleteWordBackward(opts);
			return;
		}
		if (type === 'deleteWordForward') {
			ev.preventDefault();
			handleDeleteWordForward(opts);
			return;
		}
		if (type === 'deleteSoftLineBackward' || type === 'deleteHardLineBackward') {
			ev.preventDefault();
			handleDeleteLineBackward(opts);
			return;
		}
		if (type === 'deleteSoftLineForward' || type === 'deleteHardLineForward') {
			ev.preventDefault();
			handleDeleteLineForward(opts);
			return;
		}
		if (type === 'insertFromPaste') {
			// allow our paste handler to run
			return;
		}
		// Default: prevent so we control the doc
		ev.preventDefault();
	};
	root.addEventListener('beforeinput', onBeforeInput);

	const onKeyDown = (ev: KeyboardEvent) => {
		// Block-selected mode swallows almost everything: arrows move the
		// caret out of the block, Backspace/Delete remove it, Escape
		// clears the selection. Any other key clears block selection and
		// (for a printable key) lets the action panel / shortcut layer
		// run; users typically don't expect to start typing into nothing
		// while a block is selected, so we don't auto-create a paragraph.
		if (selection.ids.size > 0) {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				selectionClear();
				return;
			}
			if (ev.key === 'Backspace' || ev.key === 'Delete') {
				ev.preventDefault();
				deleteSelectedBlocks();
				return;
			}
			// Shift+ArrowUp/Down extends the selection from the anchor.
			if (ev.shiftKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
				ev.preventDefault();
				selectionExtend(ev.key === 'ArrowUp' ? 'before' : 'after');
				return;
			}
			if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
				ev.preventDefault();
				moveCaretFromBlockSelection('before');
				return;
			}
			if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
				ev.preventDefault();
				moveCaretFromBlockSelection('after');
				return;
			}
			// Modifiers alone shouldn't drop the selection (user might be
			// composing a shortcut).
			if (ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Meta' || ev.key === 'Alt') return;
			// Cmd/Ctrl+A while in block-selection mode: select all blocks.
			if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'a' || ev.key === 'A')) {
				ev.preventDefault();
				const flat = flattenBlocks(opts.getState().doc);
				if (flat.length > 0) {
					const ids = flat.map((e) => e.block.id);
					selectionSet(ids, ids[0]!, ids[ids.length - 1]!);
				}
				return;
			}
			// Anything else: drop block selection and fall through to
			// normal handling (no caret will be set; the action layer
			// can still react to shortcuts).
			selectionClear();
		}
		// Arrow into atomic neighbours from text. ArrowUp at offset 0
		// when the previous sibling is atomic selects it. ArrowDown at
		// the end of the block when the next sibling is atomic selects
		// it. We deliberately key off offset/length rather than visual
		// line position to keep this rule simple — multi-line wrapped
		// paragraphs walk through their own offsets first before the
		// rule fires.
		if (!opts.readonly && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.isComposing && !ev.shiftKey) {
			const state = opts.getState();
			const sel = state.selection;
			if (pathsEqual(sel.head.path, sel.anchor.path)) {
				const path = sel.head.path;
				const block = blockAt(state.doc.children, path);
				if (ev.key === 'ArrowUp' && sel.head.offset === 0) {
					const last = path[path.length - 1] ?? 0;
					if (last > 0) {
						const prevPath = [...path.slice(0, -1), last - 1];
						const prev = blockAt(state.doc.children, prevPath);
						if (prev && prev.text === undefined) {
							ev.preventDefault();
							selectionReplaceWith(prev.id);
							return;
						}
					}
				}
				if (ev.key === 'ArrowDown' && block && sel.head.offset >= blockTextLength(block)) {
					const flat = flattenBlocks(state.doc);
					const idx = flat.findIndex((e) => pathsEqual(e.path, path));
					const next = idx >= 0 ? flat[idx + 1] : undefined;
					if (next && next.block.text === undefined) {
						ev.preventDefault();
						selectionReplaceWith(next.block.id);
						return;
					}
				}
			}
		}
		// Isolated regions: let the browser handle keyboard input natively.
		// Specifically, Backspace/Delete inside an image caption deletes
		// caption text, not the host block. Shortcuts (Mod+B, etc.) are
		// also dropped — captions intentionally don't participate in mark
		// toggling for now.
		if (selectionInIsolated()) return;
		// Some modifier+Backspace/Delete combos don't reliably fire `beforeinput`
		// in Chrome (e.g. Option+Shift+Backspace on macOS isn't a standard text-
		// editing binding), so intercept them at the keydown layer. We mirror
		// macOS conventions where possible:
		//   Backspace                                 → delete one char back   (handled by beforeinput)
		//   Option+Backspace                          → delete word back        (beforeinput)
		//   Cmd+Backspace                             → delete to line/block start
		//   Option+Shift+Backspace                    → delete to line/block start
		//   Forward variants mirror the same shape.
		if (!opts.readonly && (ev.key === 'Backspace' || ev.key === 'Delete') && !ev.isComposing) {
			const isLineBack =
				ev.key === 'Backspace' &&
				((isMacLike() && ev.metaKey && !ev.ctrlKey) ||
					(ev.altKey && ev.shiftKey && !ev.metaKey && !ev.ctrlKey));
			const isLineFwd =
				ev.key === 'Delete' &&
				((isMacLike() && ev.metaKey && !ev.ctrlKey) ||
					(ev.altKey && ev.shiftKey && !ev.metaKey && !ev.ctrlKey));
			if (isLineBack) {
				ev.preventDefault();
				handleDeleteLineBackward(opts);
				return;
			}
			if (isLineFwd) {
				ev.preventDefault();
				handleDeleteLineForward(opts);
				return;
			}
		}
		opts.onKeyboardEvent(ev);
	};
	root.addEventListener('keydown', onKeyDown);

	const onCompositionStart = () => {
		composing = true;
	};
	const onCompositionEnd = (ev: CompositionEvent) => {
		composing = false;
		const text = ev.data;
		if (text) opts.onBeforeInput(text);
		// re-render to clean DOM that browser mutated during composition
		render(opts.getState());
	};
	root.addEventListener('compositionstart', onCompositionStart);
	root.addEventListener('compositionend', onCompositionEnd);

	const onCopy = (ev: ClipboardEvent) => {
		opts.onClipboardEvent('copy', ev);
		if (ev.defaultPrevented) return;
		performClipboardCopyOrCut(ev, false);
	};
	const onCut = (ev: ClipboardEvent) => {
		opts.onClipboardEvent('cut', ev);
		if (ev.defaultPrevented) return;
		performClipboardCopyOrCut(ev, true);
	};
	function performClipboardCopyOrCut(ev: ClipboardEvent, isCut: boolean): void {
		if (!ev.clipboardData) return;
		const state = opts.getState();
		// Two slice shapes (see clipboard.ts). For a same-block text range we
		// only intercept on cut (so we can drive the deletion); copy stays
		// native so partial-text copy keeps inline-only fidelity (no surprise
		// block prefixes like `> ` for a quote when only a few words were
		// selected).
		let slice: BlockNode[] | null = null;
		let scope: 'block-set' | 'cross-range' | 'same-block' | null = null;
		let rangeInfo: { start: { path: number[]; offset: number }; end: { path: number[]; offset: number } } | null = null;
		if (selection.ids.size > 0) {
			const blocks = sliceFromBlockSelection(state.doc, selection.ids);
			if (blocks.length > 0) {
				slice = blocks;
				scope = 'block-set';
			}
		} else {
			const r = sliceFromTextRange(state.doc, state.selection);
			if (r) {
				slice = r.blocks;
				scope = 'cross-range';
				rangeInfo = { start: r.start, end: r.end };
			} else if (isCut) {
				// Same-block range cut: collapsed selections have nothing to do;
				// non-collapsed selections fall through to the in-block delete
				// path below. We still want to write markdown for the in-block
				// content so external apps receive the marked-up text.
				const sel = state.selection;
				if (!(pathsEqual(sel.anchor.path, sel.head.path) && sel.anchor.offset === sel.head.offset)) {
					const block = blockAt(state.doc.children, sel.head.path);
					if (block?.text) {
						const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
						const toOff = Math.max(sel.anchor.offset, sel.head.offset);
						const clone: BlockNode = { id: newId('b'), type: block.type, text: sliceTextSpansLocal(block.text, fromOff, toOff) };
						if (block.attrs) clone.attrs = { ...block.attrs };
						slice = [clone];
						scope = 'same-block';
					}
				}
			}
		}
		if (!slice || !scope) return;
		writeClipboardMarkdown(ev, slice, opts.blocks);
		ev.preventDefault();
		if (!isCut) return;
		if (scope === 'block-set') {
			deleteSelectedBlocks();
		} else if (scope === 'same-block') {
			deleteSelectionIfAny(opts);
		} else if (scope === 'cross-range' && rangeInfo) {
			deleteCrossBlockRange(rangeInfo.start, rangeInfo.end);
		}
	}
	function sliceTextSpansLocal(spans: TextSpan[], from: number, to: number): TextSpan[] {
		if (from >= to) return [];
		const out: TextSpan[] = [];
		let off = 0;
		for (const s of spans) {
			const end = off + s.text.length;
			if (end <= from) {
				off = end;
				continue;
			}
			if (off >= to) break;
			const a = Math.max(from, off) - off;
			const b = Math.min(to, end) - off;
			const sliced = s.text.slice(a, b);
			if (sliced.length > 0) {
				const span: TextSpan = { text: sliced };
				if (s.marks) span.marks = s.marks.map((m) => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type }));
				out.push(span);
			}
			off = end;
		}
		return out;
	}
	function deleteCrossBlockRange(start: { path: number[]; offset: number }, end: { path: number[]; offset: number }): void {
		// Compose: trim start tail, trim end head, remove every "outermost"
		// middle block in reverse doc-order, then joinBackward end into start.
		// "Outermost" excludes any middle whose ancestor is also a middle —
		// removing the ancestor takes the descendant with it, so listing both
		// would mean operating on a path that no longer exists.
		const state = opts.getState();
		const flat = flattenBlocks(state.doc);
		const startIdx = flat.findIndex((e) => pathsEqual(e.path, start.path));
		const endIdx = flat.findIndex((e) => pathsEqual(e.path, end.path));
		if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return;
		const startBlock = flat[startIdx]!.block;
		const startLen = startBlock.text !== undefined ? blockTextLength(startBlock) : 0;
		const middleEntries = flat.slice(startIdx + 1, endIdx);
		// Keep only outermost middles.
		const middles: number[][] = [];
		for (const m of middleEntries) {
			const isUnderAnother = middleEntries.some(
				(o) => o !== m && o.path.length < m.path.length && o.path.every((seg, i) => seg === m.path[i]),
			);
			if (!isUnderAnother) middles.push(m.path.slice());
		}
		const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
		// 1. Trim start tail.
		if (startBlock.text !== undefined && start.offset < startLen) {
			tx.replaceRange(start.path, start.offset, startLen, []);
		}
		// 2. Trim end head.
		const endBlock = flat[endIdx]!.block;
		if (endBlock.text !== undefined && end.offset > 0) {
			tx.replaceRange(end.path, 0, end.offset, []);
		}
		// 3. Remove middles in reverse doc-order.
		const removeOrder = [...middles].sort((a, b) => comparePaths(b, a));
		for (const p of removeOrder) tx.removeBlock(p);
		// 4. Join end into start. End's path needs adjustment for prior removals.
		const adjustedEndPath = adjustPathAfterRemovals(end.path, middles);
		tx.joinBackward(adjustedEndPath);
		tx.setSelection({ anchor: { path: start.path, offset: start.offset }, head: { path: start.path, offset: start.offset } });
		tx.commit();
	}
	const onPaste = (ev: ClipboardEvent) => {
		const data = ev.clipboardData;
		const text = data?.getData('text/plain') ?? '';
		const html = data?.getData('text/html') ?? '';
		// `application/x-plim` is the lossless plim-native channel. When the
		// source clipboard came from another plim editor, this carries the
		// full BlockNode[] JSON (versioned), preserving types/attrs/nesting
		// that markdown can't roundtrip without per-descriptor fromMarkdown
		// hooks. The paste pipeline checks this first.
		const plimRaw = data?.getData('application/x-plim') ?? '';
		const files = data?.files ? Array.from(data.files) : [];
		// New pipeline first: if the consumer's handler reports it owned the
		// paste, we're done (preventDefault already covered). Otherwise the
		// legacy text-only path handles plain text (unchanged behaviour for
		// any code path that hasn't opted into the new hook yet).
		if (opts.onPaste) {
			ev.preventDefault();
			const payload: { text: string; html: string; files: File[]; plim?: string } = { text, html, files };
			if (plimRaw) payload.plim = plimRaw;
			const handled = opts.onPaste(payload);
			if (!handled && text) opts.onBeforeInput(text);
		} else if (text) {
			ev.preventDefault();
			opts.onBeforeInput(text);
		}
		opts.onClipboardEvent('paste', ev);
	};
	root.addEventListener('copy', onCopy);
	root.addEventListener('cut', onCut);
	root.addEventListener('paste', onPaste);

	let dropIndicator: HTMLElement | null = null;
	let dropTarget: { el: HTMLElement; before: boolean } | null = null;
	// Track active drag from a block handle. Browsers vary in whether custom
	// `dataTransfer.types` are visible during `dragover` on same-document drags
	// (Chrome strips access in some cases for security). Tracking via a module-
	// scoped flag is reliable and doesn't preclude the type check below for
	// cross-tab/cross-document drops.
	let activeDragSourceId: string | null = null;
	// When the dragged block is part of a multi-block selection, this
	// holds the snapshot of selected ids at drag-start so the commit
	// moves the whole group as a unit. Cleared on drag end alongside
	// `activeDragSourceId`.
	let activeDragSourceIds: string[] | null = null;
	function clearDropIndicator() {
		if (dropIndicator) {
			dropIndicator.remove();
			dropIndicator = null;
		}
		dropTarget = null;
	}
	function showDropIndicatorAt(targetEl: HTMLElement, clientY: number) {
		const draggingEl = root.querySelector('.plim-block--dragging') as HTMLElement | null;
		if (draggingEl && (draggingEl === targetEl || draggingEl.contains(targetEl))) return;
		const rect = targetEl.getBoundingClientRect();
		const before = clientY < rect.top + rect.height / 2;
		if (!dropIndicator) {
			dropIndicator = document.createElement('div');
			dropIndicator.className = 'plim-drop-indicator';
			dropIndicator.setAttribute('contenteditable', 'false');
			root.appendChild(dropIndicator);
		}
		const indRect = root.getBoundingClientRect();
		dropIndicator.style.position = 'absolute';
		dropIndicator.style.left = `${rect.left - indRect.left}px`;
		dropIndicator.style.width = `${rect.width}px`;
		dropIndicator.style.top = `${(before ? rect.top : rect.bottom) - indRect.top - 1}px`;
		dropTarget = { el: targetEl, before };
	}

	function commitMove(sourceIdsInput: string | string[], targetEl: HTMLElement, before: boolean): boolean {
		// Multi-block drag commit. `sourceIdsInput` may be a single id
		// (legacy callers) or an array; we normalise and de-duplicate.
		// The result places every source block at the drop point in
		// their original document order, regardless of whether the user
		// dragged a top-of-selection or middle-of-selection block.
		const targetId = targetEl.getAttribute(DATA_BLOCK_ID);
		if (!targetId) return false;
		const initial = Array.isArray(sourceIdsInput) ? sourceIdsInput : [sourceIdsInput];
		const sourceIds = Array.from(new Set(initial)).filter((id) => id !== targetId);
		if (sourceIds.length === 0) return false;
		const state = opts.getState();
		// Resolve every source's current path and sort by document order
		// so we insert at the destination in a sensible sequence.
		type Resolved = { id: string; path: number[]; block: BlockNode };
		const resolved: Resolved[] = [];
		for (const id of sourceIds) {
			const p = pathOfBlockId(state.doc.children, id, []);
			if (!p) continue;
			const b = blockAt(state.doc.children, p);
			if (!b) continue;
			resolved.push({ id, path: p, block: b });
		}
		if (resolved.length === 0) return false;
		const targetPath = pathOfBlockId(state.doc.children, targetId, []);
		if (!targetPath) return false;
		// Disallow dropping into any source's own subtree.
		for (const s of resolved) {
			if (targetPath.length >= s.path.length && s.path.every((seg, i) => targetPath[i] === seg)) return false;
		}
		// Sort sources by document order for both removal-order
		// computation and the insert sequence at destination.
		resolved.sort((a, b) => comparePaths(a.path, b.path));
		// Compute destination parent path + insert index, accounting for
		// removals that will shift the target.
		const targetParent = targetPath.slice(0, -1);
		const targetLast = targetPath[targetPath.length - 1]!;
		const removedPaths = resolved.map((r) => r.path);
		// Adjust target's last index by how many sibling-removals precede it
		// at the target's parent level.
		let adjustedTargetLast = targetLast;
		for (const rp of removedPaths) {
			if (rp.length !== targetPath.length) continue;
			const sameParent = rp.slice(0, -1).every((seg, i) => targetParent[i] === seg);
			if (!sameParent) continue;
			if (rp[rp.length - 1]! < adjustedTargetLast) adjustedTargetLast--;
		}
		// Adjust the parent path itself for any removals at shallower
		// levels that are ancestors of/before the target.
		const adjustedParent = adjustPathAfterRemovals(targetParent, removedPaths);
		const insertBaseIdx = before ? adjustedTargetLast : adjustedTargetLast + 1;
		// Detect single-block no-op: same parent and dropping in current location.
		if (resolved.length === 1) {
			const r = resolved[0]!;
			const sameParent = r.path.length === targetPath.length && r.path.slice(0, -1).every((seg, i) => targetPath[i] === seg);
			if (sameParent) {
				const fromLast = r.path[r.path.length - 1]!;
				let insertIdx = before ? targetLast : targetLast + 1;
				if (fromLast < targetLast) insertIdx -= 1;
				if (insertIdx === fromLast) return false;
			}
		}
		const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
		// Remove in reverse document order so earlier paths stay valid.
		const removeOrder = [...resolved].sort((a, b) => comparePaths(b.path, a.path));
		for (const r of removeOrder) tx.removeBlock(r.path);
		// Insert each source at the destination in document order.
		// Snapshot block content before transaction is committed so we
		// don't risk reading mutated references later.
		for (let i = 0; i < resolved.length; i++) {
			const insertPath = [...adjustedParent, insertBaseIdx + i];
			tx.insertBlock(insertPath, resolved[i]!.block);
		}
		tx.commit();
		return true;
	}

	const onDragOver = (ev: DragEvent) => {
		if (opts.readonly) return;
		// Accept the drop if either we know about an active block drag from this
		// view, or the dataTransfer advertises our custom type (cross-document).
		const types = ev.dataTransfer?.types;
		const hasOurType = !!types && Array.from(types).includes('application/x-plim-block');
		if (!activeDragSourceId && !hasOurType) return;
		const targetEl = (ev.target as HTMLElement | null)?.closest?.(`[${DATA_BLOCK_ID}]`) as HTMLElement | null;
		if (!targetEl || !root.contains(targetEl)) return;
		ev.preventDefault();
		if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
		showDropIndicatorAt(targetEl, ev.clientY);
	};
	const onDrop = (ev: DragEvent) => {
		if (opts.readonly) return clearDropIndicator();
		const sourceId = activeDragSourceId ?? ev.dataTransfer?.getData('application/x-plim-block');
		if (!sourceId || !dropTarget) {
			activeDragSourceId = null;
			activeDragSourceIds = null;
			return clearDropIndicator();
		}
		ev.preventDefault();
		const target = dropTarget.el;
		const before = dropTarget.before;
		clearDropIndicator();
		commitMove(activeDragSourceIds ?? [sourceId], target, before);
		activeDragSourceId = null;
		activeDragSourceIds = null;
	};
	const onDragLeave = (ev: DragEvent) => {
		if (ev.target === root || (ev.relatedTarget && !root.contains(ev.relatedTarget as Node))) {
			clearDropIndicator();
		}
	};
	root.addEventListener('dragover', onDragOver);
	root.addEventListener('drop', onDrop);
	root.addEventListener('dragleave', onDragLeave);
	root.addEventListener('dragend', clearDropIndicator);
	const onPlimDragStart = (ev: Event) => {
		const detail = (ev as CustomEvent<{ id: string }>).detail;
		if (!detail?.id) return;
		activeDragSourceId = detail.id;
		// If the dragged block is part of the current multi-selection,
		// drag the whole group; otherwise treat this as a single-block
		// drag and replace the selection so the visual selection
		// matches the drag set (Notion's behaviour).
		if (selection.ids.has(detail.id) && selection.ids.size > 1) {
			activeDragSourceIds = Array.from(selection.ids);
		} else {
			activeDragSourceIds = [detail.id];
			if (!selection.ids.has(detail.id)) selectionReplaceWith(detail.id);
		}
	};
	const onPlimDragEnd = () => {
		activeDragSourceId = null;
		activeDragSourceIds = null;
		clearDropIndicator();
	};
	root.addEventListener('plim:dragstart', onPlimDragStart);
	root.addEventListener('plim:dragend', onPlimDragEnd);

	// Pointer-event-driven custom drag for the handle button. HTML5 drag inside
	// a `contenteditable=true` root is unreliable in Chrome — `dragstart` often
	// doesn't fire even from a `draggable=true` button — so the handle uses
	// pointer capture + elementFromPoint to drive `showDropIndicatorAt` and
	// `commitMove` directly. Native dragover/drop above is kept for cross-
	// document drops (text or files dragged in from elsewhere).
	const onPlimCustomDragMove = (ev: Event) => {
		if (opts.readonly || !activeDragSourceId) return;
		const detail = (ev as CustomEvent<{ clientX: number; clientY: number }>).detail;
		if (!detail) return;
		const under = root.ownerDocument.elementFromPoint(detail.clientX, detail.clientY) as HTMLElement | null;
		const targetEl = under?.closest?.(`[${DATA_BLOCK_ID}]`) as HTMLElement | null;
		if (!targetEl || !root.contains(targetEl)) return;
		showDropIndicatorAt(targetEl, detail.clientY);
	};
	const onPlimCustomDragCommit = (ev: Event) => {
		const cancelled = (ev as CustomEvent<{ cancelled?: boolean }>).detail?.cancelled;
		if (!cancelled && activeDragSourceId && dropTarget) {
			commitMove(activeDragSourceIds ?? [activeDragSourceId], dropTarget.el, dropTarget.before);
		}
		activeDragSourceId = null;
		activeDragSourceIds = null;
		clearDropIndicator();
	};
	root.addEventListener('plim:custom-drag-move', onPlimCustomDragMove);
	root.addEventListener('plim:custom-drag-end', onPlimCustomDragCommit);
	// Click-on-handle (pointerdown→pointerup without crossing drag
	// threshold) selects the block. Works for both text and atomic
	// blocks; the visual outline is identical (CSS rules off
	// `[data-plim-block-selected="true"]`). Subsequent text-block click
	// or Escape clears it.
	const onHandleClick = (e: Event) => {
		const detail = (e as CustomEvent<{ id?: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }>).detail;
		const id = detail?.id ?? null;
		if (!id) return;
		// Shift = inclusive range from anchor (or just-clicked id if no anchor).
		// Meta/Ctrl = toggle this id in/out of the set.
		// Plain = replace selection with this single id (matches Notion).
		if (detail?.shiftKey && selection.ids.size > 0) {
			selectionRange(id);
			return;
		}
		if (detail?.metaKey || detail?.ctrlKey) {
			selectionToggle(id);
			return;
		}
		selectionReplaceWith(id);
	};
	root.addEventListener('plim:handle-click', onHandleClick);
	root.style.position = 'relative';

	return {
		root,
		update(state) {
			render(state);
		},
		focus() {
			root.focus();
		},
		destroy() {
			root.ownerDocument.removeEventListener('selectionchange', onSelectionChange);
			root.removeEventListener('pointerdown', onRootPointerDown);
			root.removeEventListener('pointermove', onRootPointerMove);
			root.removeEventListener('pointerup', onRootPointerUp);
			root.removeEventListener('pointercancel', onRootPointerUp);
			root.removeEventListener('beforeinput', onBeforeInput);
			root.removeEventListener('keydown', onKeyDown);
			root.removeEventListener('compositionstart', onCompositionStart);
			root.removeEventListener('compositionend', onCompositionEnd);
			root.removeEventListener('copy', onCopy);
			root.removeEventListener('cut', onCut);
			root.removeEventListener('paste', onPaste);
			root.removeEventListener('dragover', onDragOver);
			root.removeEventListener('drop', onDrop);
			root.removeEventListener('dragleave', onDragLeave);
			root.removeEventListener('dragend', clearDropIndicator);
			root.removeEventListener('plim:dragstart', onPlimDragStart);
			root.removeEventListener('plim:dragend', onPlimDragEnd);
			root.removeEventListener('plim:custom-drag-move', onPlimCustomDragMove);
			root.removeEventListener('plim:custom-drag-end', onPlimCustomDragCommit);
			root.removeEventListener('plim:handle-click', onHandleClick);
			clearDropIndicator();
			root.remove();
		},
	};
}

// ---- helpers ---------------------------------------------------------------

function createSelTx(opts: ViewOptions, sel: PSelection): Transaction {
	// Use editor's createTransaction so listeners see it; mark no-history
	const editor = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor;
	const tx = editor.createTransaction();
	tx.setSelection(sel);
	(tx.meta as Record<string, unknown>).addToHistory = false;
	(tx.meta as Record<string, unknown>).source = 'selectionchange';
	return tx;
}

function pathsEqual(a: number[], b: number[]) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// Render functions ----------------------------------------------------------

function blockClassFor(type: string): string {
	return `plim-block plim-block-${type}`;
}

function tagFor(type: string, attrs: Record<string, unknown> | undefined): string {
	switch (type) {
		case 'heading': {
			const lvl = (attrs?.level as number) ?? 1;
			return `h${Math.min(3, Math.max(1, lvl))}`;
		}
		case 'bulleted_list_item':
		case 'numbered_list_item':
		case 'to_do':
		case 'toggle':
			return 'div';
		case 'quote':
			return 'div';
		case 'code':
			// Wrapper is a `<div>`; the inner `<pre><code>` is built in
			// the render switch. Using a `<div>` lets the absolutely-
			// positioned drag handles escape `<pre>`'s `overflow-x: auto`
			// clipping, which would otherwise hide them in the gutter.
			return 'div';
		case 'divider':
			return 'div';
		default:
			return 'div';
	}
}

function ensureTag(existing: HTMLElement | null, tag: string): HTMLElement {
	if (existing && existing.tagName.toLowerCase() === tag) return existing;
	return document.createElement(tag);
}

function renderBlocks(parent: HTMLElement, nodes: BlockNode[], opts: ViewOptions, depth = 0) {
	// Maintain children by id
	const desired = new Map<string, BlockNode>();
	const order: string[] = [];
	for (const n of nodes) {
		desired.set(n.id, n);
		order.push(n.id);
	}
	// Remove unwanted
	const toRemove: HTMLElement[] = [];
	for (const child of Array.from(parent.children)) {
		if (!(child instanceof HTMLElement)) continue;
		if (!child.hasAttribute(DATA_BLOCK_ID)) continue;
		const id = child.getAttribute(DATA_BLOCK_ID)!;
		if (!desired.has(id)) toRemove.push(child);
	}
	for (const r of toRemove) r.remove();

	// Iterate desired order, reorder/create as needed
	let cursorNode: ChildNode | null = parent.firstChild;
	// Running counter for contiguous numbered_list_item siblings. Resets to 0
	// whenever a non-numbered block breaks the run, so each fresh "list" starts
	// at 1 and successive items enumerate 2, 3, … as expected.
	let numberedRun = 0;
	for (const id of order) {
		const node = desired.get(id)!;
		let el = Array.from(parent.children).find((c) => c instanceof HTMLElement && c.getAttribute(DATA_BLOCK_ID) === id) as HTMLElement | undefined;
		const tag = tagFor(node.type, node.attrs);
		if (el && el.tagName.toLowerCase() !== tag) {
			if (cursorNode === el) cursorNode = el.nextSibling;
			el.remove();
			el = undefined;
		}
		if (!el) {
			el = document.createElement(tag);
			el.setAttribute(DATA_BLOCK_ID, id);
		}
		// Insert at right position
		if (cursorNode !== el) {
			if (cursorNode && cursorNode.parentNode !== parent) cursorNode = null;
			parent.insertBefore(el, cursorNode);
		}
		cursorNode = el.nextSibling;
		const listIndex = node.type === 'numbered_list_item' ? ++numberedRun : (numberedRun = 0);
		updateBlockElement(el, node, opts, depth, listIndex);
	}
}

function ensureBlockHandles(el: HTMLElement, opts: ViewOptions) {
	if (opts.readonly) return;
	let group = el.querySelector(':scope > .plim-block-handles') as HTMLElement | null;
	if (!group) {
		group = document.createElement('div');
		group.className = 'plim-block-handles';
		group.setAttribute('contenteditable', 'false');
		const add = document.createElement('button');
		add.type = 'button';
		add.className = 'plim-block-add';
		add.setAttribute('aria-label', 'Add block below');
		add.textContent = '+';
		add.addEventListener('mousedown', (e) => e.preventDefault());
		add.addEventListener('click', (e) => {
			e.preventDefault();
			const id = el.getAttribute(DATA_BLOCK_ID);
			if (!id) return;
			const state = opts.getState();
			const path = pathOfBlockId(state.doc.children, id, []);
			if (!path) return;
			const newPath = [...path.slice(0, -1), path[path.length - 1]! + 1];
			const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
			tx.insertBlock(newPath, { id: newId(), type: 'paragraph', text: [] });
			tx.setSelection({ anchor: { path: newPath, offset: 0 }, head: { path: newPath, offset: 0 } });
			tx.commit();
		});
		const drag = document.createElement('button');
		drag.type = 'button';
		drag.className = 'plim-block-drag';
		drag.setAttribute('aria-label', 'Drag to move');
		drag.setAttribute('contenteditable', 'false');
		drag.textContent = '⋮⋮';
		// Don't transfer focus or interrupt selection on pointerdown — the editor
		// root is contenteditable, so a normal mousedown would otherwise move the
		// caret into a non-editable spot.
		drag.addEventListener('mousedown', (e) => {
			e.preventDefault();
			e.stopPropagation();
		});

		// Custom pointer-driven drag. HTML5 drag-and-drop is unreliable from a
		// `draggable=true` button inside a contenteditable root (Chrome often
		// never fires `dragstart`). Pointer capture is rock-solid across
		// browsers and gives us full control over the drag UI.
		let session:
			| { id: string; pointerId: number; startX: number; startY: number; started: boolean }
			| null = null;
		const startThresholdSq = 16; // ~4px movement before drag begins

		const onPointerDown = (e: PointerEvent) => {
			if (e.button !== 0) return;
			const id = el.getAttribute(DATA_BLOCK_ID);
			if (!id) return;
			e.preventDefault();
			e.stopPropagation();
			session = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false };
			try {
				drag.setPointerCapture(e.pointerId);
			} catch {
				/* unsupported in some test environments */
			}
		};
		const onPointerMove = (e: PointerEvent) => {
			if (!session || e.pointerId !== session.pointerId) return;
			if (!session.started) {
				const dx = e.clientX - session.startX;
				const dy = e.clientY - session.startY;
				if (dx * dx + dy * dy < startThresholdSq) return;
				session.started = true;
				el.classList.add('plim-block--dragging');
				el.dispatchEvent(new CustomEvent('plim:dragstart', { bubbles: true, detail: { id: session.id } }));
			}
			el.dispatchEvent(
				new CustomEvent('plim:custom-drag-move', {
					bubbles: true,
					detail: { clientX: e.clientX, clientY: e.clientY },
				})
			);
		};
		const finishSession = (cancelled: boolean, mods?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
			if (!session) return;
			const wasActive = session.started;
			const sessionId = session.id;
			try {
				drag.releasePointerCapture(session.pointerId);
			} catch {
				/* noop */
			}
			session = null;
			if (wasActive) {
				el.classList.remove('plim-block--dragging');
				el.dispatchEvent(new CustomEvent('plim:custom-drag-end', { bubbles: true, detail: { cancelled } }));
			} else if (!cancelled) {
				// Pointerup without crossing the drag threshold = a click
				// on the handle. Notify the view so it can update block
				// selection — modifier flags drive shift+click range and
				// meta/ctrl+click toggle, matching Notion's UX.
				el.dispatchEvent(
					new CustomEvent('plim:handle-click', {
						bubbles: true,
						detail: {
							id: sessionId,
							shiftKey: mods?.shiftKey ?? false,
							metaKey: mods?.metaKey ?? false,
							ctrlKey: mods?.ctrlKey ?? false,
						},
					})
				);
			}
		};
		const onPointerUp = (e: PointerEvent) => {
			if (!session || e.pointerId !== session.pointerId) return;
			finishSession(false, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
		};
		const onPointerCancel = () => finishSession(true);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && session) finishSession(true);
		};

		drag.addEventListener('pointerdown', onPointerDown);
		drag.addEventListener('pointermove', onPointerMove);
		drag.addEventListener('pointerup', onPointerUp);
		drag.addEventListener('pointercancel', onPointerCancel);
		drag.addEventListener('lostpointercapture', onPointerCancel);
		drag.addEventListener('keydown', onKey);
		group.appendChild(add);
		group.appendChild(drag);
		// Insert as the first child so it doesn't disturb selection mapping.
		el.insertBefore(group, el.firstChild);
	}
}

function updateBlockElement(el: HTMLElement, node: BlockNode, opts: ViewOptions, depth: number, listIndex = 0) {
	const prevType = el.getAttribute(DATA_BLOCK_TYPE);
	if (prevType && prevType !== node.type) {
		// Type changed — wipe ALL non-handle / non-children-container content
		// so previous render strategies (custom block chrome, code blocks,
		// images, dividers, etc.) leave no orphaned DOM behind. Without this
		// a `setBlockType` from e.g. `callout` → `paragraph` would leave the
		// callout's `.plim-callout` wrapper in place and `ensureContentChild`
		// would append a fresh empty `[data-block-content]` *after* it,
		// producing a "ghost callout + empty paragraph" hybrid.
		// Preserve `.plim-block-handles` (pointer/keyboard listeners) and
		// `[data-block-children]` (nested blocks) since both are managed
		// independently of the block's type-specific content.
		for (const child of Array.from(el.childNodes)) {
			if (!(child instanceof HTMLElement)) {
				child.remove();
				continue;
			}
			if (child.classList.contains('plim-block-handles')) continue;
			if (child.hasAttribute('data-block-children')) continue;
			child.remove();
		}
		// Drop any cached React-block hosts/slots stashed on the wrapper —
		// the new type's renderer must rebuild from scratch.
		const stash = el as unknown as { __plimReactHost?: HTMLElement; __plimReactContentEl?: HTMLElement };
		delete (stash as Partial<typeof stash>).__plimReactHost;
		delete (stash as Partial<typeof stash>).__plimReactContentEl;
		el.removeAttribute('contenteditable');
		el.removeAttribute('data-checked');
		el.removeAttribute('data-open');
		el.removeAttribute('data-empty');
		// Strip any data-attr-* left over from the previous type's attrs.
		for (const attr of Array.from(el.attributes)) {
			if (attr.name.startsWith('data-attr-')) el.removeAttribute(attr.name);
		}
	}
	el.className = blockClassFor(node.type);
	el.setAttribute(DATA_BLOCK_TYPE, node.type);
	for (const [k, v] of Object.entries(node.attrs ?? {})) {
		el.setAttribute(`data-attr-${k}`, String(v));
	}
	// Hover affordances (skipped for divider since it has no content area)
	if (node.type !== 'divider') {
		ensureBlockHandles(el, opts);
	}
	// Rendering strategies per block
	switch (node.type) {
		case 'divider': {
			el.innerHTML = '';
			el.setAttribute('contenteditable', 'false');
			const hr = document.createElement('hr');
			el.appendChild(hr);
			return;
		}
		case 'code': {
			// Wipe non-handle children, then mount a `<pre><code>` pair
			// as content. The `<pre>` carries the scrollable code-look
			// styles (`white-space: pre-wrap; overflow-x: auto`) while
			// the wrapper `<div>` keeps `overflow: visible` so the drag
			// handles in `.plim-block-handles` (positioned at
			// `left: -3rem`) aren't clipped.
			for (const child of Array.from(el.childNodes)) {
				if (child instanceof HTMLElement && child.classList.contains('plim-block-handles')) continue;
				child.remove();
			}
			const pre = document.createElement('pre');
			const code = document.createElement('code');
			code.setAttribute(DATA_BLOCK_CONTENT, 'true');
			renderTextSpans(code, node.text ?? [], opts.marks);
			pre.appendChild(code);
			el.appendChild(pre);
			return;
		}
		case 'to_do': {
			renderTodo(el, node, opts, depth);
			return;
		}
		case 'bulleted_list_item': {
			renderListItem(el, node, opts, depth, 'bullet');
			return;
		}
		case 'numbered_list_item': {
			renderListItem(el, node, opts, depth, 'number', listIndex);
			return;
		}
		case 'toggle': {
			renderToggle(el, node, opts, depth);
			return;
		}
		case 'quote': {
			renderQuote(el, node, opts, depth);
			return;
		}
		case 'image': {
			renderImage(el, node, opts);
			return;
		}
		case 'embed': {
			renderEmbed(el, node, opts);
			return;
		}
		case 'raw_html': {
			renderRawHTML(el, node, opts);
			return;
		}
		case 'table': {
			renderTable(el, node, opts);
			return;
		}
		default: {
			// Custom block descriptor with `toDOM` or `toComponent` — delegate
			// rendering. `toDOM` wins if both are defined (lets a descriptor
			// supply a DOM fallback for SSR / non-React hosts).
			const desc = opts.blocks.find((b) => b.name === node.type);
			if (desc?.toDOM || (desc?.toComponent && opts.renderReactBlock)) {
				renderCustomBlock(el, node, opts, desc);
				return;
			}
			// generic text block (paragraph, heading)
			ensureContentChild(el, node, opts);
			renderChildBlocks(el, node, opts, depth);
		}
	}
}

function ensureContentChild(el: HTMLElement, node: BlockNode, opts: ViewOptions) {
	let content = el.querySelector(`:scope > [${DATA_BLOCK_CONTENT}]`) as HTMLElement | null;
	if (!content) {
		content = document.createElement('span');
		content.setAttribute(DATA_BLOCK_CONTENT, 'true');
		// Insert content before any data-block-children, after any leading affordances (bullet, check, etc.)
		const childContainer = el.querySelector(`:scope > [data-block-children]`);
		if (childContainer) el.insertBefore(content, childContainer);
		else el.appendChild(content);
	}
	renderTextSpans(content, node.text ?? [], opts.marks);
	if (!node.text || node.text.length === 0) {
		el.setAttribute('data-empty', 'true');
	} else {
		el.removeAttribute('data-empty');
	}
}

// Custom-block render path: the descriptor's `toDOM` returns the entire
// content tree for the block (everything that lives inside the wrapper's
// drag/handles affordance group). The editor pre-renders the block's text
// spans into a `<div data-block-content>` element using the registered mark
// descriptors and exposes it via `payload.content` as `[contentEl]`. The
// descriptor is responsible for placing that content element somewhere in
// its returned tree if it wants the block to be editable; if the block has
// no text (atomic blocks), `payload.content` is an empty array.
//
// If the descriptor instead defines `toComponent` (and the host has provided
// `opts.renderReactBlock`), the view creates a stable host element inside
// the wrapper and hands it to the bridge on every render. React-rendered
// blocks are treated as atomic from the editor's perspective: caret entry
// is disabled (`contenteditable=false`) and the component owns its DOM.
// Editable React blocks are a follow-up; they would require the component
// to render a `[data-block-content]` element that the editor can map text
// into, and the bridge would need to coordinate that.
function renderCustomBlock(el: HTMLElement, node: BlockNode, opts: ViewOptions, desc: BlockDescriptor) {
	// Wipe non-handle children so we can re-render from scratch. Keeping the
	// handle group avoids re-binding pointer/keyboard listeners on every tx.
	for (const child of Array.from(el.childNodes)) {
		if (child instanceof HTMLElement && child.classList.contains('plim-block-handles')) continue;
		child.remove();
	}
	const isEmpty = !node.text || node.text.length === 0;
	const textContent = (node.text ?? []).map((s) => s.text).join('');
	if (desc.toDOM) {
		let contentEl: HTMLElement | null = null;
		if (node.text !== undefined) {
			contentEl = document.createElement('div');
			contentEl.setAttribute(DATA_BLOCK_CONTENT, 'true');
			renderTextSpans(contentEl, node.text, opts.marks);
		}
		const payload: BlockPayload = {
			id: node.id,
			type: node.type,
			attrs: node.attrs ?? {},
			content: contentEl ? [contentEl] : [],
			textContent,
			isEmpty,
		};
		const result = desc.toDOM(payload);
		el.appendChild(result);
	} else if (desc.toComponent && opts.renderReactBlock) {
		// Stable host so React reconciliation matches across renders. We
		// reuse an existing host inside the wrapper (keyed by the block
		// id) instead of recreating it on every render — otherwise
		// component-local state would be torn down on every transaction
		// because the bridge sees a fresh element and creates a new root.
		// We wiped non-handle children at the top, so re-attach the host
		// element if we previously stashed it on the wrapper.
		const stash = el as unknown as { __plimReactHost?: HTMLElement; __plimReactContentEl?: HTMLElement };
		let host: HTMLElement;
		if (stash.__plimReactHost && stash.__plimReactHost.getAttribute('data-plim-react-block-id') === node.id) {
			host = stash.__plimReactHost;
		} else {
			host = document.createElement('div');
			host.setAttribute('data-plim-react-block-id', node.id);
			host.setAttribute('contenteditable', 'false');
			stash.__plimReactHost = host;
		}
		el.appendChild(host);
		// Editable React blocks: when the descriptor's block has text we
		// build (or reuse) a `[data-block-content]` element that the
		// component is expected to mount somewhere in its tree via the
		// React-side `<ContentSlot>` helper. The element is owned by the
		// editor: we update its spans in-place via `renderTextSpans` and
		// hand the *same* reference back to the component on every render
		// so React's ref callback is a no-op after the initial stitch-in.
		// `contenteditable=true` overrides the host's `false` so the user
		// can type into the slot while the surrounding chrome stays inert.
		let contentEl: HTMLElement | null = null;
		if (node.text !== undefined) {
			if (stash.__plimReactContentEl && stash.__plimReactContentEl.isConnected && host.contains(stash.__plimReactContentEl)) {
				contentEl = stash.__plimReactContentEl;
			} else {
				contentEl = document.createElement('div');
				contentEl.setAttribute(DATA_BLOCK_CONTENT, 'true');
				contentEl.setAttribute('contenteditable', 'true');
				stash.__plimReactContentEl = contentEl;
			}
			renderTextSpans(contentEl, node.text, opts.marks);
		} else {
			stash.__plimReactContentEl = undefined as unknown as HTMLElement;
			delete (stash as Partial<typeof stash>).__plimReactContentEl;
		}
		const payload: BlockPayload = {
			id: node.id,
			type: node.type,
			attrs: node.attrs ?? {},
			content: contentEl ? [contentEl] : [],
			textContent,
			isEmpty,
		};
		opts.renderReactBlock(host, payload, desc);
	}
	if (isEmpty) el.setAttribute('data-empty', 'true');
	else el.removeAttribute('data-empty');
}

function renderChildBlocks(el: HTMLElement, node: BlockNode, opts: ViewOptions, depth: number) {
	let nest = el.querySelector(`:scope > [data-block-children]`) as HTMLElement | null;
	if (!node.children || node.children.length === 0) {
		if (nest) nest.remove();
		return;
	}
	if (!nest) {
		nest = document.createElement('div');
		nest.setAttribute('data-block-children', 'true');
		el.appendChild(nest);
	}
	renderBlocks(nest, node.children, opts, depth + 1);
}

function renderListItem(el: HTMLElement, node: BlockNode, opts: ViewOptions, depth: number, kind: 'bullet' | 'number', listIndex = 1) {
	let bullet = el.querySelector(':scope > .plim-bullet') as HTMLElement | null;
	if (!bullet) {
		bullet = document.createElement('span');
		bullet.className = 'plim-bullet';
		bullet.setAttribute('contenteditable', 'false');
		el.insertBefore(bullet, el.firstChild);
	}
	bullet.textContent = kind === 'bullet' ? '•' : `${listIndex}.`;
	ensureContentChild(el, node, opts);
	renderChildBlocks(el, node, opts, depth);
}

function renderTodo(el: HTMLElement, node: BlockNode, opts: ViewOptions, depth: number) {
	let chk = el.querySelector(':scope > .plim-check') as HTMLInputElement | null;
	if (!chk) {
		chk = document.createElement('input') as HTMLInputElement;
		chk.type = 'checkbox';
		chk.className = 'plim-check';
		chk.setAttribute('contenteditable', 'false');
		chk.addEventListener('mousedown', (e) => e.preventDefault());
		chk.addEventListener('change', () => {
			const id = el.getAttribute(DATA_BLOCK_ID);
			if (!id) return;
			const state = opts.getState();
			const path = pathOfBlockId(state.doc.children, id, []);
			if (!path) return;
			const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
			tx.setBlockAttrs(path, { checked: chk!.checked });
			tx.commit();
		});
		el.insertBefore(chk, el.firstChild);
	}
	chk.checked = !!node.attrs?.checked;
	ensureContentChild(el, node, opts);
	if (node.attrs?.checked) el.setAttribute('data-checked', 'true');
	else el.removeAttribute('data-checked');
	renderChildBlocks(el, node, opts, depth);
}

function renderToggle(el: HTMLElement, node: BlockNode, opts: ViewOptions, depth: number) {
	let trig = el.querySelector(':scope > .plim-toggle-trigger') as HTMLElement | null;
	if (!trig) {
		trig = document.createElement('span');
		trig.className = 'plim-toggle-trigger';
		trig.setAttribute('contenteditable', 'false');
		trig.textContent = '▸';
		trig.addEventListener('mousedown', (e) => e.preventDefault());
		trig.addEventListener('click', () => {
			const id = el.getAttribute(DATA_BLOCK_ID);
			if (!id) return;
			const state = opts.getState();
			const path = pathOfBlockId(state.doc.children, id, []);
			if (!path) return;
			const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
			tx.setBlockAttrs(path, { open: !node.attrs?.open });
			tx.commit();
		});
		el.insertBefore(trig, el.firstChild);
	}
	if (node.attrs?.open) {
		trig.classList.add('open');
		el.setAttribute('data-open', 'true');
	} else {
		trig.classList.remove('open');
		el.removeAttribute('data-open');
	}
	ensureContentChild(el, node, opts);
	renderChildBlocks(el, node, opts, depth);
}

function renderQuote(el: HTMLElement, node: BlockNode, opts: ViewOptions, depth: number) {
	ensureContentChild(el, node, opts);
	renderChildBlocks(el, node, opts, depth);
}

function clearPayload(el: HTMLElement) {
	for (const child of Array.from(el.childNodes)) {
		if (child instanceof HTMLElement && child.classList.contains('plim-block-handles')) continue;
		child.remove();
	}
}

function pathOfEl(el: HTMLElement, opts: ViewOptions): number[] | null {
	const id = el.getAttribute(DATA_BLOCK_ID);
	if (!id) return null;
	return pathOfBlockId(opts.getState().doc.children, id, []);
}

function dispatchAttrs(el: HTMLElement, opts: ViewOptions, attrs: Record<string, unknown>) {
	const path = pathOfEl(el, opts);
	if (!path) return;
	const tx = opts.editor.createTransaction();
	tx.setBlockAttrs(path, attrs);
	tx.commit();
}

function renderImage(el: HTMLElement, node: BlockNode, opts: ViewOptions) {
	el.setAttribute('contenteditable', 'false');
	const stash = el as unknown as {
		__plimImageCaption?: HTMLElement;
		__plimImageWrap?: HTMLElement;
		__plimImageToolbar?: HTMLElement;
	};
	const src = (node.attrs?.src as string | undefined) ?? '';
	const alt = (node.attrs?.alt as string | undefined) ?? '';
	const caption = (node.attrs?.caption as string | undefined) ?? '';
	const align = (node.attrs?.align as 'left' | 'center' | 'right' | undefined) ?? 'left';
	// `captionVisible` separates "caption row should be in the layout"
	// from "caption text". An empty caption doesn't render the row at
	// all (Notion-style) unless the user explicitly asked for one via
	// the toolbar's Caption toggle, in which case we set the flag and
	// focus the (still-empty) input. The flag is reset on blur if the
	// text remained empty.
	const captionVisible = !!node.attrs?.captionVisible || caption.length > 0;
	// Width is stored as a CSS length string (e.g. '60%' or '480px').
	const width = (node.attrs?.width as string | undefined) ?? '';

	if (!src) {
		// Placeholder state: no image yet. Build from scratch each render
		// since there's nothing user-mutable to preserve.
		clearPayload(el);
		const wrap = document.createElement('div');
		wrap.className = 'plim-image-wrap';
		const placeholder = document.createElement('button');
		placeholder.type = 'button';
		placeholder.className = 'plim-image-placeholder';
		placeholder.textContent = '🖼  Add an image';
		placeholder.addEventListener('click', (ev) => {
			ev.preventDefault();
			const url = window.prompt('Image URL');
			if (!url) return;
			dispatchAttrs(el, opts, { src: url });
		});
		wrap.appendChild(placeholder);
		el.appendChild(wrap);
		stash.__plimImageWrap = undefined as unknown as HTMLElement;
		stash.__plimImageCaption = undefined as unknown as HTMLElement;
		stash.__plimImageToolbar = undefined as unknown as HTMLElement;
		return;
	}

	// Reuse the wrap + caption + toolbar across renders so in-progress
	// edits to the caption (typed text not yet flushed to attrs) and
	// hover/visibility states survive other transactions.
	let wrap = stash.__plimImageWrap;
	let caps = stash.__plimImageCaption;
	if (!wrap || !el.contains(wrap)) {
		clearPayload(el);
		wrap = document.createElement('div');
		wrap.className = 'plim-image-wrap';
		el.appendChild(wrap);
		stash.__plimImageWrap = wrap;
		caps = undefined;
		stash.__plimImageToolbar = undefined as unknown as HTMLElement;
	}

	// Alignment lives on the wrap so it applies to the inline-block
	// frame. We use a data attribute (CSS hooks via attribute selectors)
	// rather than inline `text-align` so consumers can theme freely.
	wrap.setAttribute('data-align', align);

	// Image element. Re-create only if we haven't yet. The frame wraps
	// just the <img> + resize handle so the handle's vertical extent
	// matches the image (not the image + caption). The wrap shrinks to
	// the frame's width so the handle's `right: 0` lands on the image's
	// right edge regardless of the editor container's width.
	let frame = wrap.querySelector('.plim-image-frame') as HTMLElement | null;
	if (!frame) {
		frame = document.createElement('div');
		frame.className = 'plim-image-frame';
		wrap.insertBefore(frame, wrap.firstChild);
	}
	let img = frame.querySelector('img.plim-image') as HTMLImageElement | null;
	if (!img) {
		img = document.createElement('img');
		img.className = 'plim-image';
		img.draggable = false;
		frame.appendChild(img);
	}
	if (img.getAttribute('src') !== src) img.src = src;
	if (img.getAttribute('alt') !== alt) img.alt = alt;
	frame.style.width = width || '';
	img.style.width = '';
	wrap.style.width = '';

	// Resize handle. Pointer-drag updates frame width live; on
	// pointerup, the final width (in px) is committed to `attrs.width`
	// as a percentage of the wrap so the image re-flows responsively.
	let handle = frame.querySelector('.plim-image-resize') as HTMLElement | null;
	if (!handle && !opts.readonly) {
		handle = document.createElement('div');
		handle.className = 'plim-image-resize';
		handle.setAttribute('contenteditable', 'false');
		handle.setAttribute(DATA_PLIM_ISOLATED, 'true');
		handle.addEventListener('pointerdown', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			const startX = ev.clientX;
			const startWidth = frame!.getBoundingClientRect().width;
			const parentWidth = wrap!.getBoundingClientRect().width;
			handle!.setPointerCapture(ev.pointerId);
			handle!.classList.add('plim-image-resize-active');
			const onMove = (mv: PointerEvent) => {
				const dx = mv.clientX - startX;
				const next = Math.max(60, Math.min(parentWidth, startWidth + dx));
				frame!.style.width = `${Math.round(next)}px`;
			};
			const onUp = (up: PointerEvent) => {
				handle!.removeEventListener('pointermove', onMove);
				handle!.removeEventListener('pointerup', onUp);
				handle!.removeEventListener('pointercancel', onUp);
				handle!.releasePointerCapture(up.pointerId);
				handle!.classList.remove('plim-image-resize-active');
				const finalPx = frame!.getBoundingClientRect().width;
				const pct = parentWidth > 0 ? Math.round((finalPx / parentWidth) * 100) : 100;
				dispatchAttrs(el, opts, { width: `${pct}%` });
			};
			handle!.addEventListener('pointermove', onMove);
			handle!.addEventListener('pointerup', onUp);
			handle!.addEventListener('pointercancel', onUp);
		});
		frame.appendChild(handle);
	}

	// Toolbar. Floats over the top-right of the image; visible on
	// hover or when the block is selected (CSS-driven). Buttons:
	// Replace, Align (cycles L→C→R), Caption (toggle visibility +
	// focus), Delete. Toolbar is `data-plim-isolated` so clicks inside
	// don't trigger block-selection / caret moves.
	let toolbar = stash.__plimImageToolbar;
	if ((!toolbar || !frame.contains(toolbar)) && !opts.readonly) {
		toolbar = document.createElement('div');
		toolbar.className = 'plim-image-toolbar';
		toolbar.setAttribute('contenteditable', 'false');
		toolbar.setAttribute(DATA_PLIM_ISOLATED, 'true');
		const mkBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'plim-image-toolbar-btn';
			b.title = title;
			b.setAttribute('aria-label', title);
			b.textContent = label;
			// Block the editor's pointerdown handler from treating a
			// toolbar click as a block-selection event.
			b.addEventListener('mousedown', (e) => e.preventDefault());
			b.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				onClick();
			});
			return b;
		};
		const replaceBtn = mkBtn('Replace', 'Replace image', () => {
			const url = window.prompt('Image URL', src);
			if (!url) return;
			dispatchAttrs(el, opts, { src: url });
		});
		// Align button rotates through left → center → right. The label
		// shows the *current* alignment so the user always sees the
		// active state; clicking advances.
		const alignBtn = mkBtn(alignLabel(align), 'Align image', () => {
			// Read the latest align from state in case it changed between
			// renders (the closure captures the value at render time).
			const stateNow = opts.getState();
			const p = pathForBlockId(stateNow.doc.children, node.id);
			const cur = ((p ? blockAt(stateNow.doc.children, p)?.attrs?.align : align) as 'left' | 'center' | 'right' | undefined) ?? 'left';
			const next: 'left' | 'center' | 'right' = cur === 'left' ? 'center' : cur === 'center' ? 'right' : 'left';
			dispatchAttrs(el, opts, { align: next });
		});
		alignBtn.classList.add('plim-image-toolbar-align');
		const captionBtn = mkBtn('Caption', 'Toggle caption', () => {
			// If hidden, request visibility + focus the empty input.
			// If visible and empty, hide. If visible and non-empty,
			// focus to allow editing.
			const stateNow = opts.getState();
			const p = pathForBlockId(stateNow.doc.children, node.id);
			const blk = p ? blockAt(stateNow.doc.children, p) : null;
			const curCap = (blk?.attrs?.caption as string | undefined) ?? '';
			const curVis = !!blk?.attrs?.captionVisible || curCap.length > 0;
			if (!curVis) {
				dispatchAttrs(el, opts, { captionVisible: true });
				// Focus after the next render flushes.
				queueMicrotask(() => stash.__plimImageCaption?.focus());
			} else if (curCap.length === 0) {
				dispatchAttrs(el, opts, { captionVisible: false });
			} else {
				stash.__plimImageCaption?.focus();
			}
		});
		const deleteBtn = mkBtn('Delete', 'Delete image', () => {
			const stateNow = opts.getState();
			const p = pathForBlockId(stateNow.doc.children, node.id);
			if (!p) return;
			const tx = opts.editor.createTransaction();
			tx.removeBlock(p);
			tx.commit();
		});
		deleteBtn.classList.add('plim-image-toolbar-delete');
		toolbar.append(replaceBtn, alignBtn, captionBtn, deleteBtn);
		frame.appendChild(toolbar);
		stash.__plimImageToolbar = toolbar;
	} else if (toolbar) {
		// Re-sync the alignment label on the existing button (the only
		// piece of the toolbar that depends on attrs).
		const alignBtn = toolbar.querySelector('.plim-image-toolbar-align') as HTMLButtonElement | null;
		if (alignBtn) alignBtn.textContent = alignLabel(align);
	}

	// Caption. The element is `data-plim-isolated` so:
	//  - typing into it is handled natively (the editor's beforeinput
	//    pipeline bails before dispatching transactions).
	//  - moving the caret inside doesn't update the doc's selection state.
	//  - Enter exits to a fresh paragraph after the image (handled in
	//    `onBeforeInput` via `handleIsolatedExit`).
	if (!caps || !wrap.contains(caps)) {
		caps = document.createElement('div');
		caps.className = 'plim-image-caption';
		caps.setAttribute(DATA_PLIM_ISOLATED, 'true');
		caps.dataset.placeholder = 'Write a caption…';
		caps.contentEditable = opts.readonly ? 'false' : 'true';
		caps.textContent = caption;
		caps.addEventListener('blur', () => {
			const next = caps!.textContent ?? '';
			const cur = opts.getState();
			const p = pathForBlockId(cur.doc.children, node.id);
			const stored = (p ? blockAt(cur.doc.children, p)?.attrs?.caption : '') as string | undefined;
			const patch: Record<string, unknown> = {};
			if (next !== (stored ?? '')) patch.caption = next;
			// If we asked the caption to be visible (empty + toolbar
			// click) and the user typed nothing, clear the request so
			// the row hides again.
			if (next.length === 0) patch.captionVisible = false;
			if (Object.keys(patch).length > 0) dispatchAttrs(el, opts, patch);
		});
		wrap.appendChild(caps);
		stash.__plimImageCaption = caps;
	} else {
		const focused = el.ownerDocument.activeElement === caps;
		if (!focused && caps.textContent !== caption) caps.textContent = caption;
		caps.contentEditable = opts.readonly ? 'false' : 'true';
	}
	// Toggle the caption row's presence in the layout. Done as an
	// attribute on the wrap so CSS can hide/show without remounting
	// the DOM (preserves caret/IME state).
	wrap.setAttribute('data-caption-visible', captionVisible ? 'true' : 'false');
}

function alignLabel(a: 'left' | 'center' | 'right'): string {
	// Compact labels — the title attribute carries the verbose name.
	return a === 'left' ? '←' : a === 'center' ? '↔' : '→';
}

function renderEmbed(el: HTMLElement, node: BlockNode, opts: ViewOptions) {
	el.setAttribute('contenteditable', 'false');
	clearPayload(el);
	const wrap = document.createElement('div');
	wrap.className = 'plim-embed-wrap';
	wrap.setAttribute(DATA_BLOCK_CONTENT, 'true');
	const url = (node.attrs?.url as string | undefined) ?? '';
	if (!url) {
		const placeholder = document.createElement('button');
		placeholder.type = 'button';
		placeholder.className = 'plim-embed-placeholder';
		placeholder.textContent = '🔗  Add an embed';
		placeholder.addEventListener('click', (ev) => {
			ev.preventDefault();
			const u = window.prompt('Embed URL (iframe-compatible)');
			if (!u) return;
			dispatchAttrs(el, opts, { url: u });
		});
		wrap.appendChild(placeholder);
	} else {
		const iframe = document.createElement('iframe');
		iframe.src = url;
		iframe.className = 'plim-embed';
		iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
		iframe.setAttribute('loading', 'lazy');
		iframe.referrerPolicy = 'no-referrer';
		wrap.appendChild(iframe);
	}
	el.appendChild(wrap);
}

function renderRawHTML(el: HTMLElement, node: BlockNode, opts: ViewOptions) {
	el.setAttribute('contenteditable', 'false');
	clearPayload(el);
	const wrap = document.createElement('div');
	wrap.className = 'plim-rawhtml-wrap';
	wrap.setAttribute(DATA_BLOCK_CONTENT, 'true');
	const html = (node.attrs?.html as string | undefined) ?? '';
	if (!html) {
		const placeholder = document.createElement('button');
		placeholder.type = 'button';
		placeholder.className = 'plim-rawhtml-placeholder';
		placeholder.textContent = '< />  Add raw HTML';
		placeholder.addEventListener('click', (ev) => {
			ev.preventDefault();
			const h = window.prompt('Raw HTML (rendered in sandboxed iframe)');
			if (h == null) return;
			dispatchAttrs(el, opts, { html: h });
		});
		wrap.appendChild(placeholder);
	} else {
		const iframe = document.createElement('iframe');
		iframe.srcdoc = html;
		iframe.className = 'plim-rawhtml';
		iframe.setAttribute('sandbox', 'allow-scripts');
		wrap.appendChild(iframe);
		const edit = document.createElement('button');
		edit.type = 'button';
		edit.className = 'plim-rawhtml-edit';
		edit.textContent = 'Edit HTML';
		edit.addEventListener('click', (ev) => {
			ev.preventDefault();
			const h = window.prompt('Raw HTML', html);
			if (h == null) return;
			dispatchAttrs(el, opts, { html: h });
		});
		wrap.appendChild(edit);
	}
	el.appendChild(wrap);
}

function renderTable(el: HTMLElement, node: BlockNode, opts: ViewOptions) {
	el.setAttribute('contenteditable', 'false');
	let data = (node.attrs?.data as string[][] | undefined) ?? [
		['', '', ''],
		['', '', ''],
	];
	data = data.map((r) => r.slice());
	const cols = data[0]?.length ?? 0;

	let wrap = el.querySelector(':scope > .plim-table-wrap') as HTMLElement | null;
	let table: HTMLTableElement | null = null;
	let controls: HTMLElement | null = null;
	if (wrap) {
		table = wrap.querySelector(':scope > table.plim-table') as HTMLTableElement | null;
		controls = wrap.querySelector(':scope > .plim-table-controls') as HTMLElement | null;
	}
	if (!wrap) {
		// Wipe non-handle children and rebuild scaffold.
		clearPayload(el);
		wrap = document.createElement('div');
		wrap.className = 'plim-table-wrap';
		wrap.setAttribute(DATA_BLOCK_CONTENT, 'true');
		table = document.createElement('table');
		table.className = 'plim-table';
		controls = document.createElement('div');
		controls.className = 'plim-table-controls';
		const addRow = document.createElement('button');
		addRow.type = 'button';
		addRow.textContent = '+ Row';
		addRow.addEventListener('click', (ev) => {
			ev.preventDefault();
			const stateNode = blockAtPath(opts.getState().doc.children, pathOfEl(el, opts) ?? []);
			const live = (stateNode?.attrs?.data as string[][] | undefined)?.map((r) => r.slice()) ?? data;
			const c = live[0]?.length ?? 1;
			live.push(new Array(c).fill(''));
			dispatchAttrs(el, opts, { data: live });
		});
		const addCol = document.createElement('button');
		addCol.type = 'button';
		addCol.textContent = '+ Column';
		addCol.addEventListener('click', (ev) => {
			ev.preventDefault();
			const stateNode = blockAtPath(opts.getState().doc.children, pathOfEl(el, opts) ?? []);
			const live = (stateNode?.attrs?.data as string[][] | undefined)?.map((r) => r.slice()) ?? data;
			for (const r of live) r.push('');
			dispatchAttrs(el, opts, { data: live });
		});
		controls.appendChild(addRow);
		controls.appendChild(addCol);
		wrap.appendChild(table);
		wrap.appendChild(controls);
		el.appendChild(wrap);
	}
	if (!table) return;

	function makeCell(r: number, c: number, text: string): HTMLTableCellElement {
		const td = document.createElement('td');
		td.contentEditable = opts.readonly ? 'false' : 'true';
		td.textContent = text;
		td.dataset.row = String(r);
		td.dataset.col = String(c);
		td.addEventListener('blur', () => {
			const rr = Number(td.dataset.row);
			const cc = Number(td.dataset.col);
			const txt = td.textContent ?? '';
			const path = pathOfEl(el, opts);
			if (!path) return;
			const stateNode = blockAtPath(opts.getState().doc.children, path);
			const liveData = ((stateNode?.attrs?.data as string[][] | undefined) ?? []).map((row) => row.slice());
			if (!liveData[rr]) return;
			if (liveData[rr]![cc] === txt) return;
			liveData[rr]![cc] = txt;
			dispatchAttrs(el, opts, { data: liveData });
		});
		td.addEventListener('keydown', (ev) => {
			ev.stopPropagation();
			if (ev.key === 'Enter' && !ev.shiftKey) {
				ev.preventDefault();
				td.blur();
			}
		});
		td.addEventListener('beforeinput', (ev) => ev.stopPropagation());
		return td;
	}

	// Reconcile rows
	const rows = Array.from(table.children).filter((c) => c.tagName === 'TR') as HTMLTableRowElement[];
	while (rows.length > data.length) {
		rows.pop()?.remove();
	}
	for (let r = 0; r < data.length; r++) {
		let tr = rows[r];
		if (!tr) {
			tr = document.createElement('tr');
			table.appendChild(tr);
		}
		const cells = Array.from(tr.children).filter((c) => c.tagName === 'TD') as HTMLTableCellElement[];
		while (cells.length > cols) {
			cells.pop()?.remove();
		}
		for (let c = 0; c < cols; c++) {
			const text = data[r]?.[c] ?? '';
			let td = cells[c];
			if (!td) {
				td = makeCell(r, c, text);
				tr.appendChild(td);
			} else {
				td.dataset.row = String(r);
				td.dataset.col = String(c);
				// Only update textContent if not focused (preserves caret)
				if (document.activeElement !== td && td.textContent !== text) {
					td.textContent = text;
				}
			}
		}
	}
}


function blockAtPath(blocks: BlockNode[], path: number[]): BlockNode | null {
	let arr = blocks;
	let node: BlockNode | null = null;
	for (const i of path) {
		const next = arr[i];
		if (!next) return null;
		node = next;
		arr = next.children ?? [];
	}
	return node;
}

function renderTextSpans(parent: HTMLElement, spans: TextSpan[], marks: MarkDescriptor[]) {
	parent.innerHTML = '';
	if (spans.length === 0) {
		// Use a zero-width br so the line is selectable
		parent.appendChild(document.createElement('br'));
		return;
	}
	let lastText = '';
	for (const span of spans) {
		const node = renderSpan(span, marks);
		parent.appendChild(node);
		lastText = span.text;
	}
	// Trailing-newline sentinel: a `\n` at the very end of the block doesn't
	// render a visible empty line in `white-space: pre-wrap` content (the browser
	// collapses it before the closing inline boundary). Without a visible second
	// line, the user can't tell Shift+Enter actually worked and presses it again,
	// silently accumulating extra newlines. Append a `<br data-plim-trailing>`
	// so the empty line anchors visually. The break is not part of the model
	// — DOM→model offset mapping skips it because text-node walking ignores
	// element nodes that aren't followed by more text.
	if (lastText.endsWith('\n')) {
		const br = document.createElement('br');
		br.setAttribute('data-plim-trailing', 'true');
		parent.appendChild(br);
	}
}

function renderSpan(span: TextSpan, marks: MarkDescriptor[]): Node {
	const text = document.createTextNode(span.text);
	if (!span.marks || span.marks.length === 0) return text;
	let outer: HTMLElement | null = null;
	let inner: HTMLElement | null = null;
	for (const mark of span.marks) {
		const wrap = wrapForMark(mark.type, mark.attrs, marks);
		if (!outer) {
			outer = wrap;
			inner = wrap;
		} else {
			inner!.appendChild(wrap);
			inner = wrap;
		}
	}
	inner!.appendChild(text);
	return outer!;
}

// Look up a registered MarkDescriptor first; if it provides `toDOM`, delegate
// fully and just stamp `data-mark-type` on the result for selection/CSS hooks.
// Custom marks therefore have full control over their DOM. If no descriptor
// (or no `toDOM`) is registered, fall back to a hardcoded mapping for the
// historical built-ins so the editor still renders sensibly with an empty
// `marks` registry (e.g., during partial setup or in tests).
function wrapForMark(type: string, attrs: Record<string, unknown> | undefined, marks: MarkDescriptor[]): HTMLElement {
	const desc = marks.find((m) => m.name === type);
	if (desc?.toDOM) {
		const payload: MarkPayload = { type, attrs: attrs ?? {}, text: '', content: null };
		const el = desc.toDOM(payload);
		el.setAttribute('data-mark-type', type);
		return el;
	}
	let el: HTMLElement;
	switch (type) {
		case 'bold':
			el = document.createElement('strong');
			break;
		case 'italic':
			el = document.createElement('em');
			break;
		case 'underline':
			el = document.createElement('u');
			break;
		case 'strikethrough':
			el = document.createElement('s');
			break;
		case 'code':
			el = document.createElement('code');
			el.className = 'plim-inline-code';
			break;
		case 'link':
			el = document.createElement('a');
			(el as HTMLAnchorElement).href = (attrs?.href as string) ?? '#';
			(el as HTMLAnchorElement).rel = 'noreferrer';
			break;
		case 'highlight':
			el = document.createElement('mark');
			break;
		default:
			el = document.createElement('span');
			el.setAttribute('data-mark', type);
	}
	el.setAttribute('data-mark-type', type);
	return el;
}

// ---- DOM ↔ position mapping ----

function pathOfBlockId(blocks: BlockNode[], id: string, parentPath: number[]): number[] | null {
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i]!;
		if (b.id === id) return [...parentPath, i];
		if (b.children) {
			const found = pathOfBlockId(b.children, id, [...parentPath, i]);
			if (found) return found;
		}
	}
	return null;
}

function locateOffsetInDOM(rootEl: HTMLElement, path: number[], offset: number): { node: Node; offset: number } | null {
	const blockEl = blockElementAtPath(rootEl, path);
	if (!blockEl) return null;
	const content = findBlockContent(blockEl);
	if (!content) {
		// non-text block — place caret in block element
		return { node: blockEl, offset: 0 };
	}
	return findTextNodeAtOffset(content, offset);
}

function blockElementAtPath(rootEl: HTMLElement, path: number[]): HTMLElement | null {
	let parent: HTMLElement = rootEl;
	for (let i = 0; i < path.length; i++) {
		const idx = path[i]!;
		// children at this level: direct block children of `parent` if i==0, else inside data-block-children
		let container: HTMLElement | null = parent === rootEl ? rootEl : (parent.querySelector(':scope > [data-block-children]') as HTMLElement | null);
		if (!container) return null;
		const blockEls = Array.from(container.children).filter((c) => c instanceof HTMLElement && c.hasAttribute(DATA_BLOCK_ID)) as HTMLElement[];
		const child = blockEls[idx];
		if (!child) return null;
		parent = child;
	}
	return parent === rootEl ? null : parent;
}

function findTextNodeAtOffset(content: HTMLElement, offset: number): { node: Node; offset: number } {
	// Walk text nodes in content; offset counts characters
	let remaining = offset;
	const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	let node = walker.nextNode() as Text | null;
	while (node) {
		const len = node.data.length;
		if (remaining <= len) return { node, offset: remaining };
		remaining -= len;
		last = node;
		node = walker.nextNode() as Text | null;
	}
	if (last) return { node: last, offset: last.data.length };
	// No text — fallback to content element itself
	return { node: content, offset: 0 };
}

function locatePathOffsetFromNode(rootEl: HTMLElement, node: Node, offset: number): { path: number[]; offset: number } | null {
	// Find the nearest ancestor with data-block-id
	let el: Node | null = node;
	while (el && el !== rootEl) {
		if (el instanceof HTMLElement && el.hasAttribute(DATA_BLOCK_ID)) break;
		el = el.parentNode;
	}
	if (!(el instanceof HTMLElement) || !el.hasAttribute(DATA_BLOCK_ID)) return null;
	const blockEl = el;
	const path = computePathOf(rootEl, blockEl);
	if (!path) return null;
	const content = findBlockContent(blockEl);
	if (!content) return { path, offset: 0 };
	const off = computeTextOffset(content, node, offset);
	return { path, offset: off };
}

function computePathOf(rootEl: HTMLElement, blockEl: HTMLElement): number[] | null {
	const path: number[] = [];
	let cur: HTMLElement = blockEl;
	while (cur !== rootEl) {
		const parent = cur.parentElement;
		if (!parent) return null;
		const container = parent.hasAttribute('data-block-children') ? parent : parent === rootEl ? rootEl : null;
		if (!container) {
			// climb until we hit a container
			cur = parent;
			continue;
		}
		const siblings = Array.from(container.children).filter((c) => c instanceof HTMLElement && c.hasAttribute(DATA_BLOCK_ID)) as HTMLElement[];
		const idx = siblings.indexOf(cur);
		if (idx < 0) return null;
		path.unshift(idx);
		// move up to enclosing block (parent of the data-block-children)
		if (container === rootEl) break;
		const enclosing = container.parentElement;
		if (!enclosing) return null;
		if (!(enclosing instanceof HTMLElement) || !enclosing.hasAttribute(DATA_BLOCK_ID)) return null;
		cur = enclosing;
	}
	return path;
}

function computeTextOffset(content: HTMLElement, node: Node, offset: number): number {
	if (!content.contains(node) && node !== content) return 0;
	let total = 0;
	const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
	let cur = walker.nextNode() as Text | null;
	if (node === content) {
		// offset is index among children — convert by walking child nodes up to offset
		let count = 0;
		for (let i = 0; i < offset && i < content.childNodes.length; i++) {
			const c = content.childNodes[i]!;
			count += textLengthOf(c);
		}
		return count;
	}
	while (cur) {
		if (cur === node) return total + offset;
		total += cur.data.length;
		cur = walker.nextNode() as Text | null;
	}
	// node may be an element; sum text up to it
	return sumTextBefore(content, node, offset);
}

function textLengthOf(node: Node): number {
	if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
	let n = 0;
	for (const c of Array.from(node.childNodes)) n += textLengthOf(c);
	return n;
}

function sumTextBefore(content: HTMLElement, target: Node, targetOffset: number): number {
	let sum = 0;
	let stop = false;
	function walk(n: Node) {
		if (stop) return;
		if (n === target) {
			// when target is element, treat targetOffset as child index
			if (n.nodeType === Node.ELEMENT_NODE) {
				let i = 0;
				for (const c of Array.from(n.childNodes)) {
					if (i >= targetOffset) break;
					sum += textLengthOf(c);
					i++;
				}
			}
			stop = true;
			return;
		}
		if (n.nodeType === Node.TEXT_NODE) {
			sum += (n as Text).data.length;
			return;
		}
		for (const c of Array.from(n.childNodes)) walk(c);
	}
	walk(content);
	return sum;
}

// ---- Built-in input handlers ----

// Enter inside an isolated subtree (image caption, embed URL field, etc.)
// should *exit* the region rather than splitting it. We walk up to the
// host block, find its path in the doc, and insert a fresh paragraph
// after it; selection is moved into the new paragraph so the caret lands
// where the user expects. The isolated region's contents are left intact;
// captions sync via their own blur handler so any in-progress edits land
// when focus moves to the new paragraph.
function handleIsolatedExit(opts: ViewOptions, iso: HTMLElement) {
	const blockEl = iso.closest(`[${DATA_BLOCK_ID}]`) as HTMLElement | null;
	if (!blockEl) return;
	const blockId = blockEl.getAttribute(DATA_BLOCK_ID);
	if (!blockId) return;
	const state = opts.getState();
	const path = pathForBlockId(state.doc.children, blockId);
	if (!path) return;
	// Sibling path = parent.path + (lastIdx + 1). insertBlock inserts at the
	// given path, shifting later siblings; passing parentPath + (idx+1) puts
	// the new paragraph immediately after the host.
	const insertPath = [...path.slice(0, -1), path[path.length - 1]! + 1];
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	tx.insertBlock(insertPath, { id: newId(), type: 'paragraph', text: [] });
	tx.setSelection({
		anchor: { path: insertPath, offset: 0 },
		head: { path: insertPath, offset: 0 },
	});
	tx.commit();
	// Focus the editor root so the new selection takes effect; the next
	// render loop will place the DOM caret in the new paragraph.
	(opts.container.querySelector(`[${DATA_BLOCK_ID}]`) ? opts.container : null);
}

function pathForBlockId(blocks: BlockNode[], id: string, parent: number[] = []): number[] | null {
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (!b) continue;
		if (b.id === id) return [...parent, i];
		if (b.children) {
			const found = pathForBlockId(b.children, id, [...parent, i]);
			if (found) return found;
		}
	}
	return null;
}

function handleInsertParagraph(opts: ViewOptions) {
	const state = opts.getState();
	const sel = state.selection;
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	// Look up the descriptor for the current block to honor `continueAs`:
	// "structural" blocks (callouts, quotes-as-callout-style, dividers,
	// images) should not propagate themselves on Enter — the right-hand
	// block becomes the descriptor's `continueAs` type instead. If unset,
	// default to splitting into the same type (paragraph-style behavior).
	const currentBlock = blockAt(state.doc.children, sel.head.path);
	const desc = currentBlock ? opts.blocks.find((b) => b.name === currentBlock.type) : undefined;
	const continueAs = desc?.continueAs;
	if (!pathsEqual(sel.anchor.path, sel.head.path) || sel.anchor.offset !== sel.head.offset) {
		// delete selection then split
		const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
		const toOff = Math.max(sel.anchor.offset, sel.head.offset);
		tx.replaceRange(sel.head.path, fromOff, toOff, []);
		if (continueAs) tx.splitBlock(sel.head.path, fromOff, continueAs);
		else tx.splitBlock(sel.head.path, fromOff);
	} else {
		if (continueAs) tx.splitBlock(sel.head.path, sel.head.offset, continueAs);
		else tx.splitBlock(sel.head.path, sel.head.offset);
	}
	tx.commit();
}

function handleInsertLineBreak(opts: ViewOptions) {
	// Shift+Enter: insert literal newline
	const state = opts.getState();
	const sel = state.selection;
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	tx.insertText(sel.head.path, sel.head.offset, '\n');
	tx.setSelection({
		anchor: { path: sel.head.path, offset: sel.head.offset + 1 },
		head: { path: sel.head.path, offset: sel.head.offset + 1 },
	});
	tx.commit();
}

function handleDeleteBackward(opts: ViewOptions) {
	const state = opts.getState();
	const sel = state.selection;
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	if (!pathsEqual(sel.anchor.path, sel.head.path) || sel.anchor.offset !== sel.head.offset) {
		const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
		const toOff = Math.max(sel.anchor.offset, sel.head.offset);
		tx.replaceRange(sel.head.path, fromOff, toOff, []);
		tx.commit();
		return;
	}
	if (sel.head.offset === 0) {
		// At start: convert special block to paragraph, otherwise join with previous
		const block = blockAt(state.doc.children, sel.head.path);
		if (block && block.type !== 'paragraph' && block.text !== undefined) {
			tx.setBlockType(sel.head.path, 'paragraph');
			tx.commit();
			return;
		}
		tx.joinBackward(sel.head.path);
		tx.commit();
		return;
	}
	tx.replaceRange(sel.head.path, sel.head.offset - 1, sel.head.offset, []);
	tx.commit();
}

function handleDeleteForward(opts: ViewOptions) {
	const state = opts.getState();
	const sel = state.selection;
	const block = blockAt(state.doc.children, sel.head.path);
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	if (!pathsEqual(sel.anchor.path, sel.head.path) || sel.anchor.offset !== sel.head.offset) {
		const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
		const toOff = Math.max(sel.anchor.offset, sel.head.offset);
		tx.replaceRange(sel.head.path, fromOff, toOff, []);
		tx.commit();
		return;
	}
	if (block && sel.head.offset >= blockTextLength(block)) {
		// At end: try joinForward = next block's joinBackward
		const flat = flattenBlocks(state.doc);
		const idx = flat.findIndex((e) => pathsEqual(e.path, sel.head.path));
		const next = idx >= 0 ? flat[idx + 1] : undefined;
		if (next) {
			tx.joinBackward(next.path);
			tx.commit();
		}
		return;
	}
	tx.replaceRange(sel.head.path, sel.head.offset, sel.head.offset + 1, []);
	tx.commit();
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Find offset where a "word" ends when moving backward from `offset`. */
function wordBoundaryBackward(text: string, offset: number): number {
	let i = offset;
	// skip trailing whitespace
	while (i > 0 && /\s/.test(text[i - 1]!)) i--;
	// if we landed on a word char, eat the run; otherwise eat one non-word char
	if (i > 0 && WORD_CHAR.test(text[i - 1]!)) {
		while (i > 0 && WORD_CHAR.test(text[i - 1]!)) i--;
	} else if (i > 0) {
		i--;
	}
	return i;
}

/** Find offset where a "word" ends when moving forward from `offset`. */
function wordBoundaryForward(text: string, offset: number): number {
	let i = offset;
	while (i < text.length && /\s/.test(text[i]!)) i++;
	if (i < text.length && WORD_CHAR.test(text[i]!)) {
		while (i < text.length && WORD_CHAR.test(text[i]!)) i++;
	} else if (i < text.length) {
		i++;
	}
	return i;
}

function deleteSelectionIfAny(opts: ViewOptions): boolean {
	const state = opts.getState();
	const sel = state.selection;
	if (pathsEqual(sel.anchor.path, sel.head.path) && sel.anchor.offset === sel.head.offset) return false;
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
	const toOff = Math.max(sel.anchor.offset, sel.head.offset);
	tx.replaceRange(sel.head.path, fromOff, toOff, []);
	tx.commit();
	return true;
}

function handleDeleteWordBackward(opts: ViewOptions) {
	if (deleteSelectionIfAny(opts)) return;
	const state = opts.getState();
	const sel = state.selection;
	const block = blockAt(state.doc.children, sel.head.path);
	if (!block || block.text === undefined) return;
	if (sel.head.offset === 0) {
		// At block start: defer to normal join/convert behavior.
		handleDeleteBackward(opts);
		return;
	}
	const plain = (block.text ?? []).map((s) => s.text).join('');
	const target = wordBoundaryBackward(plain, sel.head.offset);
	if (target === sel.head.offset) return;
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	tx.replaceRange(sel.head.path, target, sel.head.offset, []);
	tx.commit();
}

function handleDeleteWordForward(opts: ViewOptions) {
	if (deleteSelectionIfAny(opts)) return;
	const state = opts.getState();
	const sel = state.selection;
	const block = blockAt(state.doc.children, sel.head.path);
	if (!block || block.text === undefined) return;
	const len = blockTextLength(block);
	if (sel.head.offset >= len) {
		handleDeleteForward(opts);
		return;
	}
	const plain = (block.text ?? []).map((s) => s.text).join('');
	const target = wordBoundaryForward(plain, sel.head.offset);
	if (target === sel.head.offset) return;
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	tx.replaceRange(sel.head.path, sel.head.offset, target, []);
	tx.commit();
}

function handleDeleteLineBackward(opts: ViewOptions) {
	if (deleteSelectionIfAny(opts)) return;
	const state = opts.getState();
	const sel = state.selection;
	const block = blockAt(state.doc.children, sel.head.path);
	if (!block || block.text === undefined) return;
	if (sel.head.offset === 0) {
		handleDeleteBackward(opts);
		return;
	}
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	tx.replaceRange(sel.head.path, 0, sel.head.offset, []);
	tx.commit();
}

function handleDeleteLineForward(opts: ViewOptions) {
	if (deleteSelectionIfAny(opts)) return;
	const state = opts.getState();
	const sel = state.selection;
	const block = blockAt(state.doc.children, sel.head.path);
	if (!block || block.text === undefined) return;
	const len = blockTextLength(block);
	if (sel.head.offset >= len) {
		handleDeleteForward(opts);
		return;
	}
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	tx.replaceRange(sel.head.path, sel.head.offset, len, []);
	tx.commit();
}

function blockAt(blocks: BlockNode[], path: number[]): BlockNode | null {
	let arr: BlockNode[] | undefined = blocks;
	let cur: BlockNode | null = null;
	for (const idx of path) {
		if (!arr) return null;
		cur = arr[idx] ?? null;
		if (!cur) return null;
		arr = cur.children;
	}
	return cur;
}