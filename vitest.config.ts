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
			'@plim/editor': new URL('./packages/editor/src/index.ts', import.meta.url).pathname,
			'@plim/markdown': new URL('./packages/markdown/src/index.ts', import.meta.url).pathname,
		},
	},
});
