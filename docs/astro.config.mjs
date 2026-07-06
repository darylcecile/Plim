// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';

/**
 * The 11 published `@plim/*` library packages, in a sensible reading order.
 * Each entry becomes its own auto-generated API Reference section, produced by a
 * dedicated `starlight-typedoc` plugin instance so the packages never share a
 * TypeDoc run (and therefore never bleed symbols into one another).
 */
const apiPackages = [
  { name: 'core', label: '@plim/core', entry: '../packages/core/src/index.ts' },
  { name: 'editor', label: '@plim/editor', entry: '../packages/editor/src/index.ts' },
  { name: 'react', label: '@plim/react', entry: '../packages/react/src/index.tsx' },
  { name: 'markdown', label: '@plim/markdown', entry: '../packages/markdown/src/index.ts' },
  { name: 'mojis', label: '@plim/mojis', entry: '../packages/mojis/src/index.ts' },
  { name: 'html', label: '@plim/html', entry: '../packages/html/src/index.ts' },
  { name: 'ledger', label: '@plim/ledger', entry: '../packages/ledger/src/index.ts' },
  { name: 'transports', label: '@plim/transports', entry: '../packages/transports/src/index.ts' },
  { name: 'collaboration', label: '@plim/collaboration', entry: '../packages/collaboration/src/index.ts' },
  { name: 'storage', label: '@plim/storage', entry: '../packages/storage/src/index.ts' },
  { name: 'test-utils', label: '@plim/test-utils', entry: '../packages/test-utils/src/index.ts' },
];

// One plugin instance + one sidebar placeholder per package.
const typeDocPlugins = [];
const apiSidebarGroups = [];

for (const pkg of apiPackages) {
  const [plugin, sidebarGroup] = createStarlightTypeDocPlugin();
  typeDocPlugins.push(
    plugin({
      entryPoints: [pkg.entry],
      tsconfig: './tsconfig.typedoc.json',
      output: `api/${pkg.name}`,
      sidebar: { label: pkg.label, collapsed: true },
      typeDoc: {
        // Render an "index"/overview page per package so each section has a landing page.
        readme: 'none',
        // Name the root page `index.md` so each package overview is served at
        // `/api/<pkg>/` (Astro treats `index` as the directory route). The plugin
        // docs note `index` is the right choice for static site generators.
        entryFileName: 'index',
        useCodeBlocks: true,
        expandObjects: true,
        parametersFormat: 'table',
        propertiesFormat: 'table',
        enumMembersFormat: 'table',
      },
    }),
  );
  apiSidebarGroups.push(sidebarGroup);
}

// https://astro.build/config
export default defineConfig({
  site: 'https://plim-docs.vercel.app',
  integrations: [
    starlight({
      title: 'Plim',
      description:
        'A Notion-inspired block editor for the web - a framework-agnostic TypeScript monorepo.',
      tagline: 'A Notion-inspired block editor for the web.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/darylcecile/plim' },
      ],
      editLink: {
        baseUrl: 'https://github.com/darylcecile/plim/edit/main/docs/',
      },
      plugins: typeDocPlugins,
      sidebar: [
        {
          label: 'Live demo',
          link: '/demo/',
          badge: { text: 'Live', variant: 'success' },
        },
        {
          label: 'Guides',
          items: [
            { label: 'Introduction', link: '/guides/introduction/' },
            { label: 'Installation', link: '/guides/installation/' },
            { label: 'Quickstart', link: '/guides/quickstart/' },
            { label: 'Custom blocks', link: '/guides/custom-blocks/' },
            { label: 'Custom marks', link: '/guides/custom-marks/' },
            { label: 'Actions & triggers', link: '/guides/actions-and-triggers/' },
            { label: 'Extensions', link: '/guides/extensions/' },
            { label: 'Mojis (custom emoji)', link: '/guides/mojis/' },
            { label: 'History', link: '/guides/history/' },
            { label: 'Snapshots', link: '/guides/snapshots/' },
            { label: 'Ledger & sync', link: '/guides/ledger-and-sync/' },
            { label: 'Collaboration', link: '/guides/collaboration/' },
            { label: 'Comments & replies', link: '/guides/comments/' },
            { label: 'Markdown', link: '/guides/markdown/' },
            { label: 'HTML & SSR', link: '/guides/html-ssr/' },
            { label: 'Storage & autosave', link: '/guides/storage-autosave/' },
            { label: 'Testing', link: '/guides/testing/' },
          ],
        },
        {
          label: 'API Reference',
          items: apiSidebarGroups,
        },
      ],
    }),
  ],
});
