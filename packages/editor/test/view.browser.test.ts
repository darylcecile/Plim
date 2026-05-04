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

	it('lets a registered descriptor override a built-in block type', () => {
		// Descriptors with a `name` matching a built-in (e.g. `code`) take
		// priority over the built-in render path. This is what powers the
		// example app's sugar-high-tokenized code block: it registers a
		// `code` descriptor with its own toDOM, and the view layer routes
		// rendering through that instead of the hardcoded `case 'code'`
		// switch arm.
		const customCodeBlock = defineBlock({
			name: 'code',
			type: 'standalone',
			supportsDecoration: false,
			toDOM: (payload) => {
				const wrap = document.createElement('section');
				wrap.className = 'my-custom-code';
				wrap.setAttribute('data-custom', 'yes');
				const code = document.createElement('code');
				code.setAttribute('data-block-content', 'true');
				code.textContent = payload.textContent;
				wrap.appendChild(code);
				return wrap;
			},
		});
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock, customCodeBlock],
			registeredMarks: [boldMark],
		});
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc' as const,
				children: [
					{
						id: newId(),
						type: 'code',
						text: [{ text: 'const x = 1;' }],
					},
				],
			},
			autoFocus: false,
		});
		editor.mount();
		try {
			const block = container.querySelector('[data-block-type="code"]') as HTMLElement;
			expect(block).toBeTruthy();
			// The custom toDOM ran (built-in `<pre>` would not be present).
			const customSection = block.querySelector('.my-custom-code') as HTMLElement;
			expect(customSection).toBeTruthy();
			expect(customSection.getAttribute('data-custom')).toBe('yes');
			expect(block.querySelector('pre')).toBeNull();
			// `[data-block-content]` is still present (descriptor's responsibility).
			const content = block.querySelector('[data-block-content]') as HTMLElement;
			expect(content).toBeTruthy();
			expect(content.tagName).toBe('CODE');
			expect(content.textContent).toBe('const x = 1;');
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
// Generic atom-active highlight
//
// Any mark whose toDOM wrapper carries `data-atomic="true"` is treated as an
// indivisible inline atom. When the caret sits at either edge of such a run
// the editor stamps `data-plim-atom-active="true"` on the wrapper so styling
// (focus ring, etc.) can react. The mechanism lives in the view layer and is
// shared across all atomic marks (mentions, status pills, future atoms).

describe('generic atom-active highlight', () => {
	it('stamps data-plim-atom-active on the wrapper when caret is at trailing or leading edge, clears when caret moves away', () => {
		const atomMark = defineMark({
			name: 'atom',
			toDOM: () => {
				const el = document.createElement('span');
				el.className = 'my-atom';
				el.setAttribute('data-atomic', 'true');
				return el;
			},
		});
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock],
			registeredMarks: [atomMark],
		});
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc' as const,
				children: [
					{
						id: newId(),
						type: 'paragraph',
						// Layout: "pre " + ATOM("tag") + " post"  →  offsets 0..4 (plain), 4..7 (atom), 7..12 (plain)
						text: [
							{ text: 'pre ' },
							{ text: 'tag', marks: [{ type: 'atom' }] },
							{ text: ' post' },
						],
					},
				],
			},
			autoFocus: false,
		});
		editor.mount();
		try {
			const atom = () => container.querySelector('.my-atom') as HTMLElement;
			const isActive = () => atom().getAttribute('data-plim-atom-active') === 'true';

			// Caret outside the atom run → no highlight.
			let tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
			editor.dispatch(tx);
			expect(isActive()).toBe(false);

			// Caret at trailing edge of atom (offset 7).
			tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 7 }, head: { path: [0], offset: 7 } });
			editor.dispatch(tx);
			expect(isActive()).toBe(true);

			// Caret at leading edge of atom (offset 4).
			tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 4 }, head: { path: [0], offset: 4 } });
			editor.dispatch(tx);
			expect(isActive()).toBe(true);

			// Caret well past the atom → highlight cleared.
			tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 10 }, head: { path: [0], offset: 10 } });
			editor.dispatch(tx);
			expect(isActive()).toBe(false);
		} finally {
			editor.destroy();
			container.remove();
		}
	});

	it('only highlights the adjacent atom when multiple atoms exist in the same block', () => {
		const atomMark = defineMark({
			name: 'atom',
			toDOM: () => {
				const el = document.createElement('span');
				el.className = 'my-atom';
				el.setAttribute('data-atomic', 'true');
				return el;
			},
		});
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock],
			registeredMarks: [atomMark],
		});
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc' as const,
				children: [
					{
						id: newId(),
						type: 'paragraph',
						// "A" + ATOM("one") + " B " + ATOM("two") + " C"
						// offsets: 0..1, 1..4, 4..7, 7..10, 10..12
						text: [
							{ text: 'A' },
							{ text: 'one', marks: [{ type: 'atom' }] },
							{ text: ' B ' },
							{ text: 'two', marks: [{ type: 'atom' }] },
							{ text: ' C' },
						],
					},
				],
			},
			autoFocus: false,
		});
		editor.mount();
		try {
			const atoms = () => Array.from(container.querySelectorAll('.my-atom')) as HTMLElement[];
			const activeIdx = () =>
				atoms().findIndex((a) => a.getAttribute('data-plim-atom-active') === 'true');

			// Trailing edge of first atom (offset 4).
			let tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 4 }, head: { path: [0], offset: 4 } });
			editor.dispatch(tx);
			expect(activeIdx()).toBe(0);

			// Leading edge of second atom (offset 7).
			tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 7 }, head: { path: [0], offset: 7 } });
			editor.dispatch(tx);
			expect(activeIdx()).toBe(1);

			// Between the two atoms (offset 5) → neither active.
			tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 5 }, head: { path: [0], offset: 5 } });
			editor.dispatch(tx);
			expect(activeIdx()).toBe(-1);
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

