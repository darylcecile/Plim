# 28 — Internationalization & Bidirectional Text

ProseMirror handles i18n as a careful **mostly-passive consumer of the
browser's text engine**. It doesn't run its own bidi resolver, doesn't
ship locale data, doesn't tokenize complex scripts. Instead it relies
on the DOM to lay out text correctly and uses a small, surgical set of
heuristics — `findDirection`, the `BIDI` regex, the `maybeRTL` regex —
to recover *direction* when arrow-key navigation needs it.

This file enumerates everything PM does for international text, what
it does **not** do (so the consumer must), and the production-grade
patterns for handling RTL, mixed-bidi, complex scripts, IME, smart
quotes, and vertical writing modes.

References use `file:line` against `/tmp/pm-source/prosemirror-view/src/`
unless noted.

---

## 1. The `dir` attribute and document direction

### 1.1 PM does not set `dir`

PM never writes the `dir` attribute on `view.dom` or on the document
node. Direction is **inherited** from the host page.

```html
<!-- consumer's responsibility -->
<div dir="rtl">
  <div class="ProseMirror" contenteditable="true">…</div>
</div>
```

Or per-instance:

```ts
new EditorView(target, {
  state,
  attributes: state => ({
    role: "textbox",
    "aria-multiline": "true",
    dir: state.doc.attrs?.dir ?? "auto",
  }),
})
```

### 1.2 `dir="auto"` and the first-strong heuristic

`dir="auto"` tells the browser to pick LTR or RTL based on the **first
strong character** in the element's text. For a paragraph that begins
with Arabic, the whole paragraph lays out RTL; if it begins with
English, LTR.

This is correct for *most* multilingual UX where the user types
free-form and you don't know the language. It's wrong for documents
where the *paragraph is mostly English but starts with a Hebrew name*
(the para flips RTL).

### 1.3 `unicode-bidi: plaintext`

For paragraphs where you want each *line* to direction-detect
independently (chat-style logs, mixed corpora), use:

```css
.pm-mixed-paragraph {
  unicode-bidi: plaintext;
}
```

This is closer to the Unicode Bidirectional Algorithm's
"paragraph-level" detection and matches what most messaging apps
expect. PM doesn't enable this by default — set it via NodeView CSS or
via the `attributes` prop on a per-node decoration.

### 1.4 Per-paragraph direction override

A common requirement: each paragraph carries its own `dir` attribute,
because a document mixes Arabic and English paragraphs and each must
lay out cleanly.

Schema pattern:

```ts
paragraph: {
  attrs: { dir: { default: null } },
  parseDOM: [{ tag: "p", getAttrs: (el: HTMLElement) => ({
    dir: el.getAttribute("dir") || null,
  })}],
  toDOM(node) {
    return ["p", node.attrs.dir ? { dir: node.attrs.dir } : {}, 0]
  },
}
```

PM's serializer ([12](./12-dom-serializer.md)) and parser
([11](./11-dom-parser.md)) carry the attribute through; the rendering
honors it via the platform.

### 1.5 Mixed bidi within a paragraph

A single paragraph with `English قرآن English` works without any
schema changes — the Unicode Bidirectional Algorithm (UBA) implemented
by the browser's text engine handles glyph reordering.

PM stores the *logical* (Unicode) order in the document. The DOM
stores the same logical order. The *visual* order (left-to-right
pixel order) is computed by the engine at layout time. PM never sees
visual order.

Implications:

- `state.doc.textBetween(from, to)` returns logical text — the same
  order the user typed.
- Cursor position is always logical. A position right after the last
  logical character of a Hebrew run is *visually on the left* of that
  run (because RTL).
- Selection ranges are contiguous in *logical* space. A drag-selection
  in mixed bidi can produce visually-discontinuous highlights —
  that's correct behavior per the UBA.

---

## 2. The Unicode Bidirectional Algorithm and PM's interaction with it

### 2.1 What the UBA does (one paragraph)

The UBA classifies each character as L (LTR strong), R (RTL strong),
AL (Arabic letter), AN (Arabic numeral), EN (European numeral), or
several weak/neutral types. It then resolves runs into *embedding
levels* (even = LTR, odd = RTL) so the text-shaping engine knows
which direction to draw each run.

### 2.2 What PM does *not* implement

PM ships **no** UBA implementation. It calls into the DOM for:

- Visual coordinates: `view.coordsAtPos(pos)` reads
  `Range.getBoundingClientRect()` from the layout engine, which has
  already run the UBA.
- Hit testing: `view.posAtCoords({left, top})` calls
  `document.caretPositionFromPoint` (or fallback), which respects bidi.
- Arrow-key direction: see §2.3.

### 2.3 `findDirection` — PM's only bidi heuristic

