import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
	PlimDriver,
	bulletedListBlock,
	defineBlock,
	defineMark,
	headingBlock,
	numberedListBlock,
	paragraphBlock,
	quoteBlock,
	codeBlock as codeBlockFactory,
	horizontalRuleBlock,
	imageBlock,
	todoListBlock,
	boldMark,
	italicMark,
	codeMark,
	linkMark,
	strikethroughMark,
	underlineMark,
	newId,
} from '@plim/core';
import { attachContainer, deriveEditor, type AgnosticEditor } from '@plim/editor';

function setup(opts?: { initial?: string[] }): { editor: AgnosticEditor; container: HTMLElement; plim: PlimDriver; cleanup: () => void } {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const plim = new PlimDriver({
		registeredBlocks: [paragraphBlock, headingBlock, bulletedListBlock, numberedListBlock, quoteBlock, todoListBlock, codeBlockFactory, horizontalRuleBlock],
		registeredMarks: [boldMark, italicMark, codeMark, linkMark, strikethroughMark, underlineMark],
	});
	const initialContent = opts?.initial
		? {
				type: 'doc' as const,
				children: opts.initial.map((t) => ({
					id: newId(),
					type: 'paragraph' as const,
					text: t ? [{ text: t }] : [],
				})),
			}
		: {
				type: 'doc' as const,
				children: [{ id: newId(), type: 'paragraph' as const, text: [] }],
			};
	const editor = deriveEditor(plim, {
		containerAdapter: attachContainer(() => container),
		initialContent,
		autoFocus: false,
	});
	editor.mount();
	return {
		editor,
		container,
		plim,
		cleanup: () => {
			editor.destroy();
			container.remove();
		},
	};
}

function getRoot(container: HTMLElement): HTMLElement {
	const root = container.querySelector('.plim-editor') as HTMLElement | null;
	if (!root) throw new Error('editor root not mounted');
	return root;
}

function getBlocks(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>('[data-block-id]'));
}

function getContent(block: HTMLElement): HTMLElement {
	const c = block.querySelector('[data-block-content]') as HTMLElement | null;
	if (!c) throw new Error(`block ${block.tagName}.${block.className} has no content node; html=${block.outerHTML.slice(0, 200)}`);
	return c;
}

