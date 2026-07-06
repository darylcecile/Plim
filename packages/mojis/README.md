# @plim/mojis

Slackmoji-style **custom inline emoji** for the [Plim](https://github.com/darylcecile/plim) block editor. Type (or paste) a `:slug:` shortcode and it converts live into a "moji" — either a native emoji glyph or a custom image. Copying a moji yields its shortcode again, so `Hello 🌑` round-trips to `Hello :moon:` on the clipboard.

It ships as a single editor extension plus one stylesheet. The extension is framework-agnostic (no React/DOM assumptions beyond the mark's `toDOM`), so it works anywhere `@plim/core` runs the editor.

## Install

```sh
pnpm add @plim/mojis @plim/core
```

## Quick start

```ts
import { PlimDriver } from '@plim/core';
import { mojiExtension } from '@plim/mojis';
import '@plim/mojis/mojis.css';

const driver = new PlimDriver({
  extensions: [mojiExtension()],
});
```

`mojiExtension()` registers its own `moji` mark, so you don't have to list it in `registeredMarks`. If you configure marks explicitly (or want the mark available without the behaviour), import `mojiMark` and register it yourself.

Then mount the editor as usual (e.g. via `@plim/editor`'s `deriveEditor`, or `@plim/react`'s `<PlimEditor>`), and **import the stylesheet once** so image mojis paint correctly.

## Registering your own mojis

Applications resolve their own mojis (à la custom Slackmojis). Pass a `mojis` map, a `resolver` function, or both. A bare string is treated as a native glyph; an object with `src` is an image moji.

```ts
mojiExtension({
  mojis: {
    shipit: '🚀',                                   // native glyph
    partyparrot: { src: 'https://…/partyparrot.gif' }, // custom image
    plim: { src: '/assets/plim.svg', label: 'Plim' },
  },
});
```

For dynamic lookups (a workspace emoji registry, a primed cache, …) pass a `resolver`. It's consulted first; return `null`/`undefined` to fall through to the `mojis` map and the built-in defaults:

```ts
mojiExtension({
  resolver: (slug) => myRegistry.get(slug) ?? null,
  includeDefaults: false, // opt out of the bundled default set
});
```

### Async resolution (hundreds of custom emojis)

A real workspace can have **hundreds** of custom emojis served from a backend — too many to enumerate up front. Pass `resolveAsync` and the extension resolves unknown slugs on demand, exactly like a Slack client lazily loading its workspace emoji list:

```ts
mojiExtension({
  // Only called for slugs the synchronous path (resolver / mojis / defaults)
  // doesn't already know. Return a definition, or null for "no such emoji".
  resolveAsync: async (slug) => {
    const res = await fetch(`/api/emoji/${slug}`);
    return res.ok ? await res.json() : null; // { slug, src } | { slug, char }
  },
});
```

- **Non-blocking** — typing never waits on the network. On the first pass an unknown `:slug:` is left as literal text; when the fetch settles the block is re-scanned and the shortcode converts in place (the caret is adjusted just as for synchronous conversion).
- **Cached** — each slug is fetched **at most once**. Positive results and negative results (a slug the registry doesn't know) are both remembered, and in-flight fetches are de-duplicated, so `resolveAsync` is called once per distinct slug even while you type many.
- **Resilient** — a *rejected* fetch is not cached, so a later edit retries. (Implement your own TTL/refresh inside `resolveAsync` if emojis can change.)

The same cache is exposed standalone as `createMojiCache(resolveAsync)` (with `peek` / `ensure` / `onResolved`) if you need to drive resolution yourself.

Only **resolvable** slugs convert. Unknown shortcodes are left as literal text, so `10:30:` and `http://` are never mangled. The extension ships a small default set (`smile`, `moon`, `tada`, `+1`, …) which you can disable with `includeDefaults: false`.

## How it works

A moji is modelled as a **marked text span** that behaves like ordinary text — the caret moves before and after it, and it highlights natively inside a selection (no focus ring, no atomic selection):

- **Native glyph** — the span's text is the emoji itself (e.g. `🌑`), with attrs `{ slug: 'moon' }`. Because it's a real text node it selects and highlights like any other character.
- **Image moji** — the span's text is a single `U+2003` EM SPACE placeholder code unit (exported via `MOJI_IMAGE_PLACEHOLDER`), with attrs `{ slug, src }`. Using exactly one code unit keeps the caret from ever landing *inside* the moji and makes deletion a clean single step. The EM SPACE is invisible but has a real ~1em advance, so it renders a highlightable text cell: when the moji is inside a selection the browser paints the selection colour behind it, just like a native glyph. The image is drawn *on top* of that cell as a CSS `::before` foreground overlay (referencing the `--plim-moji-src` custom property set by `toDOM`), scaling with the surrounding font. Copy/export read the slug from `attrs`, never the text, so the placeholder never leaks.

### Live conversion (typing + paste)

After every transaction the extension scans the caret's block for `:slug:` shortcodes and rewrites each resolvable one in a single transaction. This uniformly handles **typing** (the shortcode completes at the caret) and **pasting** (many shortcodes arrive at once). Conversion is idempotent — a converted moji is a glyph/placeholder + attrs, not `:slug:` text, so it's never re-matched. Shortcodes inside an inline-`code` span (or an unclosed backtick fence) are left alone as an escape hatch. When `resolveAsync` is configured, an unknown-but-fetchable slug is left as text on this pass and converted later, once its remote lookup settles (see [Async resolution](#async-resolution-hundreds-of-custom-emojis)).

### Cursor behaviour

Mojis flow and select like text — the caret can rest immediately before and after one, and dragging a selection across a moji highlights it just like the surrounding characters. There is **no focus ring** and no caret snapping. The only special handling is correct whole-emoji deletion:

- **Grapheme-aware Backspace / Delete** — a native emoji glyph is often more than one UTF-16 code unit (a surrogate pair, or a ZWJ sequence), and the editor's default delete removes a single code unit, which would split the glyph. So when the caret is adjacent to a moji, one Backspace (or forward Delete) removes the whole grapheme cluster — exactly how a normal text box deletes an emoji.
- Typing right after a moji does **not** extend the moji mark onto the new text.

### Copy-as-slug

The `moji` mark defines a `toMarkdown` hook that returns `:slug:`. When you copy a selection containing mojis, the editor routes it through the Markdown serializer, so the clipboard's plain text contains the shortcodes:

> `Hello 🌑` → `Hello :moon:`

This relies on two small, general capabilities in the core packages (not moji-specific): `MarkDescriptor.toMarkdown` in `@plim/core`/`@plim/markdown`, and same-block copy interception in `@plim/editor`. Any inline mark can opt into shortcode-style clipboard export the same way.

## API

- `mojiExtension(options?)` — the editor extension. Options: `mojis?`, `resolver?`, `resolveAsync?`, `includeDefaults?` (see below).
- `mojiMark` — the `moji` mark descriptor (auto-registered by the extension).
- `mojiSpan(def)` — build a moji `TextSpan` from a `MojiDefinition` (handy for seeding initial content).
- `createMojiResolver(options)` — build the synchronous resolver used internally: order is `resolver` → `mojis` → defaults.
- `createMojiCache(resolveAsync)` — a slug→definition cache over an async resolver (`peek` / `ensure` / `onResolved`); used internally for `resolveAsync` and reusable standalone.
- `normalizeMojis(input)` — normalise an array or `slug → def | glyph` record into `MojiDefinition[]`.
- `DEFAULT_MOJIS` — the bundled default set.
- `MOJI_IMAGE_PLACEHOLDER` — the single `U+2003` EM SPACE code unit used as an image moji's text.
- Types: `MojiDefinition`, `MojiResolver`, `AsyncMojiResolver`, `MojiCache`, `CreateResolverOptions`, `MojiExtensionOptions`.
- Helpers (for custom integrations): `precededByMoji`, `followedByMoji`, `charHasMojiAt`, `previousGraphemeStart`, `nextGraphemeEnd`, `blockAtPath`, `pathsEqual`, `flatText`.

### `MojiDefinition`

```ts
interface MojiDefinition {
  slug: string;   // shortcode without the colons, e.g. "moon"
  char?: string;  // native emoji glyph, e.g. "🌑"
  src?: string;   // image URL (rendered via CSS background-image)
  label?: string; // optional human label (pickers / a11y)
}
```

A definition must carry either `char` or `src` to be renderable; slugs are matched case-insensitively.

## Requirements

- `@plim/core`, `@plim/editor`, and `@plim/markdown` at a version that supports `MarkDescriptor.toMarkdown` and same-block clipboard interception (copy-as-slug). Live conversion, cursor behaviour, and rendering work regardless.

## License

See [LICENSE](./LICENSE).