Source: `capturekeys.ts:223-242`.

```ts
function findDirection(view: EditorView, pos: number): "rtl" | "ltr" {
  let $pos = view.state.doc.resolve(pos)
  if (!(browser.chrome || browser.windows) && $pos.parent.inlineContent) {
    let coords = view.coordsAtPos(pos)
    if (pos > $pos.start()) {
      let before = view.coordsAtPos(pos - 1)
      let mid = (before.top + before.bottom) / 2
      if (mid > coords.top && mid < coords.bottom && Math.abs(before.left - coords.left) > 1)
        return before.left < coords.left ? "ltr" : "rtl"
    }
    if (pos < $pos.end()) {
      let after = view.coordsAtPos(pos + 1)
      let mid = (after.top + after.bottom) / 2
      if (mid > coords.top && mid < coords.bottom && Math.abs(after.left - coords.left) > 1)
        return after.left > coords.left ? "ltr" : "rtl"
    }
  }
  let computed = getComputedStyle(view.dom).direction
  return computed == "rtl" ? "rtl" : "ltr"
}
```

What it does:

1. **Skip the heuristic on Chrome and Windows.** They have a
   well-behaved `Selection.modify("move", "left"/"right", "character")`
   that already respects bidi. Other browsers — chiefly Firefox on
   non-Windows and older Safari — need help.
2. Get pixel coordinates of `pos`, `pos - 1`, `pos + 1`.
3. If the previous-character box is on the **same visual line** but
   the box is to the visual right of `pos`, the run before us is
   RTL. (Logical order and visual order disagree.)
4. Same logic for the following character.
5. Fall back to `getComputedStyle(view.dom).direction`.

Why: when the user presses Left arrow, what does it mean?
- In LTR, Left = decrement logical position.
- In RTL, Left = *increment* logical position (visual ← matches
  logical →).
- In mixed bidi, "Left" depends on which run the caret is in.

`findDirection` is consulted by `selectHorizontally`
(`capturekeys.ts:331`):

```ts
let dir = code == 37 ? (findDirection(view, view.state.selection.from) == "ltr" ? -1 : 1) : -1
```

`code == 37` is Left. If the run is LTR, dir=-1 (move logical
backward); if RTL, dir=+1 (move logical forward).

### 2.4 The `BIDI` regex — empty-range coordinates

Source: `domcoords.ts:344` —

```ts
const BIDI = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/
```

Used at `domcoords.ts:355`:

```ts
if (supportEmptyRange && (BIDI.test(node.nodeValue!) || (side < 0 ? !offset : offset == node.nodeValue!.length))) {
  let rect = singleRect(textRange(node as Text, offset, offset), side)
```

What this is for: in `coordsAtPos`, when the position is between two
characters of opposite direction, the *empty range* at that offset has
*two* possible coordinates — one for the LTR run, one for the RTL
run. PM picks based on the `side` argument (which side of the
position the caller wanted).

The BIDI regex covers:

- `U+0590–U+05F4`: Hebrew (block: Hebrew).
- `U+0600–U+06FF`: Arabic.
- `U+0700–U+08AC`: Syriac, Thaana, NKo, Samaritan, Mandaic, etc.

It does **not** cover:

- `U+FB1D–U+FB4F`: Hebrew presentation forms.
- `U+FB50–U+FDFF`: Arabic presentation forms-A.
- `U+FE70–U+FEFF`: Arabic presentation forms-B.
- `U+10800–U+10FFF`: ancient scripts (Phoenician, Aramaic, etc.).

In practice, modern text uses the base blocks; presentation forms are
deprecated. But documents containing legacy Arabic data may hit edge
cases where empty-range coords are off by a few pixels.

### 2.5 The `maybeRTL` regex — fast path for endOfTextblock

Source: `domcoords.ts:468` —

```ts
const maybeRTL = /[\u0590-\u08ac]/
```

Used at `domcoords.ts:478`:

```ts
if (!maybeRTL.test($head.parent.textContent) || !(sel as any).modify)
  return dir == "left" || dir == "backward" ? atStart : atEnd
```

Purpose: `endOfTextblockHorizontal` checks "is the caret at the
visual edge of its textblock?" In pure LTR text, this is trivially
"position 0" or "position == content.size". In any text with bidi
content, "leftmost position" can be in the middle of the logical
string.

Optimization: if the textblock has *no* characters in the bidi range,
skip the expensive `Selection.modify` round-trip and return the
trivial answer.

The regex range `[\u0590-\u08ac]` is the same as BIDI but condensed
into a single range — more permissive (also matches some Greek/Coptic
extension blocks technically) but the false-positive cost is minor
(one extra `Selection.modify` call).

### 2.6 caretBidiLevel preservation (Firefox)

Source: `domcoords.ts:485-499`. When PM uses `Selection.modify` to
probe bidi behavior, Firefox tracks `caretBidiLevel` on the selection
object. PM saves the level before its probe and restores it after,
because the probe move would otherwise cause Firefox to draw the
caret in the wrong run after restoration:

```ts
let oldBidiLevel = (sel as any).caretBidiLevel // Only for Firefox
;(sel as any).modify("move", dir, "character")
…
if (oldBidiLevel != null) (sel as any).caretBidiLevel = oldBidiLevel
```

This is a textbook example of how careful PM has to be when poking at
the browser selection state in mixed-bidi context.

---

## 3. Complex scripts

### 3.1 Devanagari and conjuncts

Devanagari (Hindi, Sanskrit, Marathi) forms *conjuncts* — multiple
consonants visually fused via the virama (U+094D). One conjunct
visually = one glyph but logically = several code points.

Example: क्ष (kṣa) = क + ् + ष = three code points, one visual cluster.

PM stores characters in NFC code-point order in the document. The DOM
stores the same. Both PM and the DOM agree on logical position.

Pitfalls:

- **Backspace**: native browser backspace deletes one *grapheme
  cluster*, not one code point. PM's default delete handler (via the
  browser) does the right thing, because it doesn't `preventDefault`
  on backspace at most positions.
- **Arrow keys**: native arrow keys on most platforms move by
  grapheme cluster (one cluster = one arrow press, even if 3 code
  points). PM observes the resulting selection via DOMObserver — no
  special handling needed.
- **`view.coordsAtPos` mid-cluster**: asking for coords at a position
  *inside* a cluster (e.g., pos 1 in `क्ष` if the cluster is 3 code
  points) returns coords of the cluster boundary. The position is
  technically *legal* but visually meaningless. Avoid it.

### 3.2 Arabic shaping

Arabic letters change shape based on context — initial, medial, final,
isolated. The browser's text engine handles shaping via OpenType
features (`init`, `medi`, `fina`, `isol`). PM never sees shaped forms;
it stores Unicode code points only.

Pitfalls:

- **Ligature ranges.** Some Arabic ligatures span 2-4 code points.
  Cursor placement *between* the ligated forms uses the underlying
  code-point boundary. The DOM caret may render between two glyphs
  that are visually fused.
- **Tashkeel (diacritics)**: zero-width modifying marks (U+064B–U+065F).
  Backspace usually removes them one at a time; some browsers remove
  the whole base+marks cluster. Not PM's call.
- **Right-to-left text with embedded LTR numbers**: `قيمة 12.5 ريال`.
  Numbers are EN/AN per UBA; the layout engine flips the numbers
  visually within the RTL run. Logical order is preserved.

### 3.3 Thai and word breaking

Thai writes without spaces between words. The browser's
`Selection.modify("move", "right", "word")` *should* call into the
platform's word-segmentation library (ICU on macOS, libthai on Linux,
custom on Windows). Quality varies.

PM does **not** ship word segmentation. It uses
`Selection.modify("move", _, "word")` on Ctrl+Arrow / Option+Arrow,
delegating to the platform. If the platform lies (Linux Firefox is
particularly weak on Thai), word-jumping is wrong.

For high-quality Thai support, the consumer can integrate `Intl.Segmenter`:

```ts
const segmenter = new Intl.Segmenter("th", { granularity: "word" })

function nextWordBoundary(text: string, from: number): number {
  for (const seg of segmenter.segment(text)) {
    if (seg.index >= from && seg.isWordLike) {
      return seg.index + seg.segment.length
    }
  }
  return text.length
}

// in a custom keymap:
"Ctrl-ArrowRight": (state, dispatch) => {
  const { $head } = state.selection
  const text = $head.parent.textContent
  const off = $head.parentOffset
  const next = nextWordBoundary(text, off)
  const tr = state.tr.setSelection(TextSelection.create(state.doc, $head.pos - off + next))
  if (dispatch) dispatch(tr)
  return true
}
```

`Intl.Segmenter` is now baseline (Safari 14.1+, Chrome 87+, Firefox
125+). For older browsers, ship a polyfill or accept platform
defaults.

### 3.4 CJK and IME input

CJK input runs through an IME — see [14 — IME &
Composition](./14-ime-composition.md) for the full pipeline. From an
i18n-correctness standpoint:

- **Input**: PM ignores DOM mutations during composition and reads
  the final string at `compositionend`.
- **Storage**: PM stores the composed string in the document. CJK
  characters are usually one code point per glyph (BMP) or surrogate
  pair (e.g., rare Hanzi in U+20000+). Surrogate-pair handling is
  inherited from JavaScript string semantics — `string.length`
  counts code units, not characters.
- **Cursor**: PM positions are byte-offsets in the model. For
  surrogate-pair characters, PM stores them as 2 positions each
  (each code unit). Arrow keys typically move 2 positions when
  crossing a surrogate pair. The browser caret renders correctly
  because the DOM has the same encoding.
- **Word breaking in CJK**: Chinese has no spaces; Japanese has
  partial spaces. Same `Intl.Segmenter` story as Thai — platform
  delegation by default; userland ICU/Segmenter for quality.

### 3.5 Korean Hangul composition

Korean Hangul has a unique input model: a syllable is composed from
3 jamo (initial consonant + vowel + optional final consonant). The
IME composes them into a single precomposed syllable on commit.

PM sees:

- During composition: jamo characters in the DOM, ignored.
- On commit: precomposed syllable (e.g., `가`) replaces the jamo.

Storage is in NFC (precomposed) form. PM doesn't normalize on input,
but the browser typically delivers NFC; if a paste arrives in NFD
(decomposed), PM stores it as NFD and the visual rendering is
identical. Equality / search will fail across NFC/NFD boundaries —
consumer normalizes on paste.

### 3.6 Burmese, Khmer, Lao, Sinhala

All complex-cluster scripts. Same general rules:

- Logical storage = Unicode code points.
- Visual rendering = browser's text engine.
- Cursor mid-cluster is legal but visually undefined.
- Backspace deletes a cluster (browser-managed).

If your editor cares about cluster-aware navigation (skip whole
cluster on arrow), use `Intl.Segmenter` with `granularity: "grapheme"`:

```ts
const grSeg = new Intl.Segmenter(undefined, { granularity: "grapheme" })
function clusterAfter(text: string, from: number): number {
  for (const seg of grSeg.segment(text.slice(from))) {
    return from + seg.segment.length
  }
  return text.length
}
```

PM does not do this by default; the browser's caret movement
typically handles grapheme clusters correctly.

---

## 4. ZWJ, ZWNJ, and invisibles

### 4.1 The characters

- **ZWJ** (U+200D, Zero-Width Joiner): forces ligation/joining where
  none would normally occur. Used in:
  - Arabic to force word-medial shapes outside of words.
  - Indic scripts to force conjunct formation.
  - Emoji sequences (👨‍👩‍👧 is `👨` + ZWJ + `👩` + ZWJ + `👧`).
- **ZWNJ** (U+200C, Zero-Width Non-Joiner): forbids joining. Used in
  Persian, Urdu, Indic scripts to prevent shaping/conjunction.
- **WJ** (U+2060, Word Joiner): glue characters across word boundaries
  without producing visible width.
- **ZWSP** (U+200B): word-break opportunity, no width.
- **BOM** (U+FEFF): byte-order mark, also acts as invisible.

### 4.2 Selection movement across ZWJ

The native browser selection moves *through* ZWJ as if it were any
character — it has a position. But ZWJ is invisible, so the user sees
no visible cursor change. Symptom: arrow-right twice to "skip" a
ligated cluster, but the second press appears to do nothing.

Per-platform behavior varies:

- macOS: native cursor often skips ZWJ.
- Windows: native cursor stops at ZWJ.
- Linux: same as the underlying engine (GTK/Qt).

PM does not normalize. Consumer pattern: filter ZWJ/ZWNJ on selection
move:

```ts
function skipInvisibles(text: string, pos: number, dir: 1 | -1): number {
  const skip = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/
  while (pos >= 0 && pos < text.length && skip.test(text[pos + (dir < 0 ? -1 : 0)])) {
    pos += dir
  }
  return pos
}
```

Bind into the keymap as a wrapper around the default arrow-key
behavior, or — more invasively — as a plugin that watches selection
changes and snaps past invisibles.

### 4.3 Input rules and ZWNJ

ZWNJ is commonly typed in Persian/Urdu via a dedicated keyboard key
(half-space). Input rules that match `\b` boundaries may misfire
because ZWNJ is a non-character break.

Rule-of-thumb for input rules in i18n contexts:

```ts
new InputRule(
  // Match Persian word boundary using ZWNJ-aware regex
  /([\u0600-\u06FF]+)\u200C/u,
  (state, match, start, end) => {
    // …
  }
)
```

The `u` flag is essential for Unicode property escapes
(`\p{Script=Arabic}`, etc.).

### 4.4 Emoji sequences (ZWJ-bound)

Modern emoji use ZWJ-glued sequences:

```
👨🏻‍💻 = 👨 + 🏻 + ZWJ + 💻
👨‍👩‍👧‍👦 = 👨 + ZWJ + 👩 + ZWJ + 👧 + ZWJ + 👦
🏳️‍🌈 = 🏳 + VS16 + ZWJ + 🌈
```

Where:
- `🏻` is a skin-tone modifier (U+1F3FB).
- `VS16` is U+FE0F, the variation selector for emoji presentation.

PM stores them as the raw code-point sequence. Visual rendering
collapses to one glyph (when the font supports the sequence).

Pitfalls:

- **Backspace**: native backspace generally deletes the entire
  ZWJ-bound cluster. PM lets the browser handle this. Some Linux
  browsers delete one component at a time, leaving an "orphan"
  emoji; this is a browser bug, not PM's.
- **Arrow keys**: native typically jumps the cluster.
- **Selection**: a click between `👨` and `👩` in a ZWJ family emoji
  may produce a selection inside the cluster — visually
  indistinguishable from outside, but logically distinct. Subsequent
  edits may produce malformed sequences.
- **Length counting**: `state.doc.textBetween(from, to).length`
  returns code-unit count, not glyph count. For UI character
  counters, use `Intl.Segmenter` with `granularity: "grapheme"`.

### 4.5 Bidi control characters

`U+202A`–`U+202E` (LRE, RLE, PDF, LRO, RLO), `U+2066`–`U+2069` (LRI,
RLI, FSI, PDI). These force or mark direction, sometimes maliciously
(see CVE-2021-42574, "Trojan Source"). For document editors, you can
either:

- Strip them on paste (security-conscious).
- Allow them but render them visibly (defensive).
- Pass them through (default).

PM doesn't strip. If you need a strip, do it in
`clipboardTextParser` or `transformPasted`:

```ts
new EditorView(target, {
  state,
  transformPastedText(text) {
    return text.replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
  },
})
```

---

## 5. Vertical writing modes

### 5.1 What `writing-mode` does

CSS `writing-mode: vertical-rl` lays out text top-to-bottom in columns
that read right-to-left. Used for Japanese (tategaki), Traditional
Chinese (rare for editing), Mongolian (variant: `vertical-lr`).

```css
.ProseMirror {
  writing-mode: vertical-rl;
  text-orientation: mixed;
}
```

### 5.2 What works

- Glyph layout, line breaking, font shaping — handled by the engine.
- DOM selection and caret rendering — handled by the engine, mostly.
- Input — works, including IME.

### 5.3 What breaks

PM has **no** vertical-writing-mode awareness. Specifically:

- **`view.coordsAtPos`** ([17 §6](./17-coordinates-and-hit-testing.md)):
  returns `{left, right, top, bottom}` in standard horizontal axes.
  The values are correct for the visual position; consumers using
  these values to position UI must rotate manually.
- **`view.posAtCoords`**: takes `{left, top}`. Works because it
  delegates to `caretPositionFromPoint`, which respects writing
  modes.
- **`endOfTextblock("up" | "down" | "left" | "right")`**: the
  semantics map to *block-axis* / *inline-axis* in the browser, not
  to actual screen up/down. In `vertical-rl`:
  - `"up"` = previous inline character (visual top).
  - `"left"` = previous block (visual left).
  - This is **opposite** of horizontal mode and PM's keymap
    interpretation breaks.
- **Arrow-key bindings** in `prosemirror-commands` and `capturekeys.ts`
  hard-code `up/down/left/right`. They were written for horizontal.
  In vertical mode, "ArrowUp" goes to the previous character in the
  current line (not the previous line).

### 5.4 The state of the art

PM has [issue #971](https://github.com/ProseMirror/prosemirror/issues/971)
open for vertical writing modes. Status as of this research: partial.
PM works well enough that you can edit Japanese tategaki, but:

- Arrow keys behave inconsistently across browsers.
- `endOfTextblock` checks misfire.
- Plugins doing coordinate math need rotation.

Recommendation: ship horizontal Japanese (`writing-mode: horizontal-tb`,
the default for most modern Japanese web content) unless you have a
strong product reason for vertical layout.

If you do ship vertical:

```ts
// userland: re-derive direction at the keymap level
const isVertical = () =>
  ["vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr"]
    .includes(getComputedStyle(view.dom).writingMode)

keymap({
  "ArrowUp": (state, dispatch, view) =>
    isVertical()
      ? originalLeftHandler(state, dispatch, view)
      : originalUpHandler(state, dispatch, view),
  // ...
})
```

This is a userland workaround. PM may grow first-class support
eventually.

---

## 6. Locale-sensitive smart quotes

### 6.1 The problem

The classic input rule: type `"` → get a smart quote. But:

- English: `"` → opens with `"` (U+201C), closes with `"` (U+201D).
- French: `«` (U+00AB) and `»` (U+00BB), with NBSP padding
  (`« hello »`).
- German: `„` (U+201E) opens, `"` (U+201C) closes (low-9, then high
  curly).
- Spanish: same as English curly, or sometimes `«»`.
- Czech / Slovak: `„` low-9 opens, `"` curly closes.
- Polish: `„` opens, `"` closes — same as German.
- Swiss French: `«` `»` without NBSP, or `‹` `›`.

A single set of input rules will be wrong in most locales.

### 6.2 Per-locale input rule factory

```ts
type QuoteSet = { open: string; close: string; spacing?: string }

const QUOTE_RULES: Record<string, QuoteSet> = {
  "en": { open: "\u201C", close: "\u201D" },
  "fr": { open: "\u00AB\u00A0", close: "\u00A0\u00BB" },  // NBSP
  "de": { open: "\u201E", close: "\u201C" },
  "es": { open: "\u00AB", close: "\u00BB" },
  "ja": { open: "\u300C", close: "\u300D" },
  // …
}

function smartQuoteRule(locale: string) {
  const q = QUOTE_RULES[locale.split("-")[0]] ?? QUOTE_RULES["en"]
  return new InputRule(
    /(?:^|[\s\(\[\{])"$/,
    (state, _match, start, end) =>
      state.tr.insertText(q.open, start + 1, end)
  )
}

// And the closing-quote rule (after non-space):
function smartCloseQuoteRule(locale: string) {
  const q = QUOTE_RULES[locale.split("-")[0]] ?? QUOTE_RULES["en"]
  return new InputRule(
    /\S"$/,
    (state, _match, start, end) =>
      state.tr.insertText(q.close, start + 1, end)
  )
}
```

Plug into the locale-aware editor:

```ts
const locale = document.documentElement.lang || navigator.language || "en"
const rules = inputRules({
  rules: [smartQuoteRule(locale), smartCloseQuoteRule(locale), …]
})
```

PM provides the `InputRule` primitive
([19 §6](./19-commands-keymap-inputrules.md)); the locale wiring is
**userland**.

### 6.3 Apostrophes and contractions

Same problem for `'` → `'` (U+2019, right single quotation mark).
Apostrophe in English is *contraction* (`don't` → `don't`), not
quote. Locales with different quote conventions still typically
agree on apostrophe = U+2019.

### 6.4 Dashes and ellipsis

- `--` → en dash (`–`) or em dash (`—`)? Locale convention.
- `...` → ellipsis (`…`).
- Both are usually safe to apply globally. The em-dash convention is
  more common in American English; en-dash in British.

### 6.5 Don't apply in monospace / code contexts

Crucial: an input rule that fires inside a `<code>` or `<pre>` block
is wrong. Smart quotes break syntax. PM's input rules respect node
boundaries via `parent.isTextblock` and the `inCode` predicate
patterns:

```ts
new InputRule(/…/, (state, match, start, end) => {
  const $start = state.doc.resolve(start)
  if ($start.parent.type.spec.code) return null  // skip in code
  return state.tr.insertText(...)
})
```

---

## 7. Selection behavior with mixed-direction runs

### 7.1 Visual vs logical selection

A user selects from `t` to `e` in `the معنى end`:

```
the معنى end       (logical)
the ىنعم end      (visual — the Arabic flips)
```

If they drag from the `t` of `the` to the `e` of `end`, the
*visual* selection covers the whole line, but the *logical* selection
is `the معنى end` — contiguous in storage.

If they drag from the *visual* middle of `معنى` (which is the *logical*
end of that word) backward to `the`, the visual selection looks
"reversed" (it skips a piece) but the logical selection is contiguous
(`the معن`, the first three Arabic letters).

PM handles this by trusting the DOM selection. `view.state.selection`
is always logical and contiguous.

### 7.2 Selection rendering

`Range.getBoundingClientRect()` and `Range.getClientRects()` return
*one rect per line per direction-run*. A selection across mixed bidi
yields multiple rects — PM passes them through to the
`coordsAtPos` / coords-based UI code.

If you draw a custom selection (rare in PM), iterate the rects:

```ts
function drawSelection(view: EditorView) {
  const sel = (view.domSelection() as Selection).getRangeAt(0)
  const rects = sel.getClientRects()
  for (const r of rects) {
    // draw a highlight for each segment
  }
}
```

### 7.3 Anchor / head asymmetry

In LTR text, `selection.from < selection.to` matches the visual
left-to-right span. In RTL text, the model order is the same but the
visual is reversed.

`anchor` and `head` (the two endpoints of a `TextSelection`) preserve
*selection direction* — a leftward drag from `the` end-position back
to its start gives `head < anchor`, regardless of the run's direction.

When custom UI shows "selection start" / "selection end", use
`from`/`to` (always logical-ascending). Use `anchor`/`head` only
for direction-sensitive operations (extending the selection).

### 7.4 Double-click word selection

Browser-managed. Word boundaries respect `Intl` script-aware
segmentation in modern engines.

In Arabic / Hebrew, double-click selects the word in *logical* terms;
the visual highlight may appear "inverted" because the word is
within an RTL run.

In Thai, word selection depends on platform — see §3.3.

---

## 8. Coordinate math with bidi

### 8.1 `coordsAtPos` in mixed bidi

Already covered briefly in §2.4. Recap from
[17 §6](./17-coordinates-and-hit-testing.md):

- `coordsAtPos(pos, side?)` returns `{left, right, top, bottom}`.
- In bidi context with empty range support (WebKit/Gecko at
  `domcoords.ts:355`), PM uses `Range.collapse` at the offset and
  reads the rect.
- The `side` argument disambiguates between the two possible visual
  positions at a direction boundary. `side > 0` → coords on the
  trailing-character side; `side < 0` → leading.

### 8.2 `posAtCoords` in mixed bidi

`view.posAtCoords({left, top})` calls `document.caretPositionFromPoint`
or `caretRangeFromPoint`. These already respect bidi — clicking at
the visual right end of an RTL word lands at the *logical start* of
the word, which is what the user expects ("I clicked the last visible
character, the cursor goes there").

### 8.3 UI anchored to selection in bidi

A bubble menu (`positionBubbleMenu` from [25 §5.3](./25-mobile.md))
that uses `coordsAtPos(sel.from)` and `coordsAtPos(sel.to)`:

- For LTR: `from` is left, `to` is right. Centroid is in the middle.
- For RTL: `from` is *right*, `to` is *left*. Centroid still in the
  middle, but if you set `left: from.left` you anchor the wrong end.

Robust pattern:

```ts
const a = view.coordsAtPos(sel.from)
const b = view.coordsAtPos(sel.to)
const left = (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2 - menu.offsetWidth / 2
const top = Math.min(a.top, b.top)
```

Use `min/max` of coordinates rather than assuming `from` < `to` in
visual space.

### 8.4 Rect-based hit testing for custom widgets

If you draw an absolutely-positioned overlay and want to know which
PM position the user clicked, `posAtCoords({left, top})` returns the
right answer regardless of bidi. Don't try to derive position from
character-grid math — there's no grid in bidi.

---

## 9. Date / number / currency formatting in inline contexts

### 9.1 The general principle

Editor content stores **the user's typed characters**, not formatted
output. If the user typed `2024-01-15`, that's what's in the doc.
Formatting (`Intl.DateTimeFormat`, `Intl.NumberFormat`) happens at
*render* time, in the consumer's NodeView or decoration.

### 9.2 Inline date / mention / variable nodes

Pattern: store the underlying value as an attr; render the localized
form in `toDOM` or NodeView.

```ts
const dateNode: NodeSpec = {
  inline: true,
  group: "inline",
  atom: true,
  attrs: { iso: { default: "" } },
  parseDOM: [{
    tag: "time[datetime]",
    getAttrs: (el: HTMLElement) => ({ iso: el.getAttribute("datetime") || "" }),
  }],
  toDOM(node) {
    const fmt = new Intl.DateTimeFormat(navigator.language, {
      year: "numeric", month: "long", day: "numeric",
    })
    const d = new Date(node.attrs.iso)
    const text = isNaN(d.getTime()) ? node.attrs.iso : fmt.format(d)
    return ["time", { datetime: node.attrs.iso, "aria-label": text }, text]
  },
}
```

The *underlying* attr is locale-independent. The *rendered* text is
locale-dependent. Round-tripping through copy/paste preserves the
underlying value; formatting follows the destination locale.

### 9.3 Numbers in mixed bidi

Numbers (`123.45`) are typed in code-points 0-9. The UBA classifies
them as EN; in an Arabic run they may render with Arabic-Indic digits
(٠١٢٣٤٥٦٧٨٩) if the font and CSS opt in:

```css
.ar-numerals {
  font-feature-settings: "lnum" off, "tnum" off;
}
```

PM stores ASCII digits regardless. Conversion is a render-time choice.
Don't store Arabic-Indic digits in the model unless the user typed
them (their keyboard explicitly outputs U+0660–U+0669).

### 9.4 Currency placement

Some locales place currency before the number (`$3.50`), some after
(`3,50 €`). For inline currency tokens, prefer `Intl.NumberFormat`
with `style: "currency"` at render time.

---

## 10. Fonts, ligatures, and shaping interactions

### 10.1 PM doesn't pick fonts

Font selection is CSS. The schema and PM model are font-agnostic.

But: font choice affects *cluster boundaries*. With one font, `fi` may
ligate (one glyph, two code points); with another, it doesn't. PM
positions are always code-point-based; the visual mapping varies.

### 10.2 OpenType features

`font-variant-ligatures: discretionary-ligatures` enables more
aggressive shaping. Doesn't change PM's storage; only changes rendering
and may shift `coordsAtPos` results across font changes.

### 10.3 Webfont swap and coordinate caching

If your editor caches `coordsAtPos` results, invalidate on
`document.fonts.ready`. A webfont swapping in mid-session can shift
every character's pixel position.

---

## 11. NodeViews and i18n

### 11.1 Lang attributes on inline runs

For mixed-language documents, mark inline language runs:

```ts
markSpec.lang = {
  attrs: { code: { default: "en" } },
  parseDOM: [{ tag: "span[lang]", getAttrs: el => ({ code: el.getAttribute("lang") }) }],
  toDOM: mark => ["span", { lang: mark.attrs.code }, 0],
}
```

`lang` attributes affect:

- Hyphenation (`hyphens: auto` is locale-aware).
- Spell-check (browser switches dictionaries).
- Screen-reader voice / pronunciation.

PM doesn't manage this; the schema defines it, the consumer sets the
mark.

### 11.2 NodeView per-locale rendering

A NodeView can read the document's lang and render accordingly. Watch
out: the NodeView is constructed once and updated on attr changes;
locale swaps need a full re-render.

---

## 12. Cross-references

- [04 §3 — `ResolvedPos.parent.textContent`](./04-resolved-positions.md) — what
  `maybeRTL.test()` reads.
- [08 §6 — Selection movement](./08-selection.md) — how `findDirection`
  is consumed.
- [11 §5 — DOM parser and ZWSP / ZWJ handling](./11-dom-parser.md).
- [12 §3 — DOM serializer](./12-dom-serializer.md) — `dir` round-tripping.
- [14 §3 — Composition and CJK IME](./14-ime-composition.md).
- [17 §6 — Coordinates and hit testing](./17-coordinates-and-hit-testing.md)
  — the BIDI regex consumer.
- [18 §2.3 — Browser flag table for direction-related flags](./18-cross-browser-quirks.md).
- [19 §6 — Input rules](./19-commands-keymap-inputrules.md) — locale-sensitive
  smart quotes.
- [22 §7 — Selection edge cases in mixed bidi](./22-edge-cases-and-pitfalls.md).
- [23 §9 — Lang/aria-label and AT pronunciation](./23-accessibility.md).
- [25 §4 — IME on Android (predictive text)](./25-mobile.md).

---

## 13. Honest summary

**PM provides:**

- ✅ `findDirection` heuristic for Firefox / non-Windows arrow keys
  (`capturekeys.ts:223`).
- ✅ `BIDI` regex for empty-range coords disambiguation
  (`domcoords.ts:344`).
- ✅ `maybeRTL` regex fast path for `endOfTextblockHorizontal`
  (`domcoords.ts:468`).
- ✅ `caretBidiLevel` preservation across `Selection.modify` probes
  (`domcoords.ts:485`).
- ✅ Code-point-based positions that are correct for any Unicode
  content.
- ✅ Pass-through of `dir`, `lang`, ZWJ, ZWNJ, bidi controls — PM
  never strips, never normalizes.
- ✅ Schema attribute round-tripping for `dir` and `lang` if the
  consumer wires them up.

**PM does *not* provide:**

- ❌ Setting `dir="auto"` or any direction on `view.dom`.
- ❌ A bidi resolver — it relies entirely on the DOM/UBA.
- ❌ Word segmentation for Thai, Khmer, CJK — relies on
  `Selection.modify("move", _, "word")`.
- ❌ Grapheme-cluster cursor movement — relies on the browser's caret
  movement.
- ❌ Locale-aware input rules (smart quotes, dashes, currency).
- ❌ ZWJ/ZWNJ-aware navigation (cursor steps over invisibles).
- ❌ Vertical writing-mode arrow keys / coordinate semantics.
- ❌ Number/date/currency formatting (consumer renders at NodeView
  level).
- ❌ Stripping/sanitizing bidi control characters on paste.
- ❌ Normalizing NFC/NFD on input.

**The general law:**

> ProseMirror's i18n correctness comes from staying out of the
> browser's way for everything *except* the few cases where the
> browser is too inconsistent to be trusted (`findDirection`,
> empty-range bidi coords, the `Selection.modify` probe).

For the consumer, this means: i18n is a userland concern. Plan for
locale-aware input rules, Intl-Segmenter-based navigation, careful
NodeView rendering of locale-sensitive data, and explicit testing
on multilingual fixtures (Arabic, Hebrew, CJK, Thai, Hindi, mixed
bidi paragraphs, vertical writing if applicable).
