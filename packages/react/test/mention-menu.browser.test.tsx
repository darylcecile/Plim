import { describe, expect, it, afterEach } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
	PlimDriver,
	bulletedListBlock,
	headingBlock,
	linkMark,
	newId,
	numberedListBlock,
	paragraphBlock,
} from '@plim/core';
import {
	MentionMenu,
	PlimEditor,
	mentionExtension,
	useEditorHandle,
	type EditorHandle,
	type MentionUser,
} from '@plim/react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { container: HTMLElement; root: Root; getHandle: () => EditorHandle };
const mounted: Mounted[] = [];

afterEach(() => {
	while (mounted.length) {
		const m = mounted.pop()!;
		act(() => {
			m.root.unmount();
		});
		m.container.remove();
	}
});

const flush = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function mount(opts: {
	searchUsers?: (q: string, signal: AbortSignal) => Promise<MentionUser[]>;
	users?: MentionUser[];
	debounceMs?: number;
	initialContent?: ReturnType<typeof makeDoc>;
}): Mounted {
	const plim = new PlimDriver({
		extensions: [mentionExtension()],
		registeredMarks: [linkMark],
		registeredBlocks: [paragraphBlock, headingBlock, bulletedListBlock, numberedListBlock],
	});
	const initialContent = opts.initialContent ?? {
		type: 'doc' as const,
		children: [{ id: newId(), type: 'paragraph' as const, text: [] }],
	};
	const container = document.createElement('div');
	document.body.appendChild(container);
	let handleRef: EditorHandle | null = null;
	const Wrapper = () => {
		const handle = useEditorHandle();
		handleRef = handle;
		return (
			<>
				<PlimEditor plim={plim} handle={handle} initialContent={initialContent} autoFocus={false} />
				<MentionMenu
					editor={handle}
					{...(opts.searchUsers ? { searchUsers: opts.searchUsers } : {})}
					{...(opts.users ? { users: opts.users } : {})}
					debounceMs={opts.debounceMs ?? 0}
				/>
			</>
		);
	};
	const root = createRoot(container);
	act(() => {
		root.render(<Wrapper />);
	});
	const m: Mounted = { container, root, getHandle: () => handleRef! };
	mounted.push(m);
	return m;
}

/** Open the mention menu via the agnostic-editor API instead of synthesising
 *  a `@` keydown — the keyboard pipeline is exercised in the editor's own
 *  view tests; here we want to focus the menu's behaviour. */
async function openMenu(m: Mounted): Promise<void> {
	// Wait one frame for PlimEditor's useEffect to mount the editor.
	await act(async () => {
		await flush(0);
	});
	const editor = m.getHandle().getEditor();
	if (!editor) throw new Error('editor not mounted yet');
	await act(async () => {
		// Don't await the trigger — it resolves only when the user picks.
		void editor.triggerAsyncEvent('showMentionSuggestions');
		await flush(0);
	});
}

