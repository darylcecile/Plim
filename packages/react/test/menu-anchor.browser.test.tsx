import { describe, expect, it, afterEach } from 'vitest';
import { singleBlockInputBox } from '../src/extensions/slash-command.js';

// Regression guard for the "pop-up menu covers the input box" bug.
//
// Pop-up menus (slash, mention) anchor to the caret by default. Inside a
// single-block `PlimInputBox` that caret is a zero-height point *inside* the
// box; because a composer is pinned to the bottom of its container, `ActionPanel`
// flips the menu above the caret and its bottom edge lands inside the box,
// covering the text being typed. `singleBlockInputBox` redirects the anchor to
// the whole input box (or its `.plim-editor--single` root) so the flipped menu
// clears the entire composer. Multi-block editors must keep their caret anchor,
// so the helper returns `null` there. The flip math itself is covered by
// action-panel.browser.test.tsx ("flips above when there is no room below").

const hosts: HTMLElement[] = [];

function build(html: string): HTMLElement {
	const host = document.createElement('div');
	host.innerHTML = html.trim();
	document.body.appendChild(host);
	hosts.push(host);
	return host;
}

afterEach(() => {
	while (hosts.length) hosts.pop()!.remove();
});

describe('singleBlockInputBox (single-block menu anchor)', () => {
	it('anchors to the .plim-input-box chrome wrapper when present', () => {
		const host = build(`
			<div class="plim-input-box">
				<div class="plim-editor plim-editor--single">
					<div class="plim-block plim-block-paragraph" data-block-id="b1"></div>
				</div>
			</div>`);
		const block = host.querySelector('[data-block-id]');
		const box = host.querySelector('.plim-input-box');
		// Prefers the outer chrome wrapper so the flipped menu also clears its
		// border/padding, not just the inner text area.
		expect(singleBlockInputBox(block)).toBe(box);
	});

	it('falls back to the .plim-editor--single root when there is no chrome wrapper', () => {
		const host = build(`
			<div class="plim-editor plim-editor--single">
				<div class="plim-block plim-block-paragraph" data-block-id="b1"></div>
			</div>`);
		const block = host.querySelector('[data-block-id]');
		const single = host.querySelector('.plim-editor--single');
		expect(singleBlockInputBox(block)).toBe(single);
	});

	it('returns null in a multi-block editor so the caret anchor is preserved', () => {
		const host = build(`
			<div class="plim-editor">
				<div class="plim-block plim-block-paragraph" data-block-id="b1"></div>
			</div>`);
		const block = host.querySelector('[data-block-id]');
		expect(singleBlockInputBox(block)).toBeNull();
	});

	it('returns null for a null anchor', () => {
		expect(singleBlockInputBox(null)).toBeNull();
	});
});