describe('editor view (real browser)', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => {
		env?.cleanup();
		env = null;
	});

	it('mounts the editor into the supplied container', () => {
		env = setup();
		const root = getRoot(env.container);
		expect(root.getAttribute('contenteditable')).toBe('true');
		expect(getBlocks(env.container)).toHaveLength(1);
	});

	it('marks empty paragraphs with data-empty="true"', () => {
		env = setup();
		const block = getBlocks(env.container)[0]!;
		expect(block.getAttribute('data-empty')).toBe('true');
	});

	it('clears data-empty when content is inserted', () => {
		env = setup();
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.replaceRange([0], 0, 0, [{ text: 'hello' }]);
		tx.commit();
		const block = getBlocks(env.container)[0]!;
		expect(block.getAttribute('data-empty')).toBeNull();
		expect(getContent(block).textContent).toBe('hello');
	});

	it('toggles data-caret-active so only the head block has the placeholder hook', () => {
		env = setup({ initial: ['', '', ''] });
		// Move caret to block 1
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [1], offset: 0 }, head: { path: [1], offset: 0 } });
		tx.commit();
		const blocks = getBlocks(env.container);
		expect(blocks).toHaveLength(3);
		expect(blocks[0]!.getAttribute('data-caret-active')).not.toBe('true');
		expect(blocks[1]!.getAttribute('data-caret-active')).toBe('true');
		expect(blocks[2]!.getAttribute('data-caret-active')).not.toBe('true');
		// Move caret to block 2
		const tx2 = env.editor.createTransaction();
		tx2.setSelection({ anchor: { path: [2], offset: 0 }, head: { path: [2], offset: 0 } });
		tx2.commit();
		const blocks2 = getBlocks(env.container);
		expect(blocks2[1]!.getAttribute('data-caret-active')).not.toBe('true');
		expect(blocks2[2]!.getAttribute('data-caret-active')).toBe('true');
	});

	it('inserts characters via beforeinput', () => {
		env = setup();
		const root = getRoot(env.container);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.commit();
		root.dispatchEvent(
			new InputEvent('beforeinput', {
				inputType: 'insertText',
				data: 'A',
				bubbles: true,
				cancelable: true,
			})
		);
		expect(env.editor.getState().doc.children[0]!.text![0]!.text).toBe('A');
	});

	it('deletes to start of block on Option+Shift+Backspace', () => {
		env = setup({ initial: ['hello world foo bar'] });
		const root = getRoot(env.container);
		const tx = env.editor.createTransaction();
		// caret in the middle (after "hello world ")
		tx.setSelection({ anchor: { path: [0], offset: 12 }, head: { path: [0], offset: 12 } });
		tx.commit();
		const ev = new KeyboardEvent('keydown', {
			bubbles: true,
			cancelable: true,
			key: 'Backspace',
			altKey: true,
			shiftKey: true,
		});
		root.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		const plain = (env.editor.getState().doc.children[0]!.text ?? []).map((s) => s.text).join('');
		expect(plain).toBe('foo bar');
	});

	it('deletes the previous word on deleteWordBackward beforeinput', () => {
		env = setup({ initial: ['hello world foo'] });
		const root = getRoot(env.container);
		const tx = env.editor.createTransaction();
		const len = 'hello world foo'.length;
		tx.setSelection({ anchor: { path: [0], offset: len }, head: { path: [0], offset: len } });
		tx.commit();
		root.dispatchEvent(
			new InputEvent('beforeinput', { inputType: 'deleteWordBackward', bubbles: true, cancelable: true })
		);
		const plain1 = (env.editor.getState().doc.children[0]!.text ?? []).map((s) => s.text).join('');
		expect(plain1).toBe('hello world ');
		root.dispatchEvent(
			new InputEvent('beforeinput', { inputType: 'deleteWordBackward', bubbles: true, cancelable: true })
		);
		const plain2 = (env.editor.getState().doc.children[0]!.text ?? []).map((s) => s.text).join('');
		expect(plain2).toBe('hello ');
	});

	it('toggleMark via Cmd+B with a backward selection applies the mark', () => {
		env = setup({ initial: ['hello world'] });
		// Selection: anchor=11 (end), head=6 (before "world") — i.e. backward selection of "world"
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 11 }, head: { path: [0], offset: 6 } });
		tx.commit();
		// Apply via toggleMark using anchor/head order (mirrors example app)
		const sel = env.editor.getState().selection;
		const tx2 = env.editor.createTransaction();
		tx2.toggleMark('bold', { from: sel.anchor, to: sel.head });
		tx2.commit();
		const text = env.editor.getState().doc.children[0]!.text!;
		const bolded = text.find((s) => s.marks?.some((m) => m.type === 'bold'));
		expect(bolded?.text).toBe('world');
	});

	it('bypasses beforeinput while composing and commits on compositionend', () => {
		env = setup();
		const root = getRoot(env.container);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.commit();
		root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		root.dispatchEvent(
			new InputEvent('beforeinput', {
				inputType: 'insertCompositionText',
				data: 'こ',
				bubbles: true,
				cancelable: true,
			})
		);
		root.dispatchEvent(
			new InputEvent('beforeinput', {
				inputType: 'insertCompositionText',
				data: 'こん',
				bubbles: true,
				cancelable: true,
			})
		);
		expect(env.editor.getState().doc.children[0]!.text ?? []).toEqual([]);
		root.dispatchEvent(new CompositionEvent('compositionend', { data: 'こんにちは', bubbles: true }));
		const text = env.editor.getState().doc.children[0]!.text!;
		expect(text.map((s) => s.text).join('')).toBe('こんにちは');
	});

	it('renders a heading element for heading blocks', () => {
		env = setup();
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.setBlockType([0], 'heading', { level: 2 });
		tx.commit();
		const block = getBlocks(env.container)[0]!;
		expect(block.tagName).toBe('H2');
		expect(block.classList.contains('plim-block-heading')).toBe(true);
		// Switch to bullet list
		const tx2 = env.editor.createTransaction();
		tx2.setBlockType([0], 'bulleted_list_item');
		tx2.commit();
		const block2 = getBlocks(env.container)[0]!;
		expect(block2.classList.contains('plim-block-bulleted_list_item')).toBe(true);
	});

	it('supports undo/redo via the driver history controller', () => {
		env = setup();
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.replaceRange([0], 0, 0, [{ text: 'hello' }]);
		tx.commit();
		expect(getContent(getBlocks(env.container)[0]!).textContent).toBe('hello');
		const ctrl = env.plim.getHistory();
		ctrl.undo();
		expect(getContent(getBlocks(env.container)[0]!).textContent).toBe('');
		ctrl.redo();
		expect(getContent(getBlocks(env.container)[0]!).textContent).toBe('hello');
	});

	it('reorders blocks via pointer-driven drag on the gutter handle', () => {
		env = setup({ initial: ['first', 'second', 'third'] });
		const blocks = getBlocks(env.container);
		expect(blocks.map((b) => getContent(b).textContent)).toEqual(['first', 'second', 'third']);
		const sourceHandle = blocks[0]!.querySelector('.plim-block-drag') as HTMLElement;
		const targetBlock = blocks[2]!;
		const sRect = sourceHandle.getBoundingClientRect();
		const tRect = targetBlock.getBoundingClientRect();

		// pointerdown on the source handle, move past the threshold, hover over
		// the lower half of the target block, then pointerup.
		sourceHandle.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				cancelable: true,
				pointerId: 1,
				button: 0,
				clientX: sRect.left + 5,
				clientY: sRect.top + 5,
			})
		);
		sourceHandle.dispatchEvent(
			new PointerEvent('pointermove', {
				bubbles: true,
				pointerId: 1,
				clientX: sRect.left + 20,
				clientY: sRect.top + 20,
			})
		);
		sourceHandle.dispatchEvent(
			new PointerEvent('pointermove', {
				bubbles: true,
				pointerId: 1,
				clientX: tRect.left + 10,
				clientY: tRect.bottom - 4,
			})
		);
		sourceHandle.dispatchEvent(
			new PointerEvent('pointerup', {
				bubbles: true,
				pointerId: 1,
				clientX: tRect.left + 10,
				clientY: tRect.bottom - 4,
			})
		);

		const after = getBlocks(env.container);
		expect(after.map((b) => getContent(b).textContent)).toEqual(['second', 'third', 'first']);
	});

	it('cancels a pointer drag on Escape without reordering', () => {
		env = setup({ initial: ['a', 'b', 'c'] });
		const blocks = getBlocks(env.container);
		const sourceHandle = blocks[0]!.querySelector('.plim-block-drag') as HTMLElement;
		const sRect = sourceHandle.getBoundingClientRect();
		const tRect = blocks[2]!.getBoundingClientRect();
		sourceHandle.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				cancelable: true,
				pointerId: 2,
				button: 0,
				clientX: sRect.left + 5,
				clientY: sRect.top + 5,
			})
		);
		sourceHandle.dispatchEvent(
			new PointerEvent('pointermove', {
				bubbles: true,
				pointerId: 2,
				clientX: tRect.left + 5,
				clientY: tRect.bottom - 4,
			})
		);
		sourceHandle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
		const after = getBlocks(env.container);
		expect(after.map((b) => getContent(b).textContent)).toEqual(['a', 'b', 'c']);
	});

	it('renders a drag handle on every standalone block including code blocks', () => {
		env = setup();
		// Switch the only block to a code block. ensureBlockHandles previously
		// installed handles, but the code render path used to wipe innerHTML.
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.setBlockType([0], 'code');
		tx.commit();
		const block = getBlocks(env.container)[0]!;
		// Wrapper is a <div> so the absolutely-positioned drag handles
		// in the gutter aren't clipped by the inner <pre>'s
		// `overflow-x: auto`. The inner <pre><code> still hosts the
		// code-look styling and `[data-block-content]`.
		expect(block.tagName).toBe('DIV');
		expect(block.classList.contains('plim-block-code')).toBe(true);
		expect(block.querySelector(':scope > pre > code[data-block-content="true"]')).not.toBeNull();
		expect(block.querySelector(':scope > .plim-block-handles')).not.toBeNull();
		expect(block.querySelector(':scope > .plim-block-handles > .plim-block-drag')).not.toBeNull();
	});

	it('appends a trailing-<br> sentinel when block text ends with a newline so the empty line is visible', () => {
		// Reproduces the Shift+Enter "invisible linebreak" bug: a trailing `\n`
		// in `white-space: pre-wrap` text doesn't anchor a visible empty line in
		// any browser. Without the sentinel the user pressed Shift+Enter, saw
		// nothing, pressed it again, and silently accumulated `\n\n`.
		env = setup({ initial: ['xyz'] });
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 3 }, head: { path: [0], offset: 3 } });
		tx.insertText([0], 3, '\n');
		tx.setSelection({ anchor: { path: [0], offset: 4 }, head: { path: [0], offset: 4 } });
		tx.commit();

		const content = getContent(getBlocks(env.container)[0]!);
		const kids = Array.from(content.childNodes);
		expect(kids).toHaveLength(2);
		expect(kids[0]!.nodeName).toBe('#text');
		expect(kids[0]!.textContent).toBe('xyz\n');
		expect(kids[1]!.nodeName).toBe('BR');
		expect((kids[1] as HTMLElement).getAttribute('data-plim-trailing')).toBe('true');
	});

	it('omits the trailing-<br> sentinel once content follows the newline', () => {
		env = setup({ initial: ['xyz\nabc'] });
		const content = getContent(getBlocks(env.container)[0]!);
		// No trailing newline → no sentinel.
		expect(content.querySelector('br[data-plim-trailing]')).toBeNull();
		expect(content.textContent).toBe('xyz\nabc');
	});

	it('numbers contiguous numbered_list_item siblings sequentially and resets after an interrupting block', () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock, headingBlock, bulletedListBlock, numberedListBlock, quoteBlock, todoListBlock, codeBlockFactory],
			registeredMarks: [boldMark, italicMark, codeMark],
		});
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: newId(), type: 'numbered_list_item', text: [{ text: 'one' }] },
					{ id: newId(), type: 'numbered_list_item', text: [{ text: 'two' }] },
					{ id: newId(), type: 'numbered_list_item', text: [{ text: 'three' }] },
					{ id: newId(), type: 'paragraph', text: [{ text: 'break' }] },
					{ id: newId(), type: 'numbered_list_item', text: [{ text: 'fresh' }] },
					{ id: newId(), type: 'numbered_list_item', text: [{ text: 'restart' }] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		try {
			const bullets = Array.from(container.querySelectorAll<HTMLElement>('[data-block-id] > .plim-bullet'));
			expect(bullets.map((b) => b.textContent)).toEqual(['1.', '2.', '3.', '1.', '2.']);
			// The 4th and 5th items are after the paragraph break — verify the
			// counter actually reset (rather than just being 4,5 by coincidence).
			const blocks = Array.from(container.querySelectorAll<HTMLElement>('[data-block-id]'));
			const numbered = blocks.filter((b) => b.getAttribute('data-block-type') === 'numbered_list_item');
			expect(numbered).toHaveLength(5);
			expect(numbered[3]!.querySelector(':scope > .plim-bullet')!.textContent).toBe('1.');
			expect(numbered[4]!.querySelector(':scope > .plim-bullet')!.textContent).toBe('2.');
		} finally {
			editor.destroy();
			container.remove();
		}
	});
});

