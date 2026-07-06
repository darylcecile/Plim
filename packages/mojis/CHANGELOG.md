# @plim/mojis

## 0.3.0

### Minor Changes

- 30ad81e: Add `@plim/mojis` — a Slackmoji-style custom inline emoji ("moji") plugin — plus the general, non-breaking editor primitives it needed.

  - **`@plim/mojis`** (new): a framework-agnostic editor extension that renders custom emoji from `:slug:` shortcodes. Shortcodes convert **live** as you type or paste, resolve through a built-in default set or your own `resolver`/`mojis` definitions (native emoji glyph _or_ image URL), and behave like **ordinary text** for cursor movement and selection — the caret rests before/after a moji and it highlights natively, with no focus ring — while a single Backspace/Delete removes the whole emoji grapheme. For workspaces with hundreds of custom emojis that can't be hardcoded, an async `resolveAsync` option resolves unknown slugs on demand (à la Slack loading its emoji list lazily): lookups never block typing, results are cached (positive _and_ negative) and de-duplicated so each slug is fetched at most once, and the pending shortcode converts in place once the fetch settles. **Copying** a moji yields its `:slug:` shortcode as markdown/plain text (e.g. `Hello 🌑` → `Hello :moon:`). Register it with `mojiExtension({ mojis, resolver, resolveAsync })`; ships with `mojis.css`.

  The package builds on three additive enhancements to the core stack (no existing APIs change):

  - **`@plim/core`** — `MarkDescriptor` gains an optional `toMarkdown(payload)` hook so a mark can define its own markdown serialization.
  - **`@plim/markdown`** — the serializer honors a mark's `toMarkdown` hook; `contentToMarkdown` / `serializeInline` / `serializeSpan` now thread an optional resolved `marks` list.
  - **`@plim/editor`** — clipboard copy/cut pass the registered `marks` through to the markdown writer, and a same-block **copy** is routed through the markdown serializer (as an inline-only paragraph, so no block prefixes leak) when a selected span carries a mark whose descriptor defines `toMarkdown`. Otherwise copy stays native, preserving existing behaviour.

### Patch Changes

- Updated dependencies [30ad81e]
- Updated dependencies [94b47dd]
  - @plim/core@0.3.0