// ──────────────────────────────────────────────────────────────────────────────
// Copy / cut → markdown pipeline.
// Verifies registered blocks' `toMarkdown` actually fires on clipboard events
// (not just when contentToMarkdown is called explicitly). Synthesises copy/cut
// ClipboardEvents the same way paste tests do — DataTransfer init + dispatch
// against the editor root.

describe('clipboard copy/cut → markdown', () => {
	function fireClipboard(root: HTMLElement, kind: 'copy' | 'cut'): { md: string; plain: string; defaultPrevented: boolean } {
		const dt = new DataTransfer();
		const ev = new ClipboardEvent(kind, { clipboardData: dt, bubbles: true, cancelable: true });
		root.dispatchEvent(ev);
		return {
			md: dt.getData('text/markdown'),
			plain: dt.getData('text/plain'),
			defaultPrevented: ev.defaultPrevented,
		};
	}

	it('copies a multi-block selection through each descriptor toMarkdown', () => {
		// Use a custom block with a non-trivial toMarkdown so we can prove the
		// hook fires (rather than the browser's default DOM serialization).
		const calloutBlock = defineBlock({
			name: 'callout',
			type: 'standalone',
			supportsDecoration: true,
			toDOM: (payload) => {
				const wrap = document.createElement('aside');
				wrap.className = 'plim-callout';
				for (const node of payload.content as HTMLElement[]) wrap.appendChild(node);
				return wrap;
			},
			toMarkdown: (payload) => `> [!note] ${payload.textContent}`,
		});
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, calloutBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: newId(), type: 'paragraph', text: [{ text: 'before' }] },
					{ id: newId(), type: 'callout', text: [{ text: 'heads up' }] },
					{ id: newId(), type: 'paragraph', text: [{ text: 'after' }] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		// Multi-select callout + paragraph after via shift-range.
		const handleA = blocks[1]!.querySelector('.plim-block-drag') as HTMLElement;
		const handleB = blocks[2]!.querySelector('.plim-block-drag') as HTMLElement;
		handleA.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
		handleA.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
		handleB.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
		handleB.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, shiftKey: true }));
		const root = container.querySelector('.plim-editor') as HTMLElement;
		const r = fireClipboard(root, 'copy');
		expect(r.defaultPrevented).toBe(true);
		// callout's toMarkdown should appear in the output, proving the hook ran.
		expect(r.md).toContain('> [!note] heads up');
		expect(r.md).toContain('after');
		// Plain-text mirror equals markdown for now.
		expect(r.plain).toBe(r.md);
		// Doc unchanged on copy.
		expect(editor.getState().doc.children).toHaveLength(3);
		editor.destroy();
		container.remove();
	});

	it('cuts a multi-block selection: writes markdown AND removes the blocks', () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: ['a', 'b', 'c', 'd'].map((t) => ({ id: newId(), type: 'paragraph' as const, text: [{ text: t }] })),
			},
			autoFocus: false,
		});
		editor.mount();
		const blocks = Array.from(container.querySelectorAll('[data-block-id]')) as HTMLElement[];
		const h1 = blocks[1]!.querySelector('.plim-block-drag') as HTMLElement;
		const h2 = blocks[2]!.querySelector('.plim-block-drag') as HTMLElement;
		h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
		h1.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
		h2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
		h2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, shiftKey: true }));
		const root = container.querySelector('.plim-editor') as HTMLElement;
		const r = fireClipboard(root, 'cut');
		expect(r.defaultPrevented).toBe(true);
		expect(r.md).toContain('b');
		expect(r.md).toContain('c');
		// Cut should leave only 'a' and 'd'.
		const remaining = editor.getState().doc.children.map((b) => (b.text ?? [])[0]?.text ?? '');
		expect(remaining).toEqual(['a', 'd']);
		editor.destroy();
		container.remove();
	});

	it('copies a cross-block text range with trimmed start/end', () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: newId(), type: 'paragraph' as const, text: [{ text: 'hello world' }] },
					{ id: newId(), type: 'paragraph' as const, text: [{ text: 'middle line' }] },
					{ id: newId(), type: 'paragraph' as const, text: [{ text: 'goodbye now' }] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		// Set text-range selection from offset 6 of block 0 ("world") through
		// offset 7 of block 2 ("goodbye"). Use a transaction so PSelection is
		// authoritative (DOM selection isn't synced for this test path).
		const tx = editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 6 }, head: { path: [2], offset: 7 } });
		tx.commit();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		const r = fireClipboard(root, 'copy');
		expect(r.defaultPrevented).toBe(true);
		// Start: "world", end: "goodbye", middle: full "middle line".
		expect(r.md).toContain('world');
		expect(r.md).toContain('middle line');
		expect(r.md).toContain('goodbye');
		expect(r.md).not.toContain('hello ');
		expect(r.md).not.toContain(' now');
		// Doc unchanged on copy.
		expect(editor.getState().doc.children).toHaveLength(3);
		editor.destroy();
		container.remove();
	});

	it('does NOT intercept copy of a single-block text range (lets native handle inline copy)', () => {
		const { editor, container, cleanup } = setupMulti(['hello world']);
		const tx = editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		const r = fireClipboard(root, 'copy');
		// Native copy untouched: nothing written, default not prevented.
		expect(r.defaultPrevented).toBe(false);
		expect(r.md).toBe('');
		cleanup();
	});

	function setupMulti(texts: string[]) {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: { type: 'doc', children: texts.map((t) => ({ id: newId(), type: 'paragraph' as const, text: [{ text: t }] })) },
			autoFocus: false,
		});
		editor.mount();
		return { editor, container, cleanup: () => { editor.destroy(); container.remove(); } };
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// Paste pipeline: lossless plim-native MIME + descriptor.fromMarkdown.