describe('Custom block & mark descriptors (toDOM)', () => {
	it('renders a custom block via descriptor.toDOM, including its content element', () => {
		// `callout` is a fictional block type unknown to built-ins. We register
		// it via defineBlock with a toDOM that produces a labeled wrapper around
		// the editor-provided content element. The view should detect the
		// descriptor (no hardcoded switch case) and delegate rendering.
		const calloutBlock = defineBlock({
			name: 'callout',
			type: 'standalone',
			supportsDecoration: true,
			toDOM: (payload) => {
				const wrap = document.createElement('div');
				wrap.className = 'plim-callout';
				wrap.setAttribute('data-callout-tone', String(payload.attrs.tone ?? 'info'));
				const icon = document.createElement('span');
				icon.className = 'plim-callout-icon';
				icon.setAttribute('contenteditable', 'false');
				icon.textContent = '★';
				wrap.appendChild(icon);
				// Content element from the editor — already populated with text spans.
				for (const node of payload.content as HTMLElement[]) wrap.appendChild(node);
				return wrap;
			},
		});

		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock, calloutBlock],
			registeredMarks: [boldMark],
		});
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc' as const,
				children: [
					{
						id: newId(),
						type: 'callout',
						attrs: { tone: 'warn' },
						text: [{ text: 'heads up' }],
					},
				],
			},
			autoFocus: false,
		});
		editor.mount();
		try {
			const block = container.querySelector('[data-block-type="callout"]') as HTMLElement;
			expect(block).toBeTruthy();
			const calloutWrap = block.querySelector(':scope > .plim-callout') as HTMLElement;
			expect(calloutWrap).toBeTruthy();
			expect(calloutWrap.getAttribute('data-callout-tone')).toBe('warn');
			expect(calloutWrap.querySelector('.plim-callout-icon')!.textContent).toBe('★');
			const content = calloutWrap.querySelector('[data-block-content]') as HTMLElement;
			expect(content).toBeTruthy();
			expect(content.textContent).toBe('heads up');
			// data-attr-* should still be stamped on the wrapper for downstream CSS hooks.
			expect(block.getAttribute('data-attr-tone')).toBe('warn');
		} finally {
			editor.destroy();
			container.remove();
		}
	});

	it('renders a custom mark via descriptor.toDOM with nested mark support', () => {
		// `pill` is a custom mark whose descriptor returns an empty wrapper.
		// The editor places text (and any nested mark wrappers) inside it,
		// so combining `bold` + `pill` on the same span must still produce
		// a properly nested DOM tree rather than dropping the inner text.
		const pillMark = defineMark({
			name: 'pill',
			toDOM: (payload) => {
				const el = document.createElement('span');
				el.className = 'my-pill';
				if (payload.attrs.color) el.setAttribute('data-color', String(payload.attrs.color));
				return el;
			},
		});

		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock],
			registeredMarks: [boldMark, pillMark],
		});
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc' as const,
				children: [
					{
						id: newId(),
						type: 'paragraph',
						text: [{ text: 'tagged', marks: [{ type: 'bold' }, { type: 'pill', attrs: { color: 'red' } }] }],
					},
				],
			},
			autoFocus: false,
		});
		editor.mount();
		try {
			const pill = container.querySelector('.my-pill') as HTMLElement;
			expect(pill).toBeTruthy();
			expect(pill.getAttribute('data-color')).toBe('red');
			expect(pill.getAttribute('data-mark-type')).toBe('pill');
			// The bold wrapper is the outer mark in the span; pill is nested
			// inside it. Text leaf lives at the innermost level.
			expect(pill.textContent).toBe('tagged');
			const strong = container.querySelector('strong') as HTMLElement;
			expect(strong.contains(pill)).toBe(true);
		} finally {
			editor.destroy();
			container.remove();
		}
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Paste pipeline (Phase 1 — plain-text fidelity)
//
// Synthetic ClipboardEvents in Chromium accept a `clipboardData` init via the
// `DataTransfer` constructor. We dispatch into the editor root so the view's
// `paste` listener runs end-to-end. This exercises the new `onPaste` option
// that routes plain text through `pastePlainText` (block split on \n\n+,
// soft-break preservation on single \n).

function firePaste(root: HTMLElement, payload: { text?: string; html?: string }): void {
	const dt = new DataTransfer();
	if (payload.text) dt.setData('text/plain', payload.text);
	if (payload.html) dt.setData('text/html', payload.html);
	const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
	root.dispatchEvent(ev);
}

