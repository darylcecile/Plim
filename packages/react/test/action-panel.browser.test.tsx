import { describe, expect, it, afterEach } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActionPanel, HoverMenu } from '@plim/react';

// Tell React this is an act-aware environment so we don't get warnings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { container: HTMLElement; root: Root };
const mounted: Mounted[] = [];

function render(ui: React.ReactElement): Mounted {
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

function update(m: Mounted, ui: React.ReactElement) {
	act(() => {
		m.root.render(ui);
	});
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

function getPanel(): HTMLElement {
	const els = document.body.querySelectorAll<HTMLElement>('[data-test-panel]');
	const last = els[els.length - 1];
	if (!last) throw new Error('panel not rendered');
	return last;
}

function makeAnchor(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
	const a = document.createElement('div');
	Object.assign(a.style, {
		position: 'fixed',
		left: rect.left + 'px',
		top: rect.top + 'px',
		width: rect.width + 'px',
		height: rect.height + 'px',
		background: 'red',
	});
	document.body.appendChild(a);
	return a;
}

describe('<ActionPanel /> (real browser)', () => {
	it('does not render when open=false', () => {
		const anchor = makeAnchor({ left: 100, top: 100, width: 50, height: 20 });
		render(
			<ActionPanel anchor={anchor} open={false}>
				<div data-test-panel style={{ width: 200, height: 100 }}>menu</div>
			</ActionPanel>
		);
		expect(document.body.querySelector('[data-test-panel]')).toBeNull();
		anchor.remove();
	});

	it('positions itself bottom-start beneath the anchor by default', () => {
		const anchor = makeAnchor({ left: 100, top: 100, width: 50, height: 20 });
		render(
			<ActionPanel anchor={anchor} offset={4}>
				<div data-test-panel style={{ width: 200, height: 60 }}>menu</div>
			</ActionPanel>
		);
		const panel = getPanel().parentElement!;
		const r = panel.getBoundingClientRect();
		// bottom-start: left edge aligned with anchor.left, top below anchor.bottom + offset
		expect(Math.round(r.left)).toBe(100);
		expect(Math.round(r.top)).toBe(100 + 20 + 4);
		anchor.remove();
	});

	it('aligns right edge for bottom-end placement', () => {
		const anchor = makeAnchor({ left: 100, top: 100, width: 50, height: 20 });
		render(
			<ActionPanel anchor={anchor} placement="bottom-end" offset={0}>
				<div data-test-panel style={{ width: 200, height: 60 }}>menu</div>
			</ActionPanel>
		);
		const panel = getPanel().parentElement!;
		const r = panel.getBoundingClientRect();
		// bottom-end: right edge of panel == right edge of anchor (150). With width 200 → left = -50, but clamped to viewport min 0.
		expect(Math.round(r.left)).toBe(0);
		expect(Math.round(r.top)).toBe(120);
		anchor.remove();
	});

	it('flips above when there is no room below for bottom placement', () => {
		// Place anchor near the bottom of the viewport so the panel cannot fit below.
		const vh = window.innerHeight;
		const anchor = makeAnchor({ left: 50, top: vh - 30, width: 50, height: 20 });
		render(
			<ActionPanel anchor={anchor} offset={4}>
				<div data-test-panel style={{ width: 100, height: 100 }}>menu</div>
			</ActionPanel>
		);
		const panel = getPanel().parentElement!;
		const r = panel.getBoundingClientRect();
		// flipped above: top = anchor.top - offset - panelH = (vh-30) - 4 - 100
		expect(Math.round(r.top)).toBe(vh - 30 - 4 - 100);
		anchor.remove();
	});

	it('clamps horizontally to a boundary element', () => {
		// boundary rect: left=200, right=400. Anchor at left=380 with panel width 200 → would overflow at 580.
		const boundary = makeAnchor({ left: 200, top: 0, width: 200, height: 600 });
		boundary.style.background = 'transparent';
		const anchor = makeAnchor({ left: 380, top: 50, width: 10, height: 10 });
		render(
			<ActionPanel anchor={anchor} boundary={boundary} offset={0}>
				<div data-test-panel style={{ width: 200, height: 50 }}>menu</div>
			</ActionPanel>
		);
		const panel = getPanel().parentElement!;
		const r = panel.getBoundingClientRect();
		// Clamped to boundary.right (400) - panelW (200) = 200
		expect(Math.round(r.left)).toBe(200);
		anchor.remove();
		boundary.remove();
	});

	it('repositions when the anchor moves and a scroll event fires', () => {
		const anchor = makeAnchor({ left: 100, top: 100, width: 50, height: 20 });
		render(
			<ActionPanel anchor={() => anchor} offset={4}>
				<div data-test-panel style={{ width: 200, height: 60 }}>menu</div>
			</ActionPanel>
		);
		const panel = getPanel().parentElement!;
		expect(Math.round(panel.getBoundingClientRect().top)).toBe(124);
		// Move the anchor and dispatch a capture-phase scroll.
		anchor.style.top = '300px';
		act(() => {
			window.dispatchEvent(new Event('scroll'));
		});
		expect(Math.round(panel.getBoundingClientRect().top)).toBe(300 + 20 + 4);
		anchor.remove();
	});

	it('calls onClose on outside pointerdown', () => {
		const anchor = makeAnchor({ left: 100, top: 100, width: 50, height: 20 });
		let closed = 0;
		render(
			<ActionPanel anchor={anchor} onClose={() => closed++}>
				<div data-test-panel>menu</div>
			</ActionPanel>
		);
		act(() => {
			document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		});
		expect(closed).toBe(1);
		anchor.remove();
	});

	it('does not call onClose when pointerdown lands inside the panel', () => {
		const anchor = makeAnchor({ left: 100, top: 100, width: 50, height: 20 });
		let closed = 0;
		render(
			<ActionPanel anchor={anchor} onClose={() => closed++}>
				<div data-test-panel>menu</div>
			</ActionPanel>
		);
		const inner = getPanel();
		act(() => {
			inner.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		});
		expect(closed).toBe(0);
		anchor.remove();
	});

	it('calls onClose on Escape', () => {
		const anchor = makeAnchor({ left: 100, top: 100, width: 50, height: 20 });
		let closed = 0;
		render(
			<ActionPanel anchor={anchor} onClose={() => closed++}>
				<div data-test-panel>menu</div>
			</ActionPanel>
		);
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		expect(closed).toBe(1);
		anchor.remove();
	});

	it('respects dismissOnOutsideClick=false', () => {
		const anchor = makeAnchor({ left: 100, top: 100, width: 50, height: 20 });
		let closed = 0;
		render(
			<ActionPanel anchor={anchor} dismissOnOutsideClick={false} onClose={() => closed++}>
				<div data-test-panel>menu</div>
			</ActionPanel>
		);
		act(() => {
			document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		});
		expect(closed).toBe(0);
		anchor.remove();
	});

	it('accepts a DOMRect anchor', () => {
		const rect = new DOMRect(123, 45, 60, 30);
		render(
			<ActionPanel anchor={rect} offset={0}>
				<div data-test-panel style={{ width: 100, height: 50 }}>menu</div>
			</ActionPanel>
		);
		const panel = getPanel().parentElement!;
		const r = panel.getBoundingClientRect();
		expect(Math.round(r.left)).toBe(123);
		expect(Math.round(r.top)).toBe(45 + 30);
	});

	it('HoverMenu defaults to top-start placement', () => {
		const anchor = makeAnchor({ left: 100, top: 200, width: 50, height: 20 });
		render(
			<HoverMenu anchor={anchor} offset={4}>
				<div data-test-panel style={{ width: 80, height: 30 }}>hover</div>
			</HoverMenu>
		);
		const panel = getPanel().parentElement!;
		const r = panel.getBoundingClientRect();
		// top-start: top = anchor.top - offset - panelH = 200 - 4 - 30 = 166
		expect(Math.round(r.top)).toBe(166);
		expect(Math.round(r.left)).toBe(100);
		anchor.remove();
	});
});