describe('clipboard paste — plim-native MIME (application/x-plim)', () => {
	function firePaste(root: HTMLElement, payloads: { text?: string; html?: string; plim?: string }): void {
		const dt = new DataTransfer();
		if (payloads.text) dt.setData('text/plain', payloads.text);
		if (payloads.html) dt.setData('text/html', payloads.html);
		if (payloads.plim) dt.setData('application/x-plim', payloads.plim);
		const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
		root.dispatchEvent(ev);
	}

	it('restores blocks losslessly when the clipboard carries the plim envelope', () => {
		const calloutBlock = defineBlock({
			name: 'callout',
			type: 'standalone',
			toDOM: (payload) => {
				const el = document.createElement('aside');
				for (const node of payload.content as HTMLElement[]) el.appendChild(node);
				return el;
			},
		});
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, calloutBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: { type: 'doc', children: [{ id: newId(), type: 'paragraph', text: [] }] },
			autoFocus: false,
		});
		editor.mount();
		// Synthesise a plim-native paste with a callout (with custom attrs)
		// and a paragraph after it.
		const envelope = JSON.stringify({
			version: 1,
			blocks: [
				{ id: 'src1', type: 'callout', attrs: { tone: 'warn' }, text: [{ text: 'careful' }] },
				{ id: 'src2', type: 'paragraph', text: [{ text: 'and another' }] },
			],
		});
		const root = container.querySelector('.plim-editor') as HTMLElement;
		firePaste(root, { plim: envelope, text: 'careful\nand another' });
		const doc = editor.getState().doc;
		// Empty target paragraph replaced in place: now exactly the two blocks.
		expect(doc.children).toHaveLength(2);
		expect(doc.children[0]!.type).toBe('callout');
		expect(doc.children[0]!.attrs?.tone).toBe('warn');
		expect(doc.children[0]!.id).not.toBe('src1'); // re-id'd to avoid collisions
		expect(doc.children[1]!.type).toBe('paragraph');
		editor.destroy();
		container.remove();
	});

	it('rejects an envelope with a higher version (forward compat)', () => {
		const { container, editor, cleanup } = (() => {
			const c = document.createElement('div');
			document.body.appendChild(c);
			const plim = new PlimDriver({ registeredBlocks: [paragraphBlock] });
			const e = deriveEditor(plim, {
				containerAdapter: attachContainer(() => c),
				initialContent: { type: 'doc', children: [{ id: newId(), type: 'paragraph', text: [{ text: 'hello' }] }] },
				autoFocus: false,
			});
			e.mount();
			return { container: c, editor: e, cleanup: () => { e.destroy(); c.remove(); } };
		})();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		firePaste(root, {
			plim: JSON.stringify({ version: 999, blocks: [{ id: 'x', type: 'paragraph', text: [{ text: 'X' }] }] }),
			text: 'X',
		});
		// Falls through to plain-text path: 'X' inserted at caret (start, given no selection set).
		const doc = editor.getState().doc;
		expect(doc.children[0]!.text![0]!.text).toContain('X');
		// We're not asserting exact behaviour here — only that the editor
		// didn't accept the unknown-version envelope and crash.
		cleanup();
	});

	it('falls back to markdown + descriptor.fromMarkdown when no plim MIME is present', () => {
		// Callout descriptor with `fromMarkdown` so a plain markdown channel
		// (e.g. another markdown app) can still round-trip into a callout.
		const calloutBlock = defineBlock({
			name: 'callout',
			type: 'standalone',
			toDOM: (payload) => {
				const el = document.createElement('aside');
				for (const node of payload.content as HTMLElement[]) el.appendChild(node);
				return el;
			},
			toMarkdown: (p) => `> [!${String(p.attrs.tone ?? 'NOTE').toUpperCase()}] ${p.textContent}`,
			fromMarkdown: ({ lines, index, parseInline }) => {
				const line = lines[index] ?? '';
				const m = /^>\s+\[!(\w+)\]\s+(.*)$/.exec(line);
				if (!m) return null;
				return { block: { id: 'src', type: 'callout', attrs: { tone: m[1]!.toLowerCase() }, text: parseInline(m[2]!) }, consumed: 1 };
			},
		});
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, calloutBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: { type: 'doc', children: [{ id: newId(), type: 'paragraph', text: [] }] },
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		// No `plim` MIME — only the markdown text. Without the hook this
		// would parse as a quote block; with the hook, callout wins.
		firePaste(root, { text: '> [!INFO] heads up' });
		const doc = editor.getState().doc;
		expect(doc.children).toHaveLength(1);
		expect(doc.children[0]!.type).toBe('callout');
		expect(doc.children[0]!.attrs?.tone).toBe('info');
		editor.destroy();
		container.remove();
	});
});