describe('paste pipeline — plain text', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => {
		env?.cleanup();
		env = null;
	});

	it('preserves a single \\n as a soft break inside one block', () => {
		env = setup();
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: 'line one\nline two' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(1);
		expect(doc.children[0]!.text![0]!.text).toBe('line one\nline two');
	});

	it('splits on a blank line into separate blocks of the same type', () => {
		env = setup();
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: 'first para\n\nsecond para\n\nthird' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(3);
		expect(doc.children[0]!.text![0]!.text).toBe('first para');
		expect(doc.children[1]!.text![0]!.text).toBe('second para');
		expect(doc.children[2]!.text![0]!.text).toBe('third');
		// All three blocks should be paragraphs (no type promotion across the split).
		expect(doc.children.every((c) => c.type === 'paragraph')).toBe(true);
		// Caret should land at end of last inserted chunk.
		const sel = env.editor.getState().selection;
		expect(sel?.head.path).toEqual([2]);
		expect(sel?.head.offset).toBe('third'.length);
	});

	it('combines hard and soft breaks (each chunk keeps embedded \\n)', () => {
		env = setup();
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: 'a\nb\n\nc\nd' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(2);
		expect(doc.children[0]!.text![0]!.text).toBe('a\nb');
		expect(doc.children[1]!.text![0]!.text).toBe('c\nd');
	});

	it('normalises Windows \\r\\n and lone \\r before splitting', () => {
		env = setup();
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: 'win\r\nlines\r\n\r\nmac\rclassic' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(2);
		expect(doc.children[0]!.text![0]!.text).toBe('win\nlines');
		expect(doc.children[1]!.text![0]!.text).toBe('mac\nclassic');
	});

	it('inserts pasted blocks at the caret position, splitting an existing block', () => {
		env = setup({ initial: ['hello world'] });
		// Caret in middle of "hello |world"
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 6 }, head: { path: [0], offset: 6 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: 'X\n\nY' });
		const doc = env.editor.getState().doc;
		// Original block becomes "hello X" (first chunk inserted at offset 6),
		// new block "Y" is created — but the rest of the original ("world")
		// stays in the *new* block after the splitBlock from the paste? No:
		// splitBlock takes the running offset (after first insert) which is
		// 7 ("hello X|"); the rest of the original ("world") moves to the
		// new block, then "Y" is inserted before "world".
		expect(doc.children).toHaveLength(2);
		expect(doc.children[0]!.text![0]!.text).toBe('hello X');
		expect(doc.children[1]!.text![0]!.text).toBe('Yworld');
	});

	it('replaces a non-collapsed selection with the pasted content', () => {
		env = setup({ initial: ['ABCDEFGH'] });
		// Select "CDEF"
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 2 }, head: { path: [0], offset: 6 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: 'X\n\nY' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(2);
		expect(doc.children[0]!.text![0]!.text).toBe('ABX');
		expect(doc.children[1]!.text![0]!.text).toBe('YGH');
	});

	it('paste is one undo step', () => {
		env = setup({ initial: ['start'] });
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 5 }, head: { path: [0], offset: 5 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: ' a\n\nb\n\nc' });
		expect(env.editor.getState().doc.children).toHaveLength(3);
		// History entry from the paste is the most recent push; popping it
		// once should restore the pre-paste doc.
		const entry = env.editor.history.popUndo();
		expect(entry).toBeTruthy();
		env.editor.setState(entry!.stateBefore);
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(1);
		expect(doc.children[0]!.text![0]!.text).toBe('start');
	});
});

describe('paste pipeline — markdown auto-detect', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => {
		env?.cleanup();
		env = null;
	});

	it('parses headings into heading blocks when pasted into an empty doc', () => {
		env = setup();
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: '# Heading 1\n\n## Heading 2\n\nBody copy' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(3);
		expect(doc.children[0]!.type).toBe('heading');
		expect(doc.children[0]!.attrs?.level).toBe(1);
		expect(doc.children[1]!.type).toBe('heading');
		expect(doc.children[1]!.attrs?.level).toBe(2);
		expect(doc.children[2]!.type).toBe('paragraph');
	});

	it('parses bullet lists', () => {
		env = setup();
		firePaste(getRoot(env.container), { text: '- one\n- two\n- three' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(3);
		expect(doc.children.every((c) => c.type === 'bulleted_list_item')).toBe(true);
	});

	it('parses fenced code blocks', () => {
		env = setup();
		firePaste(getRoot(env.container), { text: '```ts\nconst x = 1;\nconst y = 2;\n```' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(1);
		expect(doc.children[0]!.type).toBe('code');
		expect(doc.children[0]!.attrs?.language).toBe('ts');
		expect(doc.children[0]!.text![0]!.text).toBe('const x = 1;\nconst y = 2;');
	});

	it('does NOT trigger on plain prose with stray asterisks', () => {
		env = setup();
		// Inline-only markup — no block marker on any line — must fall through to plain text.
		firePaste(getRoot(env.container), { text: 'Yes I *think* so.\n\nMaybe **really**.' });
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(2);
		expect(doc.children[0]!.text![0]!.text).toBe('Yes I *think* so.');
		expect(doc.children[1]!.text![0]!.text).toBe('Maybe **really**.');
	});

	it('splits the current block when pasting markdown into mid-text', () => {
		env = setup({ initial: ['hello world'] });
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 6 }, head: { path: [0], offset: 6 } });
		tx.commit();
		firePaste(getRoot(env.container), { text: '# Big' });
		const doc = env.editor.getState().doc;
		// Original "hello |world" → ["hello ", "Big" (h1), "world"]
		expect(doc.children).toHaveLength(3);
		expect(doc.children[0]!.text![0]!.text).toBe('hello ');
		expect(doc.children[1]!.type).toBe('heading');
		expect(doc.children[1]!.text![0]!.text).toBe('Big');
		expect(doc.children[2]!.text![0]!.text).toBe('world');
	});
});

describe('paste pipeline — HTML clipboard', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => {
		env?.cleanup();
		env = null;
	});

	it('preserves heading + paragraph structure', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<h1>Title</h1><p>Body text</p>',
			text: 'Title\n\nBody text', // browsers always provide both; HTML wins
		});
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(2);
		expect(doc.children[0]!.type).toBe('heading');
		expect(doc.children[0]!.attrs?.level).toBe(1);
		expect(doc.children[0]!.text![0]!.text).toBe('Title');
		expect(doc.children[1]!.type).toBe('paragraph');
		expect(doc.children[1]!.text![0]!.text).toBe('Body text');
	});

	it('clamps H4-H6 to level 3 (plim only supports 1-3)', () => {
		env = setup();
		firePaste(getRoot(env.container), { html: '<h5>deep</h5>', text: 'deep' });
		const doc = env.editor.getState().doc;
		expect(doc.children[0]!.type).toBe('heading');
		expect(doc.children[0]!.attrs?.level).toBe(3);
	});

	it('preserves inline marks (bold, italic, code, link)', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<p>plain <strong>bold</strong> <em>italic</em> <code>code</code> <a href="https://example.com">link</a></p>',
			text: 'plain bold italic code link',
		});
		const doc = env.editor.getState().doc;
		const spans = doc.children[0]!.text!;
		const findSpan = (text: string) => spans.find((s) => s.text === text);
		expect(findSpan('bold')!.marks?.[0]?.type).toBe('bold');
		expect(findSpan('italic')!.marks?.[0]?.type).toBe('italic');
		expect(findSpan('code')!.marks?.[0]?.type).toBe('code');
		const link = findSpan('link');
		expect(link!.marks?.[0]?.type).toBe('link');
		expect(link!.marks?.[0]?.attrs?.href).toBe('https://example.com');
	});

	it('handles nested marks (bold inside italic)', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<p><em>start <strong>both</strong> end</em></p>',
			text: 'start both end',
		});
		const spans = env.editor.getState().doc.children[0]!.text!;
		const both = spans.find((s) => s.text === 'both')!;
		const types = (both.marks ?? []).map((m) => m.type).sort();
		expect(types).toEqual(['bold', 'italic']);
	});

	it('parses unordered lists into bulleted_list_item blocks', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<ul><li>one</li><li>two</li><li>three</li></ul>',
			text: '',
		});
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(3);
		expect(doc.children.every((b) => b.type === 'bulleted_list_item')).toBe(true);
		expect(doc.children.map((b) => b.text![0]!.text)).toEqual(['one', 'two', 'three']);
	});

	it('parses ordered lists into numbered_list_item blocks', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<ol><li>first</li><li>second</li></ol>',
			text: '',
		});
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(2);
		expect(doc.children.every((b) => b.type === 'numbered_list_item')).toBe(true);
	});

	it('parses pre/code with language class', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<pre><code class="language-ts">const x = 1;</code></pre>',
			text: 'const x = 1;',
		});
		const doc = env.editor.getState().doc;
		expect(doc.children[0]!.type).toBe('code');
		expect(doc.children[0]!.attrs?.language).toBe('ts');
		expect(doc.children[0]!.text![0]!.text).toBe('const x = 1;');
	});

	it('strips <script> tags via the sanitiser', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<p>safe</p><script>window.x = 1</script><p>also safe</p>',
			text: 'safe also safe',
		});
		const doc = env.editor.getState().doc;
		expect(doc.children).toHaveLength(2);
		// Confirm the script payload didn't leak into any block's text.
		for (const b of doc.children) {
			for (const s of b.text ?? []) {
				expect(s.text).not.toContain('window.x');
			}
		}
		// And — paranoia — the sanitiser shouldn't have left a script in the DOM either.
		expect(env.container.querySelector('script')).toBeNull();
	});

	it('drops `javascript:` link hrefs', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<p><a href="javascript:alert(1)">click</a></p>',
			text: 'click',
		});
		const span = env.editor.getState().doc.children[0]!.text![0]!;
		// The link mark should either be absent or not carry the dangerous href.
		const linkMarkInst = (span.marks ?? []).find((m) => m.type === 'link');
		if (linkMarkInst) {
			expect(linkMarkInst.attrs?.href ?? '').not.toMatch(/^javascript:/i);
		}
	});

	it('treats <br> as a soft break inside the run', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<p>line one<br>line two</p>',
			text: 'line one\nline two',
		});
		const text = env.editor.getState().doc.children[0]!.text!.map((s) => s.text).join('');
		expect(text).toBe('line one\nline two');
	});

	it('parses <hr> into a divider block', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<p>before</p><hr><p>after</p>',
			text: 'before\n\nafter',
		});
		const doc = env.editor.getState().doc;
		expect(doc.children.map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
	});

	it('parses <blockquote> into quote block', () => {
		env = setup();
		firePaste(getRoot(env.container), {
			html: '<blockquote>famous words</blockquote>',
			text: 'famous words',
		});
		expect(env.editor.getState().doc.children[0]!.type).toBe('quote');
	});
});

