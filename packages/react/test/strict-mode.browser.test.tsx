import { describe, expect, it, afterEach } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { paragraphBlock, PlimDriver } from '@plim/core';
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

describe('PlimEditor under React.StrictMode', () => {
	it('survives the dev-mode mount → unmount → remount cycle without errors', async () => {
		const plim = new PlimDriver({ blocks: [paragraphBlock] });
		const handle = { current: null } as unknown as ReturnType<typeof useEditorHandle>;
		// Use a component so useEditorHandle is exercised.
		function Harness() {
			const h = useEditorHandle();
			// Stash the handle so the test can read it after the StrictMode dance.
			(handle as unknown as { __set: (h: unknown) => void }).__set ??= () => {};
			(Harness as unknown as { lastHandle: typeof h }).lastHandle = h;
			return <PlimEditor plim={plim} handle={h} autoFocus={false} />;
		}

		const errors: unknown[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
			origError.apply(console, args as []);
		};

		try {
			const m = mount(
				<React.StrictMode>
					<Harness />
				</React.StrictMode>
			);
			await act(async () => {
				await flush();
			});

			// After StrictMode's double-invocation settles, the editor should be mounted exactly once,
			// the view should be live, and no React/Plim errors should have been logged.
			const h = (Harness as unknown as { lastHandle: ReturnType<typeof useEditorHandle> }).lastHandle;
			expect(h.current, 'editor handle is populated').toBeTruthy();
			expect(h.current!.view, 'view is mounted').toBeTruthy();
			expect(h.current!.isReady, 'editor is ready').toBe(true);

			// Container should host exactly one editor root.
			const editors = m.container.querySelectorAll('.plim-editor');
			expect(editors.length).toBe(1);

			// No errors logged during the StrictMode dance.
			const ignorable = errors.filter((e) => {
				const s = Array.isArray(e) ? String(e[0] ?? '') : String(e);
				// Tolerate React's act() warnings; they're orthogonal to the StrictMode guard.
				return !/not wrapped in act/.test(s);
			});
			expect(ignorable, `unexpected console.error: ${JSON.stringify(ignorable)}`).toEqual([]);

			// Now do an explicit unmount+remount round-trip via the same root to confirm
			// teardown is clean and a fresh editor can be created.
			act(() => {
				m.root.render(
					<React.StrictMode>
						<div data-empty />
					</React.StrictMode>
				);
			});
			await act(async () => {
				await flush();
			});
			expect(m.container.querySelectorAll('.plim-editor').length).toBe(0);

			act(() => {
				m.root.render(
					<React.StrictMode>
						<Harness />
					</React.StrictMode>
				);
			});
			await act(async () => {
				await flush();
			});
			expect(m.container.querySelectorAll('.plim-editor').length).toBe(1);
			const h2 = (Harness as unknown as { lastHandle: ReturnType<typeof useEditorHandle> }).lastHandle;
			expect(h2.current!.view).toBeTruthy();
		} finally {
			console.error = origError;
		}
	});
});