describe('multilineText block descriptor', () => {
	// Defines a tiny `code`-like block whose `multilineText: true` flag
	// makes Enter insert a literal `\n` and ArrowDown / ArrowRight at
	// end-of-line exit to the next block (or auto-create a trailing
	// paragraph). The descriptor renders a plain `<pre><code>` so the
	// editor's normal text/selection plumbing applies — no custom DOM
	// quirks influence the assertions.
	function multilineCode() {
		return defineBlock({
			name: 'code',
			type: 'standalone',
			supportsDecoration: false,
			multilineText: true,
			toDOM: () => {
				const pre = document.createElement('pre');
				const code = document.createElement('code');
				code.setAttribute('data-block-content', 'true');
				pre.appendChild(code);
				return pre;
			},
		});
	}

	function setupCode(initial: { type: string; text?: { text: string }[] }[]): {
		container: HTMLElement;
		editor: AgnosticEditor;
		root: HTMLElement;
		cleanup: () => void;
	} {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, multilineCode()] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: initial.map((b) => ({ id: newId(), type: b.type, text: b.text ?? [] })),
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		return { container, editor, root, cleanup: () => { editor.destroy(); container.remove(); } };
	}

	it('Enter inside a multilineText block inserts a newline rather than splitting', () => {
		const env = setupCode([
			{ type: 'code', text: [{ text: 'hello' }] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 5 }, head: { path: [0], offset: 5 } });
			tx.commit();
			env.root.dispatchEvent(
				new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }),
			);
			const doc = env.editor.getState().doc;
			expect(doc.children).toHaveLength(1);
			expect(doc.children[0]!.type).toBe('code');
			// Plain text now contains a literal `\n` at the caret position.
			expect(doc.children[0]!.text!.map((s) => s.text).join('')).toBe('hello\n');
			const sel = env.editor.getState().selection;
			expect(sel.head.offset).toBe(6);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowDown at end of last line exits to the next block when one exists', () => {
		const env = setupCode([
			{ type: 'code', text: [{ text: 'a\nb' }] },
			{ type: 'paragraph', text: [{ text: 'after' }] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 3 }, head: { path: [0], offset: 3 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			const sel = env.editor.getState().selection;
			expect(sel.head.path).toEqual([1]);
			expect(sel.head.offset).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowDown on a non-last line lets the browser handle it (no exit)', () => {
		const env = setupCode([
			{ type: 'code', text: [{ text: 'a\nb' }] },
			{ type: 'paragraph', text: [{ text: 'after' }] },
		]);
		try {
			// Caret on the *first* line of the code block — there's still a
			// `\n` after it, so ArrowDown should not preventDefault. We
			// observe this by confirming the selection didn't get
			// programmatically moved into block [1].
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 1 }, head: { path: [0], offset: 1 } });
			tx.commit();
			const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
			env.root.dispatchEvent(ev);
			expect(ev.defaultPrevented).toBe(false);
			const sel = env.editor.getState().selection;
			expect(sel.head.path).toEqual([0]);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowRight at end of block exits to the next block', () => {
		const env = setupCode([
			{ type: 'code', text: [{ text: 'x' }] },
			{ type: 'paragraph', text: [{ text: 'next' }] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 1 }, head: { path: [0], offset: 1 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
			);
			const sel = env.editor.getState().selection;
			expect(sel.head.path).toEqual([1]);
			expect(sel.head.offset).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowDown at end of last block auto-creates a trailing paragraph', () => {
		const env = setupCode([
			{ type: 'code', text: [{ text: 'only' }] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 4 }, head: { path: [0], offset: 4 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			const doc = env.editor.getState().doc;
			expect(doc.children).toHaveLength(2);
			expect(doc.children[1]!.type).toBe('paragraph');
			expect(doc.children[1]!.text).toEqual([]);
			const sel = env.editor.getState().selection;
			expect(sel.head.path).toEqual([1]);
			expect(sel.head.offset).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowDown at end of an empty multilineText block does not create a trailing paragraph', () => {
		// Guard against accidental paragraph-spam on every ArrowDown when
		// the block has no content yet.
		const env = setupCode([
			{ type: 'code', text: [] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			const doc = env.editor.getState().doc;
			expect(doc.children).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});

describe('Trailing-paragraph autocreate (last block)', () => {
	// The autocreate rule isn't gated on `multilineText` — any non-empty,
	// non-paragraph block at the end of the doc should produce a fresh
	// paragraph on ArrowDown / ArrowRight so users have somewhere to keep
	// typing. Plain paragraphs are intentionally exempted: ArrowDown at
	// the bottom of an idle doc shouldn't spam empties.
	function setupBasic(initial: { type: string; text?: { text: string }[] }[]): {
		container: HTMLElement;
		editor: AgnosticEditor;
		root: HTMLElement;
		cleanup: () => void;
	} {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, headingBlock, quoteBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: initial.map((b) => ({ id: newId(), type: b.type, text: b.text ?? [] })),
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		return { container, editor, root, cleanup: () => { editor.destroy(); container.remove(); } };
	}

	it('ArrowDown at end of last heading creates a trailing paragraph', () => {
		const env = setupBasic([
			{ type: 'heading', text: [{ text: 'Title' }] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 5 }, head: { path: [0], offset: 5 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			const doc = env.editor.getState().doc;
			expect(doc.children).toHaveLength(2);
			expect(doc.children[1]!.type).toBe('paragraph');
			const sel = env.editor.getState().selection;
			expect(sel.head.path).toEqual([1]);
			expect(sel.head.offset).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowRight at end of last quote creates a trailing paragraph', () => {
		const env = setupBasic([
			{ type: 'quote', text: [{ text: 'wisdom' }] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 6 }, head: { path: [0], offset: 6 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
			);
			const doc = env.editor.getState().doc;
			expect(doc.children).toHaveLength(2);
			expect(doc.children[1]!.type).toBe('paragraph');
			const sel = env.editor.getState().selection;
			expect(sel.head.path).toEqual([1]);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowDown at end of last (non-empty) paragraph creates a trailing paragraph', () => {
		// Notion behaviour: at the bottom of a finished paragraph,
		// ArrowDown gives the user a fresh line to keep typing. The
		// "no spam" property is preserved because the new paragraph is
		// empty (`len === 0`), so a follow-up ArrowDown short-circuits
		// via the empty-block guard below.
		const env = setupBasic([
			{ type: 'paragraph', text: [{ text: 'tail' }] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 4 }, head: { path: [0], offset: 4 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			const doc = env.editor.getState().doc;
			expect(doc.children).toHaveLength(2);
			expect(doc.children[1]!.type).toBe('paragraph');
			expect(doc.children[1]!.text).toEqual([]);
			const sel = env.editor.getState().selection;
			expect(sel.head.path).toEqual([1]);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowDown twice at end of last paragraph still only creates one trailing paragraph (empty-block guard)', () => {
		const env = setupBasic([
			{ type: 'paragraph', text: [{ text: 'tail' }] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 4 }, head: { path: [0], offset: 4 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			const doc = env.editor.getState().doc;
			expect(doc.children).toHaveLength(2);
		} finally {
			env.cleanup();
		}
	});

	it('ArrowDown at end of empty heading does NOT create a trailing paragraph', () => {
		// `len > 0` guard: an empty block isn't really "the last
		// non-empty block" — pressing ArrowDown shouldn't spawn a
		// sibling for what is itself a fresh empty.
		const env = setupBasic([
			{ type: 'heading', text: [] },
		]);
		try {
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 0 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			const doc = env.editor.getState().doc;
			expect(doc.children).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});

describe('Arrow into atomic neighbour from mid-block (visual-line)', () => {
	// Native browser ArrowDown skips non-editable atomic blocks (they're
	// outside the text flow), so when the caret is on the last visual
	// line of the current text block and the next sibling is atomic, we
	// have to intercept and block-select the atom — otherwise the caret
	// jumps right past it into the block beyond. Same idea in reverse
	// for ArrowUp into an atomic prev sibling.
	function setupAtom() {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, imageBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: 'p-before', type: 'paragraph', text: [{ text: 'before atom' }] },
					{ id: 'img', type: 'image', attrs: { src: 'https://example.test/x.png' } },
					{ id: 'p-after', type: 'paragraph', text: [{ text: 'after atom' }] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		return { container, editor, root, cleanup: () => { editor.destroy(); container.remove(); } };
	}

	it('ArrowDown from mid-paragraph block-selects the next atomic sibling (no offset gate)', () => {
		const env = setupAtom();
		try {
			// Caret at offset 3 of "before atom" — NOT at end-of-block.
			// Without the visual-edge fix, native ArrowDown skips the
			// image and lands in the paragraph after.
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 3 }, head: { path: [0], offset: 3 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
			);
			const selected = env.container.querySelectorAll('[data-plim-block-selected="true"]');
			expect(selected.length).toBe(1);
			expect(selected[0]!.getAttribute('data-block-id')).toBe('img');
		} finally {
			env.cleanup();
		}
	});

	it('ArrowUp from mid-paragraph block-selects the previous atomic sibling (no offset gate)', () => {
		const env = setupAtom();
		try {
			// Caret at offset 3 of "after atom" — NOT at offset 0.
			const tx = env.editor.createTransaction();
			tx.setSelection({ anchor: { path: [2], offset: 3 }, head: { path: [2], offset: 3 } });
			tx.commit();
			env.root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
			);
			const selected = env.container.querySelectorAll('[data-plim-block-selected="true"]');
			expect(selected.length).toBe(1);
			expect(selected[0]!.getAttribute('data-block-id')).toBe('img');
		} finally {
			env.cleanup();
		}
	});

	it('ArrowDown when next sibling is a text block falls through to native (no atomic interception)', () => {
		// Without an atomic next sibling, mid-block ArrowDown should
		// NOT preventDefault — the browser handles caret movement into
		// the next text block natively.
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: 'p1', type: 'paragraph', text: [{ text: 'one' }] },
					{ id: 'p2', type: 'paragraph', text: [{ text: 'two' }] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		try {
			const tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [0], offset: 1 }, head: { path: [0], offset: 1 } });
			tx.commit();
			const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
			root.dispatchEvent(ev);
			// No block-selection took place.
			expect(container.querySelectorAll('[data-plim-block-selected="true"]').length).toBe(0);
			// Default not prevented (browser still moves caret natively).
			expect(ev.defaultPrevented).toBe(false);
		} finally {
			editor.destroy();
			container.remove();
		}
	});
});

describe('Enter while a block is selected', () => {
	// Pressing Enter on a block-selected block (e.g. an image atom or
	// any block reached via the drag-handle / Esc / arrow-key
	// selection) should drop out of block-selection mode and into a
	// new empty paragraph right after the selection. Matches Notion.
	it('inserts a fresh paragraph after the selected block and moves caret into it', () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, imageBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: 'p1', type: 'paragraph', text: [{ text: 'before' }] },
					{ id: 'img', type: 'image', attrs: { src: 'https://example.test/x.png' } },
					{ id: 'p2', type: 'paragraph', text: [{ text: 'after' }] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		try {
			// Block-select the image via the drag handle (mirrors
			// real user flow, also exercises the selection wiring).
			const imgEl = container.querySelector('[data-block-id="img"]') as HTMLElement;
			const handle = imgEl.querySelector('.plim-block-drag') as HTMLElement;
			handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 }));
			handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 }));
			expect(imgEl.getAttribute('data-plim-block-selected')).toBe('true');
			// Press Enter.
			root.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
			);
			const state = editor.getState();
			// Doc grew by one block; new block is a paragraph at index 2.
			expect(state.doc.children).toHaveLength(4);
			expect(state.doc.children[2]!.type).toBe('paragraph');
			expect(state.doc.children[2]!.text).toEqual([]);
			// The originally-trailing paragraph ('after') is now at index 3.
			expect(state.doc.children[3]!.id).toBe('p2');
			// Caret landed in the new paragraph.
			expect(state.selection.head.path).toEqual([2]);
			expect(state.selection.head.offset).toBe(0);
			// Block-selection cleared.
			expect(container.querySelectorAll('[data-plim-block-selected="true"]').length).toBe(0);
		} finally {
			editor.destroy();
			container.remove();
		}
	});
});

describe('Backspace at start of empty paragraph with atomic prev', () => {
	// Default joinBackward into an atomic prev *removes* the atom
	// (treats it like a divider). For an empty paragraph that's the
	// wrong direction — the user pressed Backspace because the
	// paragraph was unwanted, not the atom. Notion: empty paragraph
	// is removed, atom above is block-selected.
	it('removes the empty paragraph and block-selects the atomic prev', () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, imageBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: 'p1', type: 'paragraph', text: [{ text: 'before' }] },
					{ id: 'img', type: 'image', attrs: { src: 'https://example.test/x.png' } },
					{ id: 'empty', type: 'paragraph', text: [] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		try {
			const tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [2], offset: 0 }, head: { path: [2], offset: 0 } });
			tx.commit();
			root.dispatchEvent(
				new InputEvent('beforeinput', {
					inputType: 'deleteContentBackward',
					bubbles: true,
					cancelable: true,
				}),
			);
			const state = editor.getState();
			expect(state.doc.children).toHaveLength(2);
			expect(state.doc.children[0]!.id).toBe('p1');
			expect(state.doc.children[1]!.id).toBe('img');
			const selected = container.querySelectorAll('[data-plim-block-selected="true"]');
			expect(selected.length).toBe(1);
			expect(selected[0]!.getAttribute('data-block-id')).toBe('img');
		} finally {
			editor.destroy();
			container.remove();
		}
	});

	it('does NOT trigger when the empty paragraph has a text-block prev (joins normally)', () => {
		// Sanity: existing joinBackward into a text prev (caret to
		// end of prev) preserved.
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: 'p1', type: 'paragraph', text: [{ text: 'hello' }] },
					{ id: 'empty', type: 'paragraph', text: [] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		try {
			const tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [1], offset: 0 }, head: { path: [1], offset: 0 } });
			tx.commit();
			root.dispatchEvent(
				new InputEvent('beforeinput', {
					inputType: 'deleteContentBackward',
					bubbles: true,
					cancelable: true,
				}),
			);
			const state = editor.getState();
			expect(state.doc.children).toHaveLength(1);
			expect(state.doc.children[0]!.id).toBe('p1');
			expect(state.selection.head.path).toEqual([0]);
			expect(state.selection.head.offset).toBe(5);
			expect(container.querySelectorAll('[data-plim-block-selected="true"]').length).toBe(0);
		} finally {
			editor.destroy();
			container.remove();
		}
	});

	it('does NOT trigger from a non-empty paragraph (existing joinBackward semantics preserved)', () => {
		// If the paragraph has content, joinBackward into atomic prev
		// retains its old behaviour. The escape hatch only kicks in
		// when the paragraph itself is empty.
		const container = document.createElement('div');
		document.body.appendChild(container);
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, imageBlock] });
		const editor = deriveEditor(plim, {
			containerAdapter: attachContainer(() => container),
			initialContent: {
				type: 'doc',
				children: [
					{ id: 'img', type: 'image', attrs: { src: 'https://example.test/x.png' } },
					{ id: 'p', type: 'paragraph', text: [{ text: 'tail' }] },
				],
			},
			autoFocus: false,
		});
		editor.mount();
		const root = container.querySelector('.plim-editor') as HTMLElement;
		try {
			const tx = editor.createTransaction();
			tx.setSelection({ anchor: { path: [1], offset: 0 }, head: { path: [1], offset: 0 } });
			tx.commit();
			root.dispatchEvent(
				new InputEvent('beforeinput', {
					inputType: 'deleteContentBackward',
					bubbles: true,
					cancelable: true,
				}),
			);
			const state = editor.getState();
			// Image got removed (existing joinBackward behaviour).
			expect(state.doc.children).toHaveLength(1);
			expect(state.doc.children[0]!.id).toBe('p');
			expect(container.querySelectorAll('[data-plim-block-selected="true"]').length).toBe(0);
		} finally {
			editor.destroy();
			container.remove();
		}
	});
});