describe('paste pipeline — extension hook (transformPaste)', () => {
	let cleanup: (() => void) | null = null;
	afterEach(() => {
		cleanup?.();
		cleanup = null;
	});

	function setupWithExtension(transformPaste: (data: { text: string; html: string; files: File[] }, ctx: unknown) => boolean | undefined | void) {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock, headingBlock],
			registeredMarks: [boldMark],
			extensions: [
				() => ({
					name: 'test-paste',
					transformPaste,
				}),
			],
		});
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: { type: 'doc', children: [{ id: newId(), type: 'paragraph', text: [] }] },
			autoFocus: false,
		});
		editor.mount();
		cleanup = () => {
			editor.destroy();
			container.remove();
		};
		return { editor, container };
	}

	it('runs before the built-in pipeline; returning true prevents default behaviour', () => {
		const seen: Array<{ text: string; html: string; files: number }> = [];
		const env = setupWithExtension((data) => {
			seen.push({ text: data.text, html: data.html, files: data.files.length });
			return true; // claim ownership: built-in pipeline must NOT run
		});
		firePaste(getRoot(env.container), { text: 'hello', html: '<p>hello</p>' });
		// Doc should be unchanged (single empty paragraph) — extension owned the paste.
		expect(env.editor.getState().doc.children).toHaveLength(1);
		expect(env.editor.getState().doc.children[0]!.text ?? []).toEqual([]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ text: 'hello', html: '<p>hello</p>', files: 0 });
	});

	it('falls through to built-in pipeline when the extension returns falsy', () => {
		const env = setupWithExtension(() => undefined);
		firePaste(getRoot(env.container), { text: 'hello\n\nworld' });
		// Built-in plain-text path should have run since the extension declined.
		expect(env.editor.getState().doc.children).toHaveLength(2);
	});

	it('exposes clipboard files (Phase 5) via the same payload', () => {
		let captured: File[] | null = null;
		const env = setupWithExtension((data) => {
			captured = data.files;
			return true;
		});
		// Synthesise a paste with a file attachment. DataTransfer.items can
		// hold File objects as of recent Chromium; wrap a small text blob as
		// a "fake image" for the test.
		const dt = new DataTransfer();
		const fakeImage = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'pic.png', { type: 'image/png' });
		dt.items.add(fakeImage);
		const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
		getRoot(env.container).dispatchEvent(ev);
		expect(captured).not.toBeNull();
		expect(captured!.length).toBe(1);
		expect(captured![0]!.name).toBe('pic.png');
		expect(captured![0]!.type).toBe('image/png');
	});
});

// ───────────────────────────────────────────────────────────────────────
// Custom block ↔ paragraph type-change cleanup + `continueAs` Enter
// behavior. Both regressions live in `updateBlockElement` / `handleInsertParagraph`.
// ───────────────────────────────────────────────────────────────────────

describe('Custom block lifecycle', () => {
	function makeCallout() {
		return defineBlock({
			name: 'callout',
			type: 'standalone',
			supportsDecoration: true,
			continueAs: 'paragraph',
			toDOM: (payload) => {
				const wrap = document.createElement('div');
				wrap.className = 'plim-callout';
				wrap.setAttribute('data-tone', String(payload.attrs.tone ?? 'info'));
				const icon = document.createElement('span');
				icon.className = 'plim-callout-icon';
				icon.setAttribute('contenteditable', 'false');
				icon.textContent = '!';
				wrap.appendChild(icon);
				for (const node of payload.content as HTMLElement[]) wrap.appendChild(node);
				return wrap;
			},
		});
	}

	it('Backspace on empty callout converts cleanly to paragraph (no ghost callout chrome)', () => {
		// Repro: type into a callout, clear it, press Backspace at offset 0.
		// Bug was that `setBlockType('paragraph')` left the `.plim-callout`
		// chrome around because the type-change cleanup only stripped
		// known built-in selectors. Now we wipe ALL non-handle children.
		const calloutBlock = makeCallout();
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock, calloutBlock],
		});
		const blockId = newId();
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [{ id: blockId, type: 'callout', attrs: { tone: 'info' }, text: [] }],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		// Confirm callout chrome is initially mounted.
		expect(root.querySelector('.plim-callout')).toBeTruthy();
		// Place caret at offset 0 of the empty callout, then trigger
		// deleteContentBackward (what the browser fires on Backspace).
		const tx = editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
		tx.commit();
		const ev = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
		root.dispatchEvent(ev);
		// After the conversion, the block element is reused but its DOM
		// must have been wiped: no callout chrome remains, only a fresh
		// `[data-block-content]` for the new paragraph render.
		const block = root.querySelector('[data-block-id]') as HTMLElement;
		expect(block.getAttribute('data-block-type')).toBe('paragraph');
		expect(block.querySelector('.plim-callout')).toBeNull();
		expect(block.querySelector('.plim-callout-icon')).toBeNull();
		// Exactly one content slot, and it's empty.
		const slots = block.querySelectorAll('[data-block-content]');
		expect(slots.length).toBe(1);
		expect((slots[0] as HTMLElement).textContent).toBe('');
		editor.destroy();
		container.remove();
	});

	it('Enter on a callout creates a paragraph (continueAs), not another callout', () => {
		const calloutBlock = makeCallout();
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock, calloutBlock],
		});
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [{ id: newId(), type: 'callout', attrs: { tone: 'info' }, text: [{ text: 'hello' }] }],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		// Caret at end of callout text.
		const tx = editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 5 }, head: { path: [0], offset: 5 } });
		tx.commit();
		// Fire insertParagraph (Enter without Shift in beforeinput).
		const ev = new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true });
		root.dispatchEvent(ev);
		const state = editor.getState();
		expect(state.doc.children.length).toBe(2);
		expect(state.doc.children[0]!.type).toBe('callout');
		expect(state.doc.children[1]!.type).toBe('paragraph'); // the key assertion
		// And the callout's text is preserved on the left.
		expect(state.doc.children[0]!.text?.[0]?.text).toBe('hello');
		editor.destroy();
		container.remove();
	});

	it('Without continueAs, Enter on a custom block still propagates the same type (default behavior)', () => {
		const cardBlock = defineBlock({
			name: 'card',
			type: 'standalone',
			toDOM: (payload) => {
				const wrap = document.createElement('div');
				wrap.className = 'plim-card';
				for (const node of payload.content as HTMLElement[]) wrap.appendChild(node);
				return wrap;
			},
		});
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, cardBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [{ id: newId(), type: 'card', text: [{ text: 'one' }] }],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		const tx = editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 3 }, head: { path: [0], offset: 3 } });
		tx.commit();
		const ev = new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true });
		root.dispatchEvent(ev);
		const state = editor.getState();
		expect(state.doc.children.length).toBe(2);
		expect(state.doc.children[1]!.type).toBe('card'); // unchanged default behavior
		editor.destroy();
		container.remove();
	});
});

