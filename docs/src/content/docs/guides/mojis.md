---
title: Mojis (custom emoji)
description: "Slackmoji-style custom inline emoji that convert live from :slug: shortcodes."
---

`@plim/mojis` adds Slackmoji-style **custom inline emoji** ("mojis") to the editor.
Type (or paste) a `:slug:` shortcode and it converts live into a moji, which can be a
native emoji glyph or a custom image. Copying a moji yields its shortcode again, so
`Hello 🌑` round-trips to `Hello :moon:` on the clipboard.

It ships as a single editor [extension](/guides/extensions/) plus one stylesheet, and it
is framework-agnostic - it works anywhere `@plim/core` runs the editor. See the
[`@plim/mojis` API reference](/api/mojis/) for the full surface.

## Install

```sh
pnpm add @plim/mojis @plim/core
```

```ts
import { PlimDriver } from '@plim/core';
import { mojiExtension } from '@plim/mojis';
import '@plim/mojis/mojis.css';

const driver = new PlimDriver({
  extensions: [mojiExtension()],
});
```

`mojiExtension()` registers its own `moji` mark, so you do not have to list it in
`registeredMarks`. Import the stylesheet once so image mojis paint correctly.

## Registering your own mojis

Applications resolve their own mojis. Pass a `mojis` map, a `resolver` function, or
both. A bare string is a native glyph; an object with `src` is an image moji.

```ts
mojiExtension({
  mojis: {
    shipit: '🚀',                                      // native glyph
    partyparrot: { src: 'https://…/partyparrot.gif' }, // custom image
    plim: { src: '/assets/plim.svg', label: 'Plim' },
  },
});
```

For dynamic lookups pass a `resolver`. It is consulted first; return `null`/`undefined`
to fall through to the `mojis` map and the built-in defaults:

```ts
mojiExtension({
  resolver: (slug) => myRegistry.get(slug) ?? null,
  includeDefaults: false, // opt out of the bundled default set
});
```

Only **resolvable** slugs convert, so `10:30:` and `http://` are never mangled. The
extension ships a small default set (`smile`, `moon`, `tada`, `+1`, ...) that you can
disable with `includeDefaults: false`.

## Async resolution (hundreds of custom emoji)

A real workspace can have hundreds of custom emoji served from a backend - too many to
enumerate up front. Pass `resolveAsync` and the extension resolves unknown slugs on
demand, exactly like a Slack client lazily loading its workspace emoji list:

```ts
mojiExtension({
  // Only called for slugs the synchronous path (resolver / mojis / defaults)
  // does not already know. Return a definition, or null for "no such emoji".
  resolveAsync: async (slug) => {
    const res = await fetch(`/api/emoji/${slug}`);
    return res.ok ? await res.json() : null; // { slug, src } | { slug, char }
  },
});
```

- **Non-blocking** - typing never waits on the network. On the first pass an unknown
  `:slug:` is left as literal text; when the fetch settles the block is re-scanned and
  the shortcode converts in place, with the caret adjusted as for synchronous conversion.
- **Cached** - each slug is fetched at most once. Positive and negative results are both
  remembered, and in-flight fetches are de-duplicated.
- **Resilient** - a rejected fetch is not cached, so a later edit retries.

The same cache is exposed standalone as
[`createMojiCache(resolveAsync)`](/api/mojis/) (with `peek` / `ensure` / `onResolved`)
if you need to drive resolution yourself.

## Behaviour

Mojis flow and select like ordinary text - the caret can rest immediately before and
after one, and dragging a selection across a moji highlights it just like the
surrounding characters. There is no focus ring and no atomic selection.

- **Live conversion** handles both typing (the shortcode completes at the caret) and
  pasting (many shortcodes arrive at once), in a single transaction. Conversion is
  idempotent, and shortcodes inside an inline-`code` span are left alone as an escape
  hatch.
- **Grapheme-aware deletion** - a native emoji is often more than one UTF-16 code unit,
  so one Backspace (or forward Delete) next to a moji removes the whole glyph, exactly
  like a normal text box.
- **Copy-as-slug** - the `moji` mark defines a `toMarkdown` hook that returns `:slug:`,
  so copying a selection containing mojis puts the shortcodes on the clipboard. This
  builds on `MarkDescriptor.toMarkdown` in [`@plim/core`](/api/core/) and
  [`@plim/markdown`](/api/markdown/), plus same-block copy interception in
  [`@plim/editor`](/api/editor/) - so any inline mark can opt into shortcode-style
  clipboard export the same way.

## Requirements

Live conversion, cursor behaviour, and rendering work with any recent `@plim/core` and
`@plim/editor`. Copy-as-slug additionally needs versions of `@plim/core`,
`@plim/editor`, and `@plim/markdown` that support `MarkDescriptor.toMarkdown` and
same-block clipboard interception.