describe('Floating selection toolbar', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => {
		env?.cleanup();
		env = null;
		// Defensive: tear down any lingering toolbars from prior tests.
		for (const t of Array.from(document.querySelectorAll('.plim-toolbar'))) t.remove();
	});

	function getToolbar(): HTMLElement | null {
		return document.querySelector('.plim-toolbar');
	}

	function focusEditor(root: HTMLElement) {
		root.focus();
	}

	it('mounts a hidden toolbar element on document.body when the editor mounts', () => {
		env = setup({ initial: ['hello world'] });
		const tb = getToolbar();
		expect(tb).not.toBeNull();
		expect(tb!.style.display).toBe('none');
		expect(tb!.parentElement).toBe(document.body);
		expect(tb!.getAttribute('data-plim-isolated')).toBe('true');
		expect(tb!.getAttribute('role')).toBe('toolbar');
	});

	it('shows the toolbar with mark buttons when a non-collapsed selection exists in a text block', () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const tb = getToolbar()!;
		expect(tb.style.display).toBe('flex');
		// Built-in marks (bold/italic/underline/strikethrough/code/link)
		// all contribute toolbar items.
		expect(tb.querySelector('[data-toolbar-item="bold"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="italic"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="underline"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="strikethrough"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="code"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="link"]')).not.toBeNull();
	});

	it('hides the toolbar when the selection collapses', () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		let tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		expect(getToolbar()!.style.display).toBe('flex');
		tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 3 }, head: { path: [0], offset: 3 } });
		tx.commit();
		expect(getToolbar()!.style.display).toBe('none');
	});

	it('clicking the bold button applies the bold mark to the selected range', () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const btn = getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="bold"]')!;
		btn.click();
		const block = env.editor.getState().doc.children[0]!;
		expect(block.text![0]!.text).toBe('hello');
		expect(block.text![0]!.marks?.some((m) => m.type === 'bold')).toBe(true);
		// Trailing " world" is unchanged.
		expect(block.text![1]!.text).toBe(' world');
		expect(block.text![1]!.marks?.some((m) => m.type === 'bold') ?? false).toBe(false);
	});

	it("highlights the bold button as active when the selection's range is fully bold", () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		// Apply bold first.
		let tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.toggleMark('bold', { path: [0], from: 0, to: 5 });
		tx.commit();
		// Re-set selection so the toolbar re-renders against the updated doc.
		tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const btn = getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="bold"]')!;
		expect(btn.getAttribute('data-active')).toBe('true');
		expect(btn.getAttribute('aria-pressed')).toBe('true');
		// Italic is not active.
		const italic = getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="italic"]')!;
		expect(italic.getAttribute('data-active')).toBe(null);
		expect(italic.getAttribute('aria-pressed')).toBe('false');
	});

	it('shows block-transform items (heading, quote, paragraph) alongside mark items', () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const tb = getToolbar()!;
		expect(tb.querySelector('[data-toolbar-item="turn-into-paragraph"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="turn-into-heading-1"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="turn-into-heading-2"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="turn-into-heading-3"]')).not.toBeNull();
		expect(tb.querySelector('[data-toolbar-item="turn-into-quote"]')).not.toBeNull();
	});

	it('clicking "turn into heading 2" rewrites the head block to heading level 2', () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const btn = getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="turn-into-heading-2"]')!;
		btn.click();
		const block = env.editor.getState().doc.children[0]!;
		expect(block.type).toBe('heading');
		expect(block.attrs?.level).toBe(2);
	});

	it('marks the current heading-level button as active', () => {
		env = setup();
		const root = getRoot(env.container);
		focusEditor(root);
		// Make the first block a heading-1 with text.
		let tx = env.editor.createTransaction();
		tx.setBlockType([0], 'heading', { level: 1 });
		tx.insertText([0], 0, 'Title');
		tx.commit();
		tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const h1 = getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="turn-into-heading-1"]')!;
		const h2 = getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="turn-into-heading-2"]')!;
		expect(h1.getAttribute('data-active')).toBe('true');
		expect(h2.getAttribute('data-active')).toBe(null);
	});

	it('clicking the link button swaps the row for a URL input', () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const btn = getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="link"]')!;
		btn.click();
		const tb = getToolbar()!;
		const input = tb.querySelector<HTMLInputElement>('.plim-toolbar-link-input');
		expect(input).not.toBeNull();
		// Bold button is no longer rendered while in popover mode.
		expect(tb.querySelector('[data-toolbar-item="bold"]')).toBeNull();
	});

	it('submitting the link input applies a link mark with the entered href', () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		const btn = getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="link"]')!;
		btn.click();
		const input = getToolbar()!.querySelector<HTMLInputElement>('.plim-toolbar-link-input')!;
		input.value = 'https://example.com';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		const block = env.editor.getState().doc.children[0]!;
		const linkSpan = block.text!.find((s) => s.marks?.some((m) => m.type === 'link'));
		expect(linkSpan).toBeTruthy();
		expect(linkSpan!.text).toBe('hello');
		const linkMarkInst = linkSpan!.marks!.find((m) => m.type === 'link')!;
		expect(linkMarkInst.attrs?.href).toBe('https://example.com');
	});

	it('Escape inside the link input closes the popover and shows buttons again', () => {
		env = setup({ initial: ['hello world'] });
		const root = getRoot(env.container);
		focusEditor(root);
		const tx = env.editor.createTransaction();
		tx.setSelection({ anchor: { path: [0], offset: 0 }, head: { path: [0], offset: 5 } });
		tx.commit();
		getToolbar()!.querySelector<HTMLButtonElement>('[data-toolbar-item="link"]')!.click();
		const input = getToolbar()!.querySelector<HTMLInputElement>('.plim-toolbar-link-input')!;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		expect(getToolbar()!.querySelector('.plim-toolbar-link-input')).toBeNull();
		expect(getToolbar()!.querySelector('[data-toolbar-item="bold"]')).not.toBeNull();
	});

	it('destroys cleanly: removes the toolbar from the DOM', () => {
		env = setup({ initial: ['hello world'] });
		expect(getToolbar()).not.toBeNull();
		env.cleanup();
		env = null;
		expect(getToolbar()).toBeNull();
	});
});