describe('Image block', () => {
	function setupImage(initialAttrs: Record<string, unknown> = { src: 'https://example.test/foo.png' }) {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, imageBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: newId(), type: 'image', attrs: initialAttrs },
					{ id: newId(), type: 'paragraph', text: [{ text: 'after' }] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		return {
			editor,
			container,
			cleanup: () => {
				editor.destroy();
				container.remove();
			},
		};
	}

	it('caption is contenteditable and isolated; typing into it does not corrupt the doc', () => {
		const { editor, container, cleanup } = setupImage();
		const cap = container.querySelector('.plim-image-caption') as HTMLElement;
		expect(cap).toBeTruthy();
		expect(cap.getAttribute('contenteditable')).toBe('true');
		expect(cap.getAttribute('data-plim-isolated')).toBe('true');
		// Type into caption: dispatching beforeinput should not modify the
		// image block's text/attrs, and should not preventDefault (browser
		// owns the input).
		cap.focus();
		const range = document.createRange();
		range.selectNodeContents(cap);
		range.collapse(false);
		const sel = document.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);
		const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 'h', bubbles: true, cancelable: true });
		cap.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
		// Image block still has only `attrs` set, no spurious `text`.
		const blk = editor.getState().doc.children[0]!;
		expect(blk.type).toBe('image');
		expect(blk.text).toBeUndefined();
		cleanup();
	});

	it('blur on caption commits attrs.caption when changed', () => {
		const { editor, container, cleanup } = setupImage();
		const cap = container.querySelector('.plim-image-caption') as HTMLElement;
		cap.focus();
		cap.textContent = 'a new caption';
		cap.dispatchEvent(new FocusEvent('blur'));
		expect((editor.getState().doc.children[0]!.attrs as { caption?: string }).caption).toBe('a new caption');
		cleanup();
	});

	it('Enter inside caption inserts a paragraph after the image instead of duplicating the block', () => {
		const { editor, container, cleanup } = setupImage();
		const cap = container.querySelector('.plim-image-caption') as HTMLElement;
		cap.focus();
		const range = document.createRange();
		range.selectNodeContents(cap);
		range.collapse(false);
		const sel = document.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);
		const before = editor.getState().doc.children.length;
		const ev = new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true });
		cap.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		const state = editor.getState();
		expect(state.doc.children.length).toBe(before + 1);
		// New block is a paragraph at index 1 (right after the image at 0).
		expect(state.doc.children[1]!.type).toBe('paragraph');
		// No second image was created.
		const images = state.doc.children.filter((b) => b.type === 'image');
		expect(images.length).toBe(1);
		// Selection moved into the new paragraph.
		expect(state.selection.head.path).toEqual([1]);
		cleanup();
	});

	it('resize handle is rendered and width attr is applied to the frame element', () => {
		const { editor, container, cleanup } = setupImage({ src: 'https://example.test/x.png', width: '50%' });
		const wrap = container.querySelector('.plim-image-wrap') as HTMLElement;
		const frame = container.querySelector('.plim-image-frame') as HTMLElement;
		const img = container.querySelector('img.plim-image') as HTMLImageElement;
		expect(img).toBeTruthy();
		expect(frame).toBeTruthy();
		expect(frame.style.width).toBe('50%');
		expect(wrap.style.width).toBe('');
		expect(img.style.width).toBe('');
		const handle = container.querySelector('.plim-image-resize') as HTMLElement;
		expect(handle).toBeTruthy();
		expect(handle.parentElement).toBe(frame);
		expect(handle.getAttribute('data-plim-isolated')).toBe('true');
		void editor;
		cleanup();
	});

	it('caption survives an unrelated transaction (renders preserve in-progress edits)', () => {
		const { editor, container, cleanup } = setupImage();
		const cap = container.querySelector('.plim-image-caption') as HTMLElement;
		cap.focus();
		// Mutate caption DOM directly (simulating in-progress typing) without
		// committing; the focused element must keep its text after a re-render.
		cap.textContent = 'in progress';
		// Trigger a transaction on a different block.
		const tx = editor.createTransaction();
		tx.insertText([1], 5, '!');
		tx.commit();
		const cap2 = container.querySelector('.plim-image-caption') as HTMLElement;
		expect(cap2).toBe(cap); // same element preserved
		expect(cap2.textContent).toBe('in progress');
		cleanup();
	});

	function selectViaHandle(blockEl: HTMLElement) {
		// Reproduce the production gesture: pointerdown on the drag
		// handle, then pointerup without movement (no drag started). The
		// handle dispatches `plim:handle-click` from finishSession when
		// `wasActive === false && !cancelled`.
		const handle = blockEl.querySelector('.plim-block-drag') as HTMLElement;
		expect(handle).toBeTruthy();
		const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 });
		handle.dispatchEvent(down);
		const up = new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 });
		handle.dispatchEvent(up);
	}

	it('clicking the drag handle selects the block (data-plim-block-selected)', () => {
		const { container, cleanup } = setupImage();
		const blockEl = container.querySelector('[data-block-type="image"]') as HTMLElement;
		selectViaHandle(blockEl);
		expect(blockEl.getAttribute('data-plim-block-selected')).toBe('true');
		// Pointerdown on the image body itself does NOT auto-select; it
		// clears any prior selection and falls through to native handling.
		const img = container.querySelector('img.plim-image') as HTMLImageElement;
		img.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
		expect(blockEl.hasAttribute('data-plim-block-selected')).toBe(false);
		cleanup();
	});

	it('drag handle click also selects text blocks', () => {
		const { container, cleanup } = setupImage();
		const para = container.querySelector('[data-block-type="paragraph"]') as HTMLElement;
		selectViaHandle(para);
		expect(para.getAttribute('data-plim-block-selected')).toBe('true');
		cleanup();
	});

	it('Backspace removes the selected atomic block and moves caret to previous block', () => {
		const { editor, container, cleanup } = setupImage();
		// Document is [image, paragraph "after"]. Adding a leading
		// paragraph so the deletion has a previous block to land in.
		const tx0 = editor.createTransaction();
		tx0.insertBlock([0], { id: newId(), type: 'paragraph', text: [{ text: 'before' }] });
		tx0.commit();
		expect(editor.getState().doc.children.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph']);
		// Select the image via its drag handle and Backspace.
		const imgBlock = container.querySelector('[data-block-type="image"]') as HTMLElement;
		selectViaHandle(imgBlock);
		expect(container.querySelector('[data-plim-block-selected="true"]')).toBeTruthy();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
		const state = editor.getState();
		expect(state.doc.children.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
		// Caret moved into the previous block at its end (offset 6 = 'before'.length).
		expect(state.selection.head.path).toEqual([0]);
		expect(state.selection.head.offset).toBe(6);
		// Block-selection cleared.
		expect(container.querySelector('[data-plim-block-selected="true"]')).toBeNull();
		cleanup();
	});

	it('Escape clears block selection without removing the block', () => {
		const { editor, container, cleanup } = setupImage();
		const imgBlock = container.querySelector('[data-block-type="image"]') as HTMLElement;
		selectViaHandle(imgBlock);
		expect(container.querySelector('[data-plim-block-selected="true"]')).toBeTruthy();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		expect(container.querySelector('[data-plim-block-selected="true"]')).toBeNull();
		expect(editor.getState().doc.children.length).toBe(2); // unchanged
		cleanup();
	});

	it('ArrowUp at offset 0 of paragraph after image selects the image', () => {
		const { editor, container, cleanup } = setupImage();
		// Caret at offset 0 of paragraph[1].
		const tx0 = editor.createTransaction();
		tx0.setSelection({ anchor: { path: [1], offset: 0 }, head: { path: [1], offset: 0 } });
		tx0.commit();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
		const sel = container.querySelector('[data-plim-block-selected="true"]') as HTMLElement;
		expect(sel).toBeTruthy();
		expect(sel.getAttribute('data-block-type')).toBe('image');
		cleanup();
	});

	it('ArrowDown while selected moves caret into next text block', () => {
		const { editor, container, cleanup } = setupImage();
		const imgBlock = container.querySelector('[data-block-type="image"]') as HTMLElement;
		selectViaHandle(imgBlock);
		const root = container.querySelector('.plim-editor') as HTMLElement;
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
		const state = editor.getState();
		expect(state.selection.head.path).toEqual([1]);
		expect(state.selection.head.offset).toBe(0);
		expect(container.querySelector('[data-plim-block-selected="true"]')).toBeNull();
		cleanup();
	});

	it('toolbar renders inside the frame with Replace/Align/Caption/Delete buttons', () => {
		const { container, cleanup } = setupImage();
		const frame = container.querySelector('.plim-image-frame') as HTMLElement;
		const toolbar = frame.querySelector('.plim-image-toolbar') as HTMLElement;
		expect(toolbar).toBeTruthy();
		expect(toolbar.getAttribute('data-plim-isolated')).toBe('true');
		const btns = Array.from(toolbar.querySelectorAll('.plim-image-toolbar-btn')) as HTMLButtonElement[];
		const labels = btns.map((b) => b.getAttribute('aria-label'));
		expect(labels).toEqual(['Replace image', 'Align image', 'Toggle caption', 'Delete image']);
		cleanup();
	});

	it('Align button cycles align attr left → center → right → left', () => {
		const { editor, container, cleanup } = setupImage();
		const alignBtn = container.querySelector('.plim-image-toolbar-align') as HTMLButtonElement;
		const wrap = container.querySelector('.plim-image-wrap') as HTMLElement;
		expect(wrap.getAttribute('data-align')).toBe('left');
		alignBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect((editor.getState().doc.children[0]!.attrs as { align?: string }).align).toBe('center');
		// After re-render the same button (re-found) advances to right.
		const alignBtn2 = container.querySelector('.plim-image-toolbar-align') as HTMLButtonElement;
		alignBtn2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect((editor.getState().doc.children[0]!.attrs as { align?: string }).align).toBe('right');
		const alignBtn3 = container.querySelector('.plim-image-toolbar-align') as HTMLButtonElement;
		alignBtn3.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect((editor.getState().doc.children[0]!.attrs as { align?: string }).align).toBe('left');
		cleanup();
	});

	it('Caption toggle button reveals an empty caption row by setting captionVisible', () => {
		const { editor, container, cleanup } = setupImage();
		const wrap = container.querySelector('.plim-image-wrap') as HTMLElement;
		// Empty caption: hidden by default.
		expect(wrap.getAttribute('data-caption-visible')).toBe('false');
		// Click caption toolbar btn (third button).
		const btns = container.querySelectorAll('.plim-image-toolbar-btn');
		const captionBtn = btns[2] as HTMLButtonElement;
		captionBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect((editor.getState().doc.children[0]!.attrs as { captionVisible?: boolean }).captionVisible).toBe(true);
		const wrap2 = container.querySelector('.plim-image-wrap') as HTMLElement;
		expect(wrap2.getAttribute('data-caption-visible')).toBe('true');
		cleanup();
	});

	it('Delete toolbar button removes the image block', () => {
		const { editor, container, cleanup } = setupImage();
		expect(editor.getState().doc.children.length).toBe(2);
		const btns = container.querySelectorAll('.plim-image-toolbar-btn');
		const deleteBtn = btns[3] as HTMLButtonElement;
		deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		const state = editor.getState();
		expect(state.doc.children.length).toBe(1);
		expect(state.doc.children[0]!.type).toBe('paragraph');
		cleanup();
	});

	it('caption row is hidden when caption is empty and visible when populated', () => {
		const { container, cleanup } = setupImage({ src: 'https://example.test/x.png', caption: 'hello' });
		const wrap = container.querySelector('.plim-image-wrap') as HTMLElement;
		expect(wrap.getAttribute('data-caption-visible')).toBe('true');
		const cap = container.querySelector('.plim-image-caption') as HTMLElement;
		expect(cap.textContent).toBe('hello');
		cleanup();
	});
});

