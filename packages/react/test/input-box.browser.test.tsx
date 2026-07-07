import { describe, expect, it, afterEach } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
	blockPlainText,
	blockTextLength,
	boldMark,
	newId,
	paragraphBlock,
	PlimDriver,
	type EditorState,
} from '@plim/core';
import { PlimInputBox, useEditorHandle } from '@plim/react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handle = ReturnType<typeof useEditorHandle>;
type Mounted = { container: HTMLElement; root: Root; getHandle: () => Handle };
const mounted: Mounted[] = [];

async function flush() {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

function makePlim(): PlimDriver {
	return new PlimDriver({
		registeredMarks: [boldMark],
		registeredBlocks: [paragraphBlock],
	});
}

type MountOpts = {
	onSubmit?: (state: EditorState) => void;
	submitOnEnter?: boolean;
	clearOnSubmit?: boolean;
	placeholder?: string;
};

function mount(opts: MountOpts = {}): Mounted {
	const container = document.createElement('div');
	document.body.appendChild(container);
	let handleRef: Handle | null = null;
	const plim = makePlim();
	function Wrapper() {
		const handle = useEditorHandle();
		handleRef = handle;
		return (
			<PlimInputBox
				plim={plim}
				handle={handle}
				className="plim-input-box"
				placeholder={opts.placeholder ?? 'Message #general'}
				{...(opts.onSubmit ? { onSubmit: opts.onSubmit } : {})}
				{...(opts.submitOnEnter !== undefined ? { submitOnEnter: opts.submitOnEnter } : {})}
				{...(opts.clearOnSubmit !== undefined ? { clearOnSubmit: opts.clearOnSubmit } : {})}
			/>
		);
	}
	const root = createRoot(container);
	act(() => {
		root.render(<Wrapper />);
	});
	const m: Mounted = { container, root, getHandle: () => handleRef! };
	mounted.push(m);
	return m;
}

afterEach(() => {
	while (mounted.length) {
		const m = mounted.pop()!;
		act(() => {
			m.root.unmount();
		});
		m.container.remove();
	}
});

function editorOf(m: Mounted) {
	const editor = m.getHandle().getEditor();
	if (!editor) throw new Error('editor not mounted yet');
	return editor;
}

/** Replace the whole (single) block's text and drop the caret at the end. */
function setText(m: Mounted, text: string) {
	const editor = editorOf(m);
	const state = editor.getState();
	const block = state.doc.children[0]!;
	const len = blockTextLength(block);
	const tx = editor.createTransaction();
	tx.replaceRange([0], 0, len, text ? [{ text }] : []);
	tx.setSelection({ anchor: { path: [0], offset: text.length }, head: { path: [0], offset: text.length } });
	tx.commit();
}

function root(m: Mounted): HTMLElement {
	const el = m.container.querySelector('.plim-editor') as HTMLElement | null;
	if (!el) throw new Error('editor root missing');
	return el;
}

/** Synthesize the browser's Enter (`insertParagraph`) / Shift+Enter
 *  (`insertLineBreak`) beforeinput events the view listens for. */
function beforeInput(m: Mounted, inputType: string) {
	root(m).dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
}

describe('PlimInputBox (single-block composer)', () => {
	it('renders a single-block editor with no +/drag handles and a placeholder', async () => {
		const m = mount({ placeholder: 'Say something…' });
		await act(async () => {
			await flush();
		});
		const el = root(m);
		expect(el.classList.contains('plim-editor--single')).toBe(true);
		expect(el.getAttribute('aria-multiline')).toBe('false');
		// No block affordances.
		expect(m.container.querySelector('.plim-block-add')).toBeNull();
		expect(m.container.querySelector('.plim-block-drag')).toBeNull();
		expect(m.container.querySelector('.plim-block-handles')).toBeNull();
		// Placeholder surfaced on the (empty) block's content element.
		const content = m.container.querySelector('[data-block-content="true"]') as HTMLElement;
		expect(content.getAttribute('data-placeholder')).toBe('Say something…');
	});

	it('Enter submits non-empty content, then clears the input', async () => {
		const submits: string[] = [];
		const m = mount({ onSubmit: (s) => submits.push(blockPlainText(s.doc.children[0]!)) });
		await act(async () => {
			await flush();
		});
		await act(async () => {
			setText(m, 'hello world');
			await flush();
		});
		await act(async () => {
			beforeInput(m, 'insertParagraph');
			await flush();
		});
		// Submitted exactly once with the typed text…
		expect(submits).toEqual(['hello world']);
		// …and the input reset to a single empty block (still single-block).
		const state = editorOf(m).getState();
		expect(state.doc.children.length).toBe(1);
		expect(blockTextLength(state.doc.children[0]!)).toBe(0);
	});

	it('Enter never splits into a second block (stays single-block)', async () => {
		const m = mount({ clearOnSubmit: false });
		await act(async () => {
			await flush();
		});
		await act(async () => {
			setText(m, 'one');
			await flush();
		});
		await act(async () => {
			beforeInput(m, 'insertParagraph');
			await flush();
		});
		// With clearOnSubmit disabled the content stays, but it must remain a
		// single block — Enter is a submit gesture, never a paragraph split.
		expect(editorOf(m).getState().doc.children.length).toBe(1);
	});

	it('Shift+Enter inserts a soft newline and does NOT submit', async () => {
		const submits: string[] = [];
		const m = mount({ onSubmit: (s) => submits.push(blockPlainText(s.doc.children[0]!)) });
		await act(async () => {
			await flush();
		});
		await act(async () => {
			setText(m, 'line');
			await flush();
		});
		await act(async () => {
			beforeInput(m, 'insertLineBreak');
			await flush();
		});
		expect(submits).toEqual([]);
		const state = editorOf(m).getState();
		expect(state.doc.children.length).toBe(1);
		expect(blockPlainText(state.doc.children[0]!)).toContain('\n');
	});

	it('empty Enter neither submits nor leaves a stray newline', async () => {
		const submits: string[] = [];
		const m = mount({ onSubmit: (s) => submits.push(blockPlainText(s.doc.children[0]!)) });
		await act(async () => {
			await flush();
		});
		await act(async () => {
			beforeInput(m, 'insertParagraph');
			await flush();
		});
		expect(submits).toEqual([]);
		const state = editorOf(m).getState();
		expect(state.doc.children.length).toBe(1);
		expect(blockTextLength(state.doc.children[0]!)).toBe(0);
	});

	it('submitOnEnter=false makes Enter a soft newline instead of a submit', async () => {
		const submits: string[] = [];
		const m = mount({ submitOnEnter: false, onSubmit: (s) => submits.push(blockPlainText(s.doc.children[0]!)) });
		await act(async () => {
			await flush();
		});
		await act(async () => {
			setText(m, 'draft');
			await flush();
		});
		await act(async () => {
			beforeInput(m, 'insertParagraph');
			await flush();
		});
		expect(submits).toEqual([]);
		const state = editorOf(m).getState();
		expect(state.doc.children.length).toBe(1);
		expect(blockPlainText(state.doc.children[0]!)).toContain('\n');
	});

	it('Cmd/Ctrl+Enter always submits, even with submitOnEnter=false', async () => {
		const submits: string[] = [];
		const m = mount({ submitOnEnter: false, onSubmit: (s) => submits.push(blockPlainText(s.doc.children[0]!)) });
		await act(async () => {
			await flush();
		});
		await act(async () => {
			setText(m, 'ship it');
			await flush();
		});
		await act(async () => {
			root(m).dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
			);
			await flush();
		});
		expect(submits).toEqual(['ship it']);
	});
});
