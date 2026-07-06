import { afterEach, describe, expect, it } from 'vitest';
import { PlimDriver, boldMark, codeMark, newId, paragraphBlock, type BlockNode, type TextSpan } from '@plim/core';
import { attachContainer, deriveEditor, type AgnosticEditor } from '@plim/editor';
import { MOJI_IMAGE_PLACEHOLDER, mojiExtension, mojiSpan, type MojiExtensionOptions } from '@plim/mojis';

// Real Chromium (Playwright) is required: this exercises contenteditable,
// Selection/Range, beforeinput, and ClipboardEvent end-to-end — the same
// approach as packages/editor/test/view.browser.test.ts.

function setup(initial?: BlockNode[], mojiOptions?: MojiExtensionOptions): {
	editor: AgnosticEditor;
	container: HTMLElement;
	root: HTMLElement;
	cleanup: () => void;
} {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const plim = new PlimDriver({
		registeredBlocks: [paragraphBlock],
		registeredMarks: [boldMark, codeMark], // mojiMark is auto-registered by the extension
		extensions: [mojiExtension(mojiOptions)],
	});
	const children: BlockNode[] = initial ?? [{ id: newId(), type: 'paragraph', text: [] }];
	const editor = deriveEditor(plim, {
		containerAdapter: attachContainer(() => container),
		initialContent: { type: 'doc', children },
		autoFocus: false,
	});
	editor.mount();
	const root = container.querySelector('.plim-editor') as HTMLElement;
	if (!root) throw new Error('editor root not mounted');
	return { editor, container, root, cleanup: () => { editor.destroy(); container.remove(); } };
}

const moji = (text: string, attrs: Record<string, unknown>): TextSpan => ({ text, marks: [{ type: 'moji', attrs }] });

function flat(editor: AgnosticEditor, blockIdx = 0): string {
	return (editor.getState().doc.children[blockIdx]!.text ?? []).map((s) => s.text).join('');
}
function marksOf(editor: AgnosticEditor, blockIdx = 0): TextSpan[] {
	return editor.getState().doc.children[blockIdx]!.text ?? [];
}
function hasMoji(editor: AgnosticEditor, slug: string, blockIdx = 0): boolean {
	return marksOf(editor, blockIdx).some((s) => s.marks?.some((m) => m.type === 'moji' && m.attrs?.slug === slug));
}
function caret(editor: AgnosticEditor): { path: readonly number[]; offset: number } {
	return editor.getState().selection.head;
}

function setCaret(editor: AgnosticEditor, path: number[], offset: number): void {
	const tx = editor.createTransaction();
	tx.setSelection({ anchor: { path, offset }, head: { path, offset } });
	tx.commit();
}
function select(editor: AgnosticEditor, path: number[], from: number, to: number): void {
	const tx = editor.createTransaction();
	tx.setSelection({ anchor: { path, offset: from }, head: { path, offset: to } });
	tx.commit();
}
function typeText(root: HTMLElement, text: string): void {
	for (const ch of Array.from(text)) {
		root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true }));
	}
}
function firePaste(root: HTMLElement, text: string): void {
	const dt = new DataTransfer();
	dt.setData('text/plain', text);
	root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}
