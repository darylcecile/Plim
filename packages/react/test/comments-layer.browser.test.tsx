import { describe, expect, it, afterEach } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlimDriver, boldMark, newId, paragraphBlock } from '@plim/core';
import { COMMENT_COMPOSE_EVENT, CommentStore, commentMark } from '@plim/collaboration';
import { CommentsLayer, PlimEditor, useEditorHandle, type EditorHandle } from '@plim/react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { container: HTMLElement; root: Root; getHandle: () => EditorHandle; store: CommentStore };
const mounted: Mounted[] = [];

afterEach(() => {
	while (mounted.length) {
		const m = mounted.pop()!;
		act(() => m.root.unmount());
		m.container.remove();
	}
});

const flush = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const me = { id: 'me', name: 'Me' };

function mount(text: string): Mounted {
	const plim = new PlimDriver({
		registeredMarks: [boldMark, commentMark],
		registeredBlocks: [paragraphBlock],
	});
	const initialContent = {
		type: 'doc' as const,
		children: [{ id: newId(), type: 'paragraph' as const, text: text ? [{ text }] : [] }],
	};
	const store = new CommentStore({ actor: 'me' });
	const container = document.createElement('div');
	document.body.appendChild(container);
	let handleRef: EditorHandle | null = null;
	const Wrapper = () => {
		const handle = useEditorHandle();
		handleRef = handle;
		return (
			<>
				<PlimEditor plim={plim} handle={handle} initialContent={initialContent} autoFocus={false} />
				<CommentsLayer editor={handle} store={store} currentUser={me} />
			</>
		);
	};
	const root = createRoot(container);
	act(() => root.render(<Wrapper />));
	const m: Mounted = { container, root, getHandle: () => handleRef!, store };
	mounted.push(m);
	return m;
}

function firstTextNode(el: Node): Text | null {
	if (el.nodeType === Node.TEXT_NODE) return el as Text;
	for (const child of Array.from(el.childNodes)) {
		const found = firstTextNode(child);
		if (found) return found;
	}
	return null;
}

function selectInEditor(container: HTMLElement, from: number, to: number) {
	const content = container.querySelector('[data-block-content]') ?? container.querySelector('.plim-block');
	const node = content ? firstTextNode(content) : null;
	if (!node) throw new Error('no text node to select');
	const range = document.createRange();
	range.setStart(node, from);
	range.setEnd(node, to);
	const sel = window.getSelection()!;
	sel.removeAllRanges();
	sel.addRange(range);
}

function dispatchCompose(from: number, to: number, threadIds: string[] = []) {
	document.dispatchEvent(
		new CustomEvent(COMMENT_COMPOSE_EVENT, {
			detail: {
				selection: { anchor: { path: [0], offset: from }, head: { path: [0], offset: to } },
				threadIds,
				anchor: document.body,
			},
		}),
	);
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
	setter.call(textarea, value);
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickButton(label: string, scope: ParentNode = document) {
	const btn = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
		(b) => b.textContent?.trim() === label,
	);
	if (!btn) throw new Error(`button "${label}" not found`);
	btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function frame() {
	await act(async () => {
		await flush(0);
	});
}

describe('CommentsLayer — compose, reply, resolve', () => {
	it('creates a thread + comment mark, then supports reply and resolve', async () => {
		const m = mount('Hello brave world');
		await frame();

		// 1. Select "brave" and open the composer via the compose event.
		selectInEditor(m.container, 6, 11);
		await act(async () => {
			dispatchCompose(6, 11);
			await flush(0);
		});
		const composer = document.querySelector<HTMLElement>('.plim-comments-popover');
		expect(composer).not.toBeNull();
		const ta = composer!.querySelector('textarea')!;
		expect(ta).not.toBeNull();

		// 2. Write the comment and submit.
		await act(async () => {
			typeInto(ta, 'Nice word');
			await flush(0);
		});
		await act(async () => {
			clickButton('Comment', composer!);
			await flush(0);
		});

		// Store has a thread with our comment, and the mark is in the doc.
		expect(m.store.threads()).toHaveLength(1);
		expect(m.store.threads()[0]!.comments.map((c) => c.body)).toEqual(['Nice word']);
		const span = m.container.querySelector<HTMLElement>('.plim-comment[data-comment-thread]');
		expect(span).not.toBeNull();
		expect(span!.textContent).toBe('brave');

		// 3. The thread popover auto-opens; reply through it.
		await frame();
		const popover = document.querySelector<HTMLElement>('.plim-comments-popover');
		expect(popover).not.toBeNull();
		const replyBox = Array.from(popover!.querySelectorAll('textarea')).at(-1) as HTMLTextAreaElement;
		await act(async () => {
			typeInto(replyBox, 'Agreed');
			await flush(0);
		});
		await act(async () => {
			clickButton('Reply', popover!);
			await flush(0);
		});
		expect(m.store.threads()[0]!.comments.map((c) => c.body)).toEqual(['Nice word', 'Agreed']);

		// 4. Resolve the thread → store flips and the highlight gets the attribute.
		await act(async () => {
			clickButton('Resolve', document);
			await flush(0);
		});
		expect(m.store.threads()[0]!.resolved).toBe(true);
		await frame();
		const resolvedSpan = m.container.querySelector<HTMLElement>('.plim-comment[data-comment-thread]');
		expect(resolvedSpan!.getAttribute('data-comment-resolved')).toBe('true');
	});

	it('clicking an existing highlight opens its thread', async () => {
		const m = mount('one two three');
		await frame();

		// Seed a thread + mark directly through the public API.
		let threadId = '';
		await act(async () => {
			threadId = m.store.createThread({ author: me, body: 'hi' }).threadId;
			const editor = m.getHandle().getEditor()!;
			const tx = editor.createTransaction();
			tx.addMark('comment', { path: [0], from: 0, to: 3 }, { threadId });
			tx.commit();
			await flush(0);
		});

		const span = m.container.querySelector<HTMLElement>('.plim-comment[data-comment-thread]')!;
		expect(span).not.toBeNull();
		await act(async () => {
			span.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await flush(0);
		});
		const popover = document.querySelector<HTMLElement>('.plim-comments-popover');
		expect(popover).not.toBeNull();
		expect(popover!.textContent).toContain('hi');
	});
});
