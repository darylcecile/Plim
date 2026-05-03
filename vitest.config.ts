import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const packageSource = (name: string): string => resolve(rootDir, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@plim/core': packageSource('core'),
      '@plim/model': packageSource('model'),
      '@plim/blocks': packageSource('blocks'),
      '@plim/editor': packageSource('editor'),
      '@plim/markdown': packageSource('markdown'),
      '@plim/input': packageSource('input'),
      '@plim/selection': packageSource('selection'),
      '@plim/databases': packageSource('databases'),
      '@plim/react': resolve(rootDir, 'packages', 'react', 'src', 'index.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx'],
    server: {
      deps: {
        inline: [/^@plim\//]
      }
    }
  }
});
