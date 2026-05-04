import { describe, expect, it, afterEach } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { defineBlock, newId, paragraphBlock, PlimDriver } from '@plim/core';
import { PlimEditor, useEditorHandle } from '@plim/react';

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

describe('Custom block via BlockDescriptor.toComponent', () => {
	// A descriptor whose `toComponent` returns a React element. The editor
	// view is framework-agnostic; <PlimEditor> bridges by calling
	// `createRoot(host).render(...)` inside a host element it places in the
	// block wrapper. This test asserts the React tree appears, that an
	// attribute change re-renders into the same host (no unmount), and
	// that removing the block from the doc unmounts the root and clears
	// the host so it doesn't leak.

	function CalloutComponent(props: { tone: string; text: string }) {
		const [count, setCount] = React.useState(0);
		return (
			<div className="my-react-callout" data-tone={props.tone}>
				<button type="button" data-testid="bump" onClick={() => setCount((c) => c + 1)}>
					bump
				</button>
				<span data-testid="count">{count}</span>
				<span data-testid="text">{props.text}</span>
			</div>
		);
	}

	const calloutBlock = defineBlock({
		name: 'react_callout',
		type: 'standalone',
		atomic: true,
		supportsDecoration: false,
		toComponent: (payload) => (
			<CalloutComponent
				tone={String(payload.attrs.tone ?? 'info')}
				text={payload.textContent}
			/>
		),
	});

	function makePlim(): PlimDriver {
		return new PlimDriver({
			registeredBlocks: [paragraphBlock, calloutBlock],
		});
	}

	it('mounts the React component into a host element inside the block wrapper', async () => {
		const plim = makePlim();
		const initialContent = {
			type: 'doc' as const,
			children: [
				{
					id: newId(),
					type: 'react_callout',
					attrs: { tone: 'warn' },
					text: [{ text: 'hello' }],
				},
			],
		};
		const { container } = mount(<PlimEditor plim={plim} initialContent={initialContent} />);
		await act(async () => {
			await flush();
		});
		const block = container.querySelector('[data-block-type="react_callout"]') as HTMLElement;
		expect(block).toBeTruthy();
		const host = block.querySelector('[data-plim-react-block-id]') as HTMLElement;
		expect(host).toBeTruthy();
		expect(host.getAttribute('contenteditable')).toBe('false');
		const callout = host.querySelector('.my-react-callout') as HTMLElement;
		expect(callout).toBeTruthy();
		expect(callout.getAttribute('data-tone')).toBe('warn');
		expect(callout.querySelector('[data-testid="text"]')!.textContent).toBe('hello');
	});

	it('re-renders the component on attr change and preserves component-local state', async () => {
		const plim = makePlim();
		const blockId = newId();
		const initialContent = {
			type: 'doc' as const,
			children: [
				{
					id: blockId,
					type: 'react_callout',
					attrs: { tone: 'info' },
					text: [{ text: 'one' }],
				},
			],
		};
		const handle = { current: null as ReturnType<typeof useEditorHandle> | null } as unknown as ReturnType<
			typeof useEditorHandle
		>;
		// Simpler: just hold the handle via a ref-like object we pass into the React tree.
		function App() {
			const h = useEditorHandle();
			(handle as unknown as { __target: typeof h }).__target = h;
			return <PlimEditor plim={plim} initialContent={initialContent} handle={h} />;
		}
		const { container } = mount(<App />);
		await act(async () => {
			await flush();
		});
		const editor = (handle as unknown as { __target: { current: ReturnType<typeof useEditorHandle>['current'] } })
			.__target.current!;
		const host = container.querySelector('[data-plim-react-block-id]') as HTMLElement;
		expect(host).toBeTruthy();

		// Click the bump button to advance component-local state.
		const button = host.querySelector('[data-testid="bump"]') as HTMLButtonElement;
		await act(async () => {
			button.click();
			await flush();
		});
		expect(host.querySelector('[data-testid="count"]')!.textContent).toBe('1');

		// Mutate the block's `tone` attr — the view re-renders the wrapper
		// via the same host, so the component receives new props but
		// component-local state survives.
		await act(async () => {
			const tx = editor.createTransaction();
			tx.setBlockAttrs([0], { tone: 'success' });
			tx.commit();
			await flush();
		});
		const callout = host.querySelector('.my-react-callout') as HTMLElement;
		expect(callout.getAttribute('data-tone')).toBe('success');
		expect(host.querySelector('[data-testid="count"]')!.textContent).toBe('1');
	});

	it('unmounts the React root when the custom block is removed from the doc', async () => {
		let renderCount = 0;
		let unmounted = false;
		function Probe() {
			React.useEffect(() => {
				renderCount += 1;
				return () => {
					unmounted = true;
				};
			}, []);
			return <span data-testid="probe">probe</span>;
		}
		const probeBlock = defineBlock({
			name: 'probe',
			type: 'standalone',
			atomic: true,
			supportsDecoration: false,
			toComponent: () => <Probe />,
		});
		const plim = new PlimDriver({
			registeredBlocks: [paragraphBlock, probeBlock],
		});
		const probeId = newId();
		const initialContent = {
			type: 'doc' as const,
			children: [
				{ id: probeId, type: 'probe' },
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
		expect(renderCount).toBe(1);
		expect(container.querySelector('[data-testid="probe"]')).toBeTruthy();

		// Delete the probe block.
		const editor = handle.__target.current!;
		await act(async () => {
			const tx = editor.createTransaction();
			tx.removeBlock([0]);
			tx.commit();
			await flush();
		});
		// Microtask reap is queued from the tx listener.
		await act(async () => {
			await flush();
		});
		expect(container.querySelector('[data-testid="probe"]')).toBeNull();
		expect(unmounted).toBe(true);
	});
});
