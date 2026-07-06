---
title: Installation
description: Install the Plim packages with pnpm and wire up the editor stylesheet.
---

Plim is published as a set of `@plim/*` packages on npm. Install the layers your
app needs.

## Vanilla (no React)

```sh
pnpm add @plim/core @plim/editor @plim/markdown
```

## React

```sh
pnpm add @plim/core @plim/editor @plim/markdown @plim/react react react-dom
```

`@plim/react` declares `react` and `react-dom` (`>=18`) as peer dependencies, so
you provide them from your app.

## Import the stylesheet

The editor ships its own stylesheet. Import it once at your app entry:

```ts
import '@plim/editor/styles.css';
```

If you use comments, also import the comments stylesheet (both are overridable via
CSS variables):

```ts
import '@plim/collaboration/comments.css';
```

If you use custom emoji, import the mojis stylesheet too:

```ts
import '@plim/mojis/mojis.css';
```

## Optional packages

These are independent and can be added later as needed:

- [`@plim/html`](/api/html/) - SSR / server-side HTML rendering.
- [`@plim/mojis`](/api/mojis/) - Slackmoji-style custom inline emoji. See the
  [Mojis guide](/guides/mojis/).
- [`@plim/storage`](/api/storage/) - durable persistence and autosave.
- [`@plim/ledger`](/api/ledger/), [`@plim/transports`](/api/transports/),
  [`@plim/collaboration`](/api/collaboration/) - the sync and collaboration stack.
- [`@plim/test-utils`](/api/test-utils/) - add as a `devDependency` for headless
  unit tests.

Next: head to the [Quickstart](/guides/quickstart/).
