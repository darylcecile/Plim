import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
	PlimDriver,
	bulletedListBlock,
	headingBlock,
	paragraphBlock,
	quoteBlock,
	codeBlock as codeBlockFactory,
	todoListBlock,
	boldMark,
	italicMark,
	codeMark,
	newId,
} from '@plim/core';
import { attachContainer, deriveEditor, type AgnosticEditor } from '@plim/editor';

function setup(opts?: { initial?: string[] }): { editor: AgnosticEditor; container: HTMLElement; plim: PlimDriver; cleanup: () => void } {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const plim = new PlimDriver({
		registeredBlocks: [paragraphBlock, headingBlock, bulletedListBlock, quoteBlock, todoListBlock, codeBlockFactory],
		registeredMarks: [boldMark, italicMark, codeMark],
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
		expect(block.tagName).toBe('PRE');
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
});