function dispatchKey(key: string) {
	// Dispatch on document.body so the event path is [window, document, body]
	// — both window-capture and bubbling listeners get hit.
	document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const items = () =>
	Array.from(document.querySelectorAll<HTMLElement>('.mention-menu-item')).map((b) => b.textContent ?? '');

/** Build a paragraph containing `prefix` + a mention pill for `name` (id) +
 *  `suffix`. Returns the doc + the offset that lands the caret immediately
 *  after the mention's last character (i.e. the start of `suffix`). */
function makeDoc(prefix: string, mentionText: string, mentionId: string, suffix: string) {
	const text = [
		...(prefix ? [{ text: prefix }] : []),
		{ text: mentionText, marks: [{ type: 'mention', attrs: { id: mentionId } }] },
		...(suffix ? [{ text: suffix }] : []),
	];
	return {
		type: 'doc' as const,
		children: [{ id: newId(), type: 'paragraph' as const, text }],
	};
}

function setCaretAt(m: Mounted, path: number[], offset: number) {
	const editor = m.getHandle().getEditor();
	if (!editor) throw new Error('editor not mounted');
	const tx = editor.createTransaction();
	tx.setSelection({ anchor: { path, offset }, head: { path, offset } });
	tx.commit();
}

function dispatchKeyOnEditor(container: HTMLElement, key: string) {
	const root = container.querySelector('.plim-editor') as HTMLElement | null;
	if (!root) throw new Error('editor root missing');
	root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('MentionMenu (async source)', () => {
	it('shows a Searching… spinner until the async source resolves, then renders results', async () => {
		let release: ((users: MentionUser[]) => void) | null = null;
		const search = () =>
			new Promise<MentionUser[]>((resolve) => {
				release = resolve;
			});
		const m = mount({ searchUsers: search });
		await openMenu(m);

		expect(document.querySelector('.mention-menu')).not.toBeNull();
		expect(document.querySelector('.mention-menu-loading')?.textContent).toBe('Searching…');
		expect(items()).toEqual([]);

		await act(async () => {
			release!([
				{ id: 'u1', name: 'Alice', handle: 'alice' },
				{ id: 'u2', name: 'Bob', handle: 'bob' },
			]);
			await flush(0);
		});
		expect(document.querySelector('.mention-menu-loading')).toBeNull();
		expect(items()).toHaveLength(2);
		expect(items()[0]).toContain('Alice');
	});

	it('aborts an in-flight request when the user dismisses the menu', async () => {
		let aborted = false;
		const search = (_q: string, signal: AbortSignal) =>
			new Promise<MentionUser[]>(() => {
				signal.addEventListener('abort', () => {
					aborted = true;
				});
				// never resolves — simulate a slow request
			});
		const m = mount({ searchUsers: search });
		await openMenu(m);
		expect(document.querySelector('.mention-menu-loading')).not.toBeNull();
		expect(aborted).toBe(false);

		await act(async () => {
			dispatchKey('Escape');
			await flush(0);
		});
		expect(document.querySelector('.mention-menu')).toBeNull();
		expect(aborted).toBe(true);
	});

	it('still works with a synchronous `users` prop (no debounce, no spinner)', async () => {
		const m = mount({
			users: [
				{ id: 'u1', name: 'Alice', handle: 'alice' },
				{ id: 'u2', name: 'Bob', handle: 'bob' },
			],
		});
		await openMenu(m);
		// Sync source resolves in the same microtask — wait one tick.
		await act(async () => {
			await flush(0);
		});
		expect(document.querySelector('.mention-menu-loading')).toBeNull();
		expect(items()).toHaveLength(2);
	});
});

describe('MentionMenu — atomic Backspace', () => {
	function getEditorText(): string {
		const block = document.querySelector('[data-block-id] [data-block-content]');
		return block?.textContent ?? '';
	}

	async function flushFrame() {
		await act(async () => {
			await flush(0);
		});
	}

	it('renders a `.plim-mention` pill from the mention mark', async () => {
		const m = mount({ initialContent: makeDoc('Hi ', '@Alice', 'u1', ' there') });
		await flushFrame();
		const pill = document.querySelector('.plim-mention');
		expect(pill).not.toBeNull();
		expect(pill?.textContent).toBe('@Alice');
		expect(pill?.getAttribute('data-mention-id')).toBe('u1');
	});

	it('deletes the entire pill in a single Backspace when the caret is at its trailing edge', async () => {
		const m = mount({ initialContent: makeDoc('Hi ', '@Alice', 'u1', '') });
		await flushFrame();
		// Caret right after "@Alice" → offset = "Hi ".length + "@Alice".length.
		setCaretAt(m, [0], 'Hi '.length + '@Alice'.length);
		await flushFrame();
		await act(async () => {
			dispatchKeyOnEditor(m.container, 'Backspace');
			await flush(0);
		});
		expect(document.querySelector('.plim-mention')).toBeNull();
		expect(getEditorText()).toBe('Hi ');
	});

	it('does not invoke the atomic-delete path when the caret is not after a mention', async () => {
		const m = mount({ initialContent: makeDoc('Hello ', '@Alice', 'u1', ' world') });
		await flushFrame();
		// Caret at the end of " world" — preceded by a regular character.
		const total = 'Hello @Alice world'.length;
		setCaretAt(m, [0], total);
		await flushFrame();
		await act(async () => {
			dispatchKeyOnEditor(m.container, 'Backspace');
			await flush(0);
		});
		// The atomic-delete action must not have fired — the pill is intact
		// and the surrounding text wasn't pulled into a wholesale deletion.
		// (The actual single-character deletion is driven by `beforeinput`
		// in real browsers; this synthetic keydown only exercises the
		// keyboard-action pipeline so we assert the pill survived rather
		// than that the trailing 'd' was removed.)
		expect(document.querySelector('.plim-mention')).not.toBeNull();
		expect(getEditorText()).toBe('Hello @Alice world');
	});

	it('deletes adjacent pills independently (one Backspace per pill)', async () => {
		// "Hi @Alice@Bob" — two pills back-to-back, no separating text.
		const initialContent = {
			type: 'doc' as const,
			children: [
				{
					id: newId(),
					type: 'paragraph' as const,
					text: [
						{ text: 'Hi ' },
						{ text: '@Alice', marks: [{ type: 'mention', attrs: { id: 'u1' } }] },
						{ text: '@Bob', marks: [{ type: 'mention', attrs: { id: 'u2' } }] },
					],
				},
			],
		};
		const m = mount({ initialContent });
		await flushFrame();
		expect(document.querySelectorAll('.plim-mention')).toHaveLength(2);
		// Caret at end → after @Bob.
		const total = 'Hi @Alice@Bob'.length;
		setCaretAt(m, [0], total);
		await flushFrame();
		await act(async () => {
			dispatchKeyOnEditor(m.container, 'Backspace');
			await flush(0);
		});
		// Bob is gone; Alice remains.
		const remaining = Array.from(document.querySelectorAll<HTMLElement>('.plim-mention'));
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.getAttribute('data-mention-id')).toBe('u1');
		expect(getEditorText()).toBe('Hi @Alice');
	});
});
