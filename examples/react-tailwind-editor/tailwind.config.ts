import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  safelist: [
    {
      pattern: /^plim-/
    }
  ],
  theme: {
    extend: {
      boxShadow: {
        editor: '0 24px 80px rgb(15 23 42 / 0.12)'
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif']
      }
    }
  },
  plugins: []
} satisfies Config;
