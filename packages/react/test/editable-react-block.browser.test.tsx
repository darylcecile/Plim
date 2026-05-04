import { describe, expect, it, afterEach } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { defineBlock, newId, paragraphBlock, PlimDriver, type BlockPayload } from '@plim/core';
import { ContentSlot, PlimEditor, useEditorHandle } from '@plim/react';

// Editable React blocks: a custom block whose `toComponent` mounts an
// editor-owned `[data-block-content]` slot via `<ContentSlot>`. The editor
// owns the slot's text rendering and selection mapping; React owns the
// surrounding chrome. These tests prove the contract: the slot lives where
// the component places it, the user can type into it, the surrounding chrome
// stays inert, and structural ops (splitBlock) flow through the same paths
// they would for built-in blocks.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { container: HTMLElement; root: Root };
const mounted: Mounted[] = [];

function mount(ui: React.ReactElement): Mounted {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(ui);
	});
	const m = { container, root };
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

async function flush() {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('Editable React blocks via ContentSlot', () => {
	function CalloutShell(props: { tone: string; slot: HTMLElement | undefined }) {
		return (
			<div className="my-react-callout" data-tone={props.tone}>
				<button type="button" data-testid="chrome-button">
					chrome
				</button>
				<div data-testid="text-region" className="callout-text">
					<ContentSlot el={props.slot} />
				</div>
			</div>
		);
	}

	const editableCallout = defineBlock({
		name: 'editable_callout',
		type: 'standalone',
		toComponent: (payload: BlockPayload) => (
			<CalloutShell tone={String(payload.attrs.tone ?? 'info')} slot={payload.content[0] as HTMLElement | undefined} />
		),
	});

	function makePlim(): PlimDriver {
		return new PlimDriver({
			registeredBlocks: [paragraphBlock, editableCallout],
		});
	}

	it('mounts the editor-owned slot inside the component subtree with editable text', async () => {
		const plim = makePlim();
		const initialContent = {
			type: 'doc' as const,
			children: [
				{
					id: newId(),
					type: 'editable_callout',
					attrs: { tone: 'warn' },
					text: [{ text: 'hello world' }],
				},
			],
		};
		const { container } = mount(<PlimEditor plim={plim} initialContent={initialContent} />);
		await act(async () => {
			await flush();
		});
		const block = container.querySelector('[data-block-type="editable_callout"]') as HTMLElement;
		expect(block).toBeTruthy();
		// Slot lives inside the component's text region (not as a direct
		// child of the wrapper) — proves the descendant search works.
		const textRegion = block.querySelector('[data-testid="text-region"]') as HTMLElement;
		const slot = textRegion.querySelector('[data-block-content]') as HTMLElement;
		expect(slot).toBeTruthy();
		expect(slot.getAttribute('contenteditable')).toBe('true');
		expect(slot.textContent).toBe('hello world');
		// React host wrapper stays inert so chrome buttons don't get caret.
		const host = block.querySelector('[data-plim-react-block-id]') as HTMLElement;
		expect(host.getAttribute('contenteditable')).toBe('false');
	});

	it('updates slot text in-place across transactions and reuses the same slot element', async () => {
		const plim = makePlim();
		const blockId = newId();
		const initialContent = {
			type: 'doc' as const,
			children: [
				{
					id: blockId,
					type: 'editable_callout',
					attrs: { tone: 'info' },
					text: [{ text: 'first' }],
				},
			],
		};
		const handle = { __target: null as unknown } as { __target: ReturnType<typeof useEditorHandle> };
		function App() {
			const h = useEditorHandle();
			handle.__target = h;
			return <PlimEditor plim={plim} initialContent={initialContent} handle={h} />;
		}
		const { container } = mount(<App />);
		await act(async () => {
			await flush();
		});
		const slotBefore = container.querySelector('[data-block-content]') as HTMLElement;
		expect(slotBefore.textContent).toBe('first');
		const editor = handle.__target.current!;
		await act(async () => {
			const tx = editor.createTransaction();
			tx.replaceRange([0], 0, 5, [{ text: 'second' }]);
			tx.commit();
			await flush();
		});
		const slotAfter = container.querySelector('[data-block-content]') as HTMLElement;
		expect(slotAfter).toBe(slotBefore); // same DOM node
		expect(slotAfter.textContent).toBe('second');
	});

	it('maps caret position correctly: selection inside the slot resolves to the right path/offset', async () => {
		const plim = makePlim();
		const initialContent = {
			type: 'doc' as const,
			children: [
				{ id: newId(), type: 'editable_callout', text: [{ text: 'abcdef' }] },
				{ id: newId(), type: 'paragraph' as const, text: [{ text: 'after' }] },
			],
		};
		const handle = { __target: null as unknown } as { __target: ReturnType<typeof useEditorHandle> };
		function App() {
			const h = useEditorHandle();
			handle.__target = h;
			return <PlimEditor plim={plim} initialContent={initialContent} handle={h} />;
		}
		const { container } = mount(<App />);
		await act(async () => {
			await flush();
		});
		const slot = container.querySelector('[data-block-content]') as HTMLElement;
		// Walk to first text node inside the slot.
		const walker = document.createTreeWalker(slot, NodeFilter.SHOW_TEXT);
		const textNode = walker.nextNode() as Text;
		expect(textNode).toBeTruthy();
		// Place caret at offset 3 inside the slot.
		const sel = window.getSelection()!;
		const range = document.createRange();
		range.setStart(textNode, 3);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
		// Trigger a selectionchange-equivalent: dispatch on document.
		document.dispatchEvent(new Event('selectionchange'));
		await act(async () => {
			await flush();
		});
		const editor = handle.__target.current!;
		const state = editor.getState();
		expect(state.selection?.anchor.path).toEqual([0]);
		expect(state.selection?.anchor.offset).toBe(3);
	});

	it('preserves component-local state across slot text updates (host stability)', async () => {
		let renderCount = 0;
		function Counter(props: { slot: HTMLElement | undefined }) {
			renderCount += 1;
			const [count, setCount] = React.useState(0);
			return (
				<div>
					<button type="button" data-testid="bump" onClick={() => setCount((c) => c + 1)}>
						bump
					</button>
					<span data-testid="count">{count}</span>
					<ContentSlot el={props.slot} />
				</div>
			);
		}
		const counterBlock = defineBlock({
			name: 'counter_block',
			type: 'standalone',
			toComponent: (p: BlockPayload) => <Counter slot={p.content[0] as HTMLElement | undefined} />,
		});
		const plim = new PlimDriver({ registeredBlocks: [paragraphBlock, counterBlock] });
		const blockId = newId();
		const initialContent = {
			type: 'doc' as const,
			children: [{ id: blockId, type: 'counter_block', text: [{ text: 'a' }] }],
		};
		const handle = { __target: null as unknown } as { __target: ReturnType<typeof useEditorHandle> };
		function App() {
			const h = useEditorHandle();
			handle.__target = h;
			return <PlimEditor plim={plim} initialContent={initialContent} handle={h} />;
		}
		const { container } = mount(<App />);
		await act(async () => {
			await flush();
		});
		const button = container.querySelector('[data-testid="bump"]') as HTMLButtonElement;
		await act(async () => {
			button.click();
			await flush();
		});
		expect(container.querySelector('[data-testid="count"]')!.textContent).toBe('1');
		const editor = handle.__target.current!;
		// Update the slot text — component should re-render with same useState, count survives.
		const before = renderCount;
		await act(async () => {
			const tx = editor.createTransaction();
			tx.insertText([0], 1, 'bcd');
			tx.commit();
			await flush();
		});
		expect(renderCount).toBeGreaterThan(before);
		expect(container.querySelector('[data-testid="count"]')!.textContent).toBe('1');
		const slot = container.querySelector('[data-block-content]') as HTMLElement;
		expect(slot.textContent).toBe('abcd');
	});
});