function fireCopy(root: HTMLElement): { plain: string; defaultPrevented: boolean } {
	const dt = new DataTransfer();
	const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
	root.dispatchEvent(ev);
	return { plain: dt.getData('text/plain'), defaultPrevented: ev.defaultPrevented };
}
async function waitFor(pred: () => boolean, timeout = 1000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeout) throw new Error('waitFor: condition not met in time');
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe('@plim/mojis — live conversion', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => { env?.cleanup(); env = null; });

	it('converts a shortcode typed at the caret into a moji glyph', () => {
		env = setup();
		setCaret(env.editor, [0], 0);
		typeText(env.root, ':smile:');
		expect(flat(env.editor)).toBe('😄');
		expect(hasMoji(env.editor, 'smile')).toBe(true);
		// Caret ends just after the glyph (😄 is a 2-unit surrogate pair).
		expect(caret(env.editor).offset).toBe('😄'.length);
	});

	it('converts a shortcode typed after existing text', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }] }]);
		setCaret(env.editor, [0], 3);
		typeText(env.root, ':moon:');
		expect(flat(env.editor)).toBe('Hi 🌑');
		expect(hasMoji(env.editor, 'moon')).toBe(true);
	});

	it('leaves unknown shortcodes as literal text', () => {
		env = setup();
		setCaret(env.editor, [0], 0);
		typeText(env.root, ':nope:');
		expect(flat(env.editor)).toBe(':nope:');
		expect(env.editor.getState().doc.children[0]!.text!.some((s) => s.marks?.some((m) => m.type === 'moji'))).toBe(false);
	});

	it('does not convert inside an unclosed inline-code fence', () => {
		env = setup();
		setCaret(env.editor, [0], 0);
		typeText(env.root, '`:smile:');
		expect(flat(env.editor)).toBe('`:smile:');
		expect(hasMoji(env.editor, 'smile')).toBe(false);
	});

	it('converts every shortcode found in pasted text', () => {
		env = setup();
		setCaret(env.editor, [0], 0);
		firePaste(env.root, ':tada: and :rocket:');
		expect(flat(env.editor)).toBe('🎉 and 🚀');
		expect(hasMoji(env.editor, 'tada')).toBe(true);
		expect(hasMoji(env.editor, 'rocket')).toBe(true);
	});
});

describe('@plim/mojis — cursor behaviour (text-like)', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => { env?.cleanup(); env = null; });

	it('draws no focus ring / atom highlight when the caret is at a moji edge', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }, moji('🌑', { slug: 'moon' })] }]);
		// Trailing edge of the moon.
		setCaret(env.editor, [0], 5);
		expect(env.container.querySelector('[data-plim-atom-active="true"]')).toBeNull();
		expect(env.container.querySelector('.plim-moji')?.hasAttribute('data-atomic')).toBe(false);
		// Leading edge too.
		setCaret(env.editor, [0], 3);
		expect(env.container.querySelector('[data-plim-atom-active="true"]')).toBeNull();
	});

	it('lets the caret rest before and after a moji without snapping', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }, moji('🌑', { slug: 'moon' })] }]);
		setCaret(env.editor, [0], 3); // before the moon
		expect(caret(env.editor).offset).toBe(3);
		setCaret(env.editor, [0], 5); // after the moon
		expect(caret(env.editor).offset).toBe(5);
	});

	it('keeps the native glyph as real, selectable text', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }, moji('🌑', { slug: 'moon' })] }]);
		// A range spanning the moji is preserved verbatim (highlights like text).
		select(env.editor, [0], 0, 5);
		expect(caret(env.editor).offset).toBe(5);
		expect(env.editor.getState().selection.anchor.offset).toBe(0);
		// The glyph is a real text node inside the wrapper, so ::selection paints it.
		const el = env.container.querySelector('.plim-moji') as HTMLElement;
		expect(el.textContent).toBe('🌑');
	});

	it('deletes a whole native moji with one Backspace at its trailing edge', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }, moji('🌑', { slug: 'moon' })] }]);
		setCaret(env.editor, [0], 5);
		const ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
		env.root.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(flat(env.editor)).toBe('Hi '); // whole glyph gone — no orphaned surrogate
		expect(hasMoji(env.editor, 'moon')).toBe(false);
		expect(caret(env.editor).offset).toBe(3);
	});

	it('deletes a whole native moji with one forward Delete at its leading edge', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }, moji('🌑', { slug: 'moon' })] }]);
		setCaret(env.editor, [0], 3);
		const ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
		env.root.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(flat(env.editor)).toBe('Hi ');
		expect(hasMoji(env.editor, 'moon')).toBe(false);
		expect(caret(env.editor).offset).toBe(3);
	});

	it('deletes an image moji cleanly with one Backspace (single placeholder unit)', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }, mojiSpan({ slug: 'plim', src: 'p.svg' })] }]);
		expect(flat(env.editor)).toBe(`Hi ${MOJI_IMAGE_PLACEHOLDER}`);
		setCaret(env.editor, [0], 4);
		const ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
		env.root.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(flat(env.editor)).toBe('Hi ');
		expect(hasMoji(env.editor, 'plim')).toBe(false);
	});

	it('does not extend the moji mark onto text typed right after it', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }, moji('🌑', { slug: 'moon' })] }]);
		setCaret(env.editor, [0], 5);
		typeText(env.root, 'x');
		expect(flat(env.editor)).toBe('Hi 🌑x');
		const spans = marksOf(env.editor);
		const xSpan = spans.find((s) => s.text.includes('x'));
		expect(xSpan?.marks?.some((m) => m.type === 'moji')).not.toBe(true);
		// The moji itself is untouched.
		expect(hasMoji(env.editor, 'moon')).toBe(true);
	});
});

describe('@plim/mojis — rendering', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => { env?.cleanup(); env = null; });

	it('renders a native glyph moji as a non-atomic span showing the emoji', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [moji('🌑', { slug: 'moon' })] }]);
		const el = env.container.querySelector('.plim-moji') as HTMLElement;
		expect(el).toBeTruthy();
		// No longer atomic — mojis flow and select like text.
		expect(el.hasAttribute('data-atomic')).toBe(false);
		expect(el.getAttribute('data-moji-slug')).toBe('moon');
		expect(el.classList.contains('plim-moji--image')).toBe(false);
		expect(el.textContent).toBe('🌑');
	});

	it('renders an image moji as a foreground overlay over a highlightable placeholder', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [mojiSpan({ slug: 'plim', src: 'https://x/y.svg' })] }]);
		const el = env.container.querySelector('.plim-moji--image') as HTMLElement;
		expect(el).toBeTruthy();
		expect(el.hasAttribute('data-atomic')).toBe(false);
		expect(el.getAttribute('data-moji-slug')).toBe('plim');
		expect(el.getAttribute('role')).toBe('img');
		expect(el.getAttribute('aria-label')).toBe(':plim:');
		// The image URL is exposed as a custom property so the `::before`
		// foreground overlay (which paints above the selection highlight) can
		// reference it via var(--plim-moji-src).
		expect(el.style.getPropertyValue('--plim-moji-src')).toContain('y.svg');
		// The model text is a single placeholder code unit (image drawn by CSS).
		expect(el.textContent).toBe(MOJI_IMAGE_PLACEHOLDER);
		// The placeholder occupies a real, non-zero-width text cell so the
		// browser can paint a selection highlight behind it, just like ordinary
		// text. (A zero-width placeholder — e.g. U+FFFC — would show no
		// highlight; this guards that regression.)
		expect(el.getBoundingClientRect().width).toBeGreaterThan(0);
	});
});

describe('@plim/mojis — copy-as-slug', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => { env?.cleanup(); env = null; });

	it('copies a native-glyph moji as its :slug: shortcode', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hello ' }, moji('🌑', { slug: 'moon' })] }]);
		select(env.editor, [0], 0, 'Hello 🌑'.length);
		const r = fireCopy(env.root);
		expect(r.defaultPrevented).toBe(true);
		expect(r.plain).toBe('Hello :moon:');
	});

	it('copies an image moji as its :slug: shortcode', () => {
		env = setup([{ id: newId(), type: 'paragraph', text: [{ text: 'Hi ' }, mojiSpan({ slug: 'plim', src: 'p.svg' })] }]);
		select(env.editor, [0], 0, `Hi ${MOJI_IMAGE_PLACEHOLDER}`.length);
		const r = fireCopy(env.root);
		expect(r.plain).toBe('Hi :plim:');
	});
});

describe('@plim/mojis — async (dynamic) resolution', () => {
	let env: ReturnType<typeof setup> | null = null;
	afterEach(() => { env?.cleanup(); env = null; });

	it('resolves an unknown slug remotely and converts it once the fetch settles', async () => {
		let calls = 0;
		const resolveAsync = async (slug: string) => {
			calls++;
			await new Promise((r) => setTimeout(r, 5));
			return slug === 'partyparrot' ? { slug: 'partyparrot', src: 'party.svg', label: 'Party' } : null;
		};
		env = setup(undefined, { resolveAsync });
		setCaret(env.editor, [0], 0);
		typeText(env.root, ':partyparrot:');
		// The synchronous pass can't know a remote slug yet — left as literal text.
		expect(flat(env.editor)).toBe(':partyparrot:');
		expect(hasMoji(env.editor, 'partyparrot')).toBe(false);
		// After the fetch settles the block is re-scanned and the shortcode converts.
		await waitFor(() => hasMoji(env.editor, 'partyparrot'));
		expect(hasMoji(env.editor, 'partyparrot')).toBe(true);
		// Image moji → single-code-unit placeholder; caret lands just after it.
		expect(flat(env.editor)).toBe(MOJI_IMAGE_PLACEHOLDER);
		expect(caret(env.editor).offset).toBe(MOJI_IMAGE_PLACEHOLDER.length);
		expect(calls).toBe(1);
	});

	it('caches a resolved slug so a later occurrence converts without refetching', async () => {
		let calls = 0;
		const resolveAsync = async (slug: string) => {
			calls++;
			await new Promise((r) => setTimeout(r, 5));
			return slug === 'parrot' ? { slug: 'parrot', char: '🦜' } : null;
		};
		env = setup(undefined, { resolveAsync });
		setCaret(env.editor, [0], 0);
		typeText(env.root, ':parrot:');
		await waitFor(() => hasMoji(env.editor, 'parrot'));
		expect(calls).toBe(1);
		// Type a second occurrence — a cache hit converts it on the sync pass.
		setCaret(env.editor, [0], flat(env.editor).length);
		typeText(env.root, ' :parrot:');
		await waitFor(() => (flat(env.editor).match(/🦜/g) ?? []).length === 2);
		expect((flat(env.editor).match(/🦜/g) ?? []).length).toBe(2);
		expect(calls).toBe(1); // never refetched
	});

	it('negative-caches an unknown slug: it stays text and is fetched only once', async () => {
		let calls = 0;
		const resolveAsync = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 5));
			return null; // registry doesn't know it
		};
		env = setup(undefined, { resolveAsync });
		setCaret(env.editor, [0], 0);
		typeText(env.root, ':nope:');
		await waitFor(() => calls === 1);
		// Give any (incorrect) re-scan a chance to fire, then assert it stayed text.
		await new Promise((r) => setTimeout(r, 30));
		expect(flat(env.editor)).toBe(':nope:');
		expect(hasMoji(env.editor, 'nope')).toBe(false);
		expect(calls).toBe(1); // negative cache prevents refetch
		// Typing more in the same block must not refetch the known-unknown slug.
		setCaret(env.editor, [0], flat(env.editor).length);
		typeText(env.root, ' x');
		await new Promise((r) => setTimeout(r, 30));
		expect(calls).toBe(1);
	});

	it('still converts native-glyph defaults synchronously when async is configured', async () => {
		const resolveAsync = async () => null;
		env = setup(undefined, { resolveAsync });
		setCaret(env.editor, [0], 0);
		typeText(env.root, ':moon:');
		// A built-in default resolves without touching the async path.
		expect(flat(env.editor)).toBe('🌑');
		expect(hasMoji(env.editor, 'moon')).toBe(true);
	});
});
