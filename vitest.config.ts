import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['packages/*/test/**/*.test.ts'],
		exclude: ['**/*.browser.test.ts', '**/node_modules/**'],
	},
	resolve: {
		alias: {
			'@plim/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
			'@plim/ledger': new URL('./packages/ledger/src/index.ts', import.meta.url).pathname,
			'@plim/transports': new URL('./packages/transports/src/index.ts', import.meta.url).pathname,
			'@plim/collaboration': new URL('./packages/collaboration/src/index.ts', import.meta.url).pathname,
			'@plim/editor': new URL('./packages/editor/src/index.ts', import.meta.url).pathname,
			'@plim/markdown': new URL('./packages/markdown/src/index.ts', import.meta.url).pathname,
			'@plim/test-utils': new URL('./packages/test-utils/src/index.ts', import.meta.url).pathname,
			'@plim/html': new URL('./packages/html/src/index.ts', import.meta.url).pathname,
			'@plim/storage': new URL('./packages/storage/src/index.ts', import.meta.url).pathname,
		},
	},
});
