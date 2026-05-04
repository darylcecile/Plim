import {
	type ActionContext,
	type BlockDescriptor,
	type BlockNode,
	type EditorState,
	type MarkDescriptor,
	type Selection as PSelection,
	type TextSpan,
	type Transaction,
	blockTextLength,
	flattenBlocks,
	isMacLike,
	newId,
} from '@plim/core';

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

	function render(state: EditorState) {
		updating = true;
		try {
			renderBlocks(root, state.doc.children, opts);
			applySelection(root, state.selection);
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
	const onSelectionChange = () => {
		if (updating || composing) return;
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

	const onBeforeInput = (ev: InputEvent) => {
		if (composing) return;
		const type = ev.inputType;
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

	const onCopy = (ev: ClipboardEvent) => opts.onClipboardEvent('copy', ev);
	const onCut = (ev: ClipboardEvent) => opts.onClipboardEvent('cut', ev);
	const onPaste = (ev: ClipboardEvent) => {
		const text = ev.clipboardData?.getData('text/plain');
		if (text) {
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

	function commitMove(sourceId: string, targetEl: HTMLElement, before: boolean): boolean {
		const targetId = targetEl.getAttribute(DATA_BLOCK_ID);
		if (!targetId || sourceId === targetId) return false;
		const state = opts.getState();
		const fromPath = pathOfBlockId(state.doc.children, sourceId, []);
		const targetPath = pathOfBlockId(state.doc.children, targetId, []);
		if (!fromPath || !targetPath) return false;
		// Disallow dropping into self/descendant
		if (targetPath.length >= fromPath.length && fromPath.every((seg, i) => targetPath[i] === seg)) return false;
		const sameParent = fromPath.length === targetPath.length && fromPath.slice(0, -1).every((seg, i) => targetPath[i] === seg);
		const targetLast = targetPath[targetPath.length - 1]!;
		let insertIdx = before ? targetLast : targetLast + 1;
		if (sameParent) {
			const fromLast = fromPath[fromPath.length - 1]!;
			if (fromLast < targetLast) insertIdx -= 1;
			if (insertIdx === fromLast) return false; // no-op
		}
		const toPath = [...targetPath.slice(0, -1), insertIdx];
		const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
		tx.moveBlock(fromPath, toPath);
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
			return clearDropIndicator();
		}
		ev.preventDefault();
		const target = dropTarget.el;
		const before = dropTarget.before;
		clearDropIndicator();
		commitMove(sourceId, target, before);
		activeDragSourceId = null;
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
		if (detail?.id) activeDragSourceId = detail.id;
	};
	const onPlimDragEnd = () => {
		activeDragSourceId = null;
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
			commitMove(activeDragSourceId, dropTarget.el, dropTarget.before);
		}
		activeDragSourceId = null;
		clearDropIndicator();
	};
	root.addEventListener('plim:custom-drag-move', onPlimCustomDragMove);
	root.addEventListener('plim:custom-drag-end', onPlimCustomDragCommit);
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
			return 'pre';
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
		const finishSession = (cancelled: boolean) => {
			if (!session) return;
			const wasActive = session.started;
			try {
				drag.releasePointerCapture(session.pointerId);
			} catch {
				/* noop */
			}
			session = null;
			if (wasActive) {
				el.classList.remove('plim-block--dragging');
				el.dispatchEvent(new CustomEvent('plim:custom-drag-end', { bubbles: true, detail: { cancelled } }));
			}
		};
		const onPointerUp = (e: PointerEvent) => {
			if (!session || e.pointerId !== session.pointerId) return;
			finishSession(false);
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
		// Type changed — strip type-specific affordances.
		for (const sel of [':scope > .plim-bullet', ':scope > .plim-check', ':scope > .plim-toggle-trigger', ':scope > hr', ':scope > .plim-image-wrap', ':scope > .plim-embed-wrap', ':scope > .plim-rawhtml-wrap', ':scope > .plim-table-wrap']) {
			const old = el.querySelector(sel);
			if (old) old.remove();
		}
		el.removeAttribute('contenteditable');
		el.removeAttribute('data-checked');
		el.removeAttribute('data-open');
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
			// Wipe non-handle children, then mount a single <code> as content.
			for (const child of Array.from(el.childNodes)) {
				if (child instanceof HTMLElement && child.classList.contains('plim-block-handles')) continue;
				child.remove();
			}
			const code = document.createElement('code');
			code.setAttribute(DATA_BLOCK_CONTENT, 'true');
			renderTextSpans(code, node.text ?? []);
			el.appendChild(code);
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
			// generic text block (paragraph, heading)
			ensureContentChild(el, node);
			renderChildBlocks(el, node, opts, depth);
		}
	}
}

function ensureContentChild(el: HTMLElement, node: BlockNode) {
	let content = el.querySelector(`:scope > [${DATA_BLOCK_CONTENT}]`) as HTMLElement | null;
	if (!content) {
		content = document.createElement('span');
		content.setAttribute(DATA_BLOCK_CONTENT, 'true');
		// Insert content before any data-block-children, after any leading affordances (bullet, check, etc.)
		const childContainer = el.querySelector(`:scope > [data-block-children]`);
		if (childContainer) el.insertBefore(content, childContainer);
		else el.appendChild(content);
	}
	renderTextSpans(content, node.text ?? []);
	if (!node.text || node.text.length === 0) {
		el.setAttribute('data-empty', 'true');
	} else {
		el.removeAttribute('data-empty');
	}
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
	ensureContentChild(el, node);
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
	ensureContentChild(el, node);
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
	ensureContentChild(el, node);
	renderChildBlocks(el, node, opts, depth);
}

function renderQuote(el: HTMLElement, node: BlockNode, opts: ViewOptions, depth: number) {
	ensureContentChild(el, node);
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
	clearPayload(el);
	const wrap = document.createElement('div');
	wrap.className = 'plim-image-wrap';
	wrap.setAttribute(DATA_BLOCK_CONTENT, 'true');
	const src = (node.attrs?.src as string | undefined) ?? '';
	const alt = (node.attrs?.alt as string | undefined) ?? '';
	if (!src) {
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
	} else {
		const img = document.createElement('img');
		img.src = src;
		img.alt = alt;
		img.draggable = false;
		img.className = 'plim-image';
		wrap.appendChild(img);
		const caption = (node.attrs?.caption as string | undefined) ?? '';
		const cap = document.createElement('div');
		cap.className = 'plim-image-caption';
		cap.contentEditable = opts.readonly ? 'false' : 'true';
		cap.textContent = caption;
		cap.dataset.placeholder = 'Write a caption…';
		cap.addEventListener('blur', () => {
			const next = cap.textContent ?? '';
			if (next !== caption) dispatchAttrs(el, opts, { caption: next });
		});
		wrap.appendChild(cap);
	}
	el.appendChild(wrap);
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

function renderTextSpans(parent: HTMLElement, spans: TextSpan[]) {
	parent.innerHTML = '';
	if (spans.length === 0) {
		// Use a zero-width br so the line is selectable
		parent.appendChild(document.createElement('br'));
		return;
	}
	let lastText = '';
	for (const span of spans) {
		const node = renderSpan(span);
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

function renderSpan(span: TextSpan): Node {
	const text = document.createTextNode(span.text);
	if (!span.marks || span.marks.length === 0) return text;
	let outer: HTMLElement | null = null;
	let inner: HTMLElement | null = null;
	for (const mark of span.marks) {
		const wrap = wrapForMark(mark.type, mark.attrs);
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

function wrapForMark(type: string, attrs?: Record<string, unknown>): HTMLElement {
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
		case 'mention':
			el = document.createElement('span');
			el.className = 'plim-mention';
			if (attrs?.id) el.setAttribute('data-mention-id', String(attrs.id));
			if (attrs?.href) el.setAttribute('data-mention-href', String(attrs.href));
			// Mentions are atomic — selecting/typing inside the pill should be
			// treated as selecting the whole thing. `contenteditable=false`
			// would block the cursor entirely; keeping it editable but marking
			// it `data-atomic` lets us extend deletion behavior in the editor
			// while leaving normal selection paint intact.
			el.setAttribute('data-atomic', 'true');
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
	const content = blockEl.querySelector(`:scope > [${DATA_BLOCK_CONTENT}]`) as HTMLElement | null;
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
	const content = blockEl.querySelector(`:scope > [${DATA_BLOCK_CONTENT}]`) as HTMLElement | null;
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

function handleInsertParagraph(opts: ViewOptions) {
	const state = opts.getState();
	const sel = state.selection;
	const tx = (opts as unknown as { editor: { createTransaction(): Transaction } }).editor.createTransaction();
	if (!pathsEqual(sel.anchor.path, sel.head.path) || sel.anchor.offset !== sel.head.offset) {
		// delete selection then split
		const fromOff = Math.min(sel.anchor.offset, sel.head.offset);
		const toOff = Math.max(sel.anchor.offset, sel.head.offset);
		tx.replaceRange(sel.head.path, fromOff, toOff, []);
		tx.splitBlock(sel.head.path, fromOff);
	} else {
		tx.splitBlock(sel.head.path, sel.head.offset);
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