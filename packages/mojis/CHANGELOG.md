# @plim/mojis

## 0.2.0

### Minor Changes

- Initial release of `@plim/mojis`: a Slackmoji-style extension for the Plim
  block editor that renders custom inline emoji ("mojis") live from `:slug:`
  shortcodes.
  - Live conversion while typing or pasting (only known/resolvable slugs
    convert, so `10:30:` and `http://` are never touched).
  - Pluggable resolver so applications can register their own mojis, backed by
    either a native emoji glyph or an image URL.
  - Async (dynamic) resolution via `resolveAsync` for workspaces with hundreds
    of custom emojis that can't be hardcoded: unknown slugs are looked up
    remotely without blocking typing, then converted in place once the fetch
    settles. Results are cached (positive and negative) and in-flight fetches
    de-duplicated, so each slug is fetched at most once (rejected fetches are
    left uncached so a later edit retries). The cache is also exported as
    `createMojiCache` for standalone use.
  - Copy-as-slug: copying a moji writes the `:slug:` shortcode to the clipboard
    as markdown (e.g. `Hello 🌑` → `Hello :moon:`).
  - Text-like cursor behaviour: a moji behaves like an ordinary run of text —
    the caret rests before and after it, it highlights natively inside a
    selection, and there is no focus ring. A single Backspace or forward Delete
    removes the whole emoji grapheme (so multi-code-unit glyphs aren't split).
    Image mojis render their picture as a foreground overlay above an invisible
    but full-width placeholder character, so the selection highlight shows
    behind them — through any transparent areas — exactly like a native glyph.
