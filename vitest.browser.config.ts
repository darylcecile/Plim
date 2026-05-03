import { defineConfig } from 'vitest/config';

// Browser-mode config for the editor view layer. Real Chromium via Playwright
// is required because contenteditable, the Selection/Range APIs, IME
// composition events, ResizeObserver, and getBoundingClientRect are stubbed
// or unimplemented in jsdom/happy-dom.
export default defineConfig({
	test: {
		include: ['packages/*/test/**/*.browser.test.ts', 'packages/*/test/**/*.browser.test.tsx'],
		browser: {
			enabled: true,
			provider: 'playwright',
			name: 'chromium',
			headless: true,
			screenshotFailures: false,
		},
	},
	resolve: {
		alias: {
			'@plim/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
			'@plim/editor': new URL('./packages/editor/src/index.ts', import.meta.url).pathname,
			'@plim/markdown': new URL('./packages/markdown/src/index.ts', import.meta.url).pathname,
			'@plim/react': new URL('./packages/react/src/index.tsx', import.meta.url).pathname,
		},
	},
});
