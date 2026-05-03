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

	it('reorders blocks via drag-and-drop on the gutter handle', () => {
		env = setup({ initial: ['first', 'second', 'third'] });
		const blocks = getBlocks(env.container);
		expect(blocks.map((b) => getContent(b).textContent)).toEqual(['first', 'second', 'third']);
		const sourceHandle = blocks[0]!.querySelector('.plim-block-drag') as HTMLElement;
		const targetBlock = blocks[2]!;

		// dragstart on the handle: writes id into the DataTransfer AND dispatches
		// the internal plim:dragstart custom event so the view's flag-based path
		// activates (covers Chrome same-document drags where types is empty).
		const dt = new DataTransfer();
		sourceHandle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

		// dragover on the target with a *fresh* (empty) DataTransfer. This mimics
		// the case where the browser doesn't expose our custom type to dragover.
		const tRect = targetBlock.getBoundingClientRect();
		const emptyDT = new DataTransfer();
		const dover = new DragEvent('dragover', {
			bubbles: true,
			cancelable: true,
			dataTransfer: emptyDT,
			clientX: tRect.left + 10,
			clientY: tRect.bottom - 4,
		});
		targetBlock.dispatchEvent(dover);
		// `preventDefault` having been called by the editor enables the drop.
		expect(dover.defaultPrevented).toBe(true);

		const ddrop = new DragEvent('drop', {
			bubbles: true,
			cancelable: true,
			dataTransfer: emptyDT,
			clientX: tRect.left + 10,
			clientY: tRect.bottom - 4,
		});
		targetBlock.dispatchEvent(ddrop);
		sourceHandle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));

		const after = getBlocks(env.container);
		expect(after.map((b) => getContent(b).textContent)).toEqual(['second', 'third', 'first']);
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
});