describe('Multi-block selection', () => {
	function setupMulti(texts: string[] = ['one', 'two', 'three', 'four']) {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: texts.map((t) => ({ id: newId(), type: 'paragraph' as const, text: [{ text: t }] })),
			},
			autoFocus: false,
		});
		editor.mount();
		return {
			editor,
			container,
			cleanup: () => {
				editor.destroy();
				container.remove();
			},
		};
	}
	function selectViaHandle(blockEl: HTMLElement, mods: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) {
		const handle = blockEl.querySelector('.plim-block-drag') as HTMLElement;
		handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 }));
		// PointerEvent doesn't honour shiftKey/metaKey via constructor consistently
		// across DOM implementations, so dispatch a custom pointerup with the mods
		// inline; finishSession reads them from the event itself.
		const up = new PointerEvent('pointerup', {
			bubbles: true,
			cancelable: true,
			button: 0,
			pointerId: 1,
			clientX: 0,
			clientY: 0,
			shiftKey: mods.shiftKey ?? false,
			metaKey: mods.metaKey ?? false,
			ctrlKey: mods.ctrlKey ?? false,
		});
		handle.dispatchEvent(up);
	}
	function selectedIds(container: HTMLElement) {
		return Array.from(container.querySelectorAll('[data-plim-block-selected="true"]')).map((el) => el.getAttribute('data-block-id'));
	}

	it('shift+click on a second block selects the inclusive range', () => {
		const { container, cleanup } = setupMulti();
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		selectViaHandle(blocks[0]!);
		selectViaHandle(blocks[2]!, { shiftKey: true });
		const ids = selectedIds(container);
		// Should select indices 0, 1, 2 (inclusive).
		expect(ids).toHaveLength(3);
		expect(ids).toContain(blocks[0]!.getAttribute('data-block-id'));
		expect(ids).toContain(blocks[1]!.getAttribute('data-block-id'));
		expect(ids).toContain(blocks[2]!.getAttribute('data-block-id'));
		cleanup();
	});

	it('cmd/meta+click toggles a block in/out of the selection', () => {
		const { container, cleanup } = setupMulti();
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		selectViaHandle(blocks[0]!);
		selectViaHandle(blocks[2]!, { metaKey: true });
		expect(selectedIds(container)).toHaveLength(2);
		// Toggle off block 2.
		selectViaHandle(blocks[2]!, { metaKey: true });
		expect(selectedIds(container)).toEqual([blocks[0]!.getAttribute('data-block-id')]);
		cleanup();
	});

	it('plain click on another block replaces the selection', () => {
		const { container, cleanup } = setupMulti();
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		selectViaHandle(blocks[0]!);
		selectViaHandle(blocks[2]!, { shiftKey: true });
		expect(selectedIds(container)).toHaveLength(3);
		selectViaHandle(blocks[1]!);
		expect(selectedIds(container)).toEqual([blocks[1]!.getAttribute('data-block-id')]);
		cleanup();
	});

	it('Backspace with multi-selection removes all selected blocks', () => {
		const { editor, container, cleanup } = setupMulti(['a', 'b', 'c', 'd']);
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		selectViaHandle(blocks[1]!);
		selectViaHandle(blocks[2]!, { shiftKey: true });
		const root = container.querySelector('.plim-editor') as HTMLElement;
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
		const remaining = editor.getState().doc.children.map((b) => (b.text?.[0] as { text?: string } | undefined)?.text);
		expect(remaining).toEqual(['a', 'd']);
		expect(selectedIds(container)).toHaveLength(0);
		cleanup();
	});

	it('Escape with multi-selection clears all without modifying the doc', () => {
		const { editor, container, cleanup } = setupMulti();
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		selectViaHandle(blocks[0]!);
		selectViaHandle(blocks[2]!, { shiftKey: true });
		const before = editor.getState().doc.children.length;
		const root = container.querySelector('.plim-editor') as HTMLElement;
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		expect(selectedIds(container)).toHaveLength(0);
		expect(editor.getState().doc.children.length).toBe(before);
		cleanup();
	});

	it('Shift+ArrowDown extends the selection downward from the active end', () => {
		const { container, cleanup } = setupMulti();
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		selectViaHandle(blocks[0]!);
		const root = container.querySelector('.plim-editor') as HTMLElement;
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true }));
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true }));
		const ids = selectedIds(container);
		expect(ids).toHaveLength(3);
		expect(ids).toContain(blocks[0]!.getAttribute('data-block-id'));
		expect(ids).toContain(blocks[1]!.getAttribute('data-block-id'));
		expect(ids).toContain(blocks[2]!.getAttribute('data-block-id'));
		cleanup();
	});

	it('Shift+ArrowUp shrinks the selection back toward the anchor', () => {
		const { container, cleanup } = setupMulti();
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		selectViaHandle(blocks[0]!);
		selectViaHandle(blocks[2]!, { shiftKey: true });
		expect(selectedIds(container)).toHaveLength(3);
		const root = container.querySelector('.plim-editor') as HTMLElement;
		// Active end is blocks[2]; ArrowUp pulls it back to blocks[1].
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }));
		expect(selectedIds(container)).toHaveLength(2);
		cleanup();
	});

	it('multi-block drag commit moves the whole group preserving doc order', () => {
		const { editor, container, cleanup } = setupMulti(['a', 'b', 'c', 'd']);
		const root = container.querySelector('.plim-editor') as HTMLElement;
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		// Select blocks a + b (indices 0,1).
		selectViaHandle(blocks[0]!);
		selectViaHandle(blocks[1]!, { shiftKey: true });
		expect(selectedIds(container)).toHaveLength(2);
		// Simulate drag start on block 0, drop after block 3 ('d').
		const id0 = blocks[0]!.getAttribute('data-block-id')!;
		root.dispatchEvent(new CustomEvent('plim:dragstart', { bubbles: true, detail: { id: id0 } }));
		// Move drop indicator to block 3.
		const targetEl = blocks[3]!;
		const r = targetEl.getBoundingClientRect();
		root.dispatchEvent(new CustomEvent('plim:custom-drag-move', { bubbles: true, detail: { clientX: r.left + 10, clientY: r.bottom - 1 } }));
		root.dispatchEvent(new CustomEvent('plim:custom-drag-end', { bubbles: true, detail: { cancelled: false } }));
		const order = editor.getState().doc.children.map((b) => (b.text?.[0] as { text?: string } | undefined)?.text);
		// 'a' and 'b' moved to after 'd'.
		expect(order).toEqual(['c', 'd', 'a', 'b']);
		cleanup();
	});

	it('marquee drag in empty space selects intersecting blocks', () => {
		const { container, cleanup } = setupMulti();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		// Make root tall + give blocks predictable layout
		root.style.minHeight = '600px';
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		const r0 = blocks[0]!.getBoundingClientRect();
		const r2 = blocks[2]!.getBoundingClientRect();
		// Pointerdown on root background at x=2 (left gutter), y above first block top.
		const startX = r0.left + 2;
		const startY = r0.top + 2;
		const endX = r2.right - 2;
		const endY = r2.bottom - 2;
		root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 99, clientX: startX, clientY: startY }));
		// Dispatch a move that exceeds the threshold (so marquee starts).
		root.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 99, clientX: endX, clientY: endY }));
		root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 99, clientX: endX, clientY: endY }));
		const ids = selectedIds(container);
		// Should select at least blocks 0..2; block 3 may or may not depending on rect.
		expect(ids.length).toBeGreaterThanOrEqual(3);
		expect(ids).toContain(blocks[0]!.getAttribute('data-block-id'));
		expect(ids).toContain(blocks[1]!.getAttribute('data-block-id'));
		expect(ids).toContain(blocks[2]!.getAttribute('data-block-id'));
		cleanup();
	});

});
