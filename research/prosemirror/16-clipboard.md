# 16 — Clipboard

ProseMirror's clipboard subsystem is a thin but very deliberate bridge between
the editor's structured `Slice` model and the unstructured world of OS
clipboards, drag-and-drop, and external apps. Almost all of it lives in two
files:

- `prosemirror-view/src/clipboard.ts` — `serializeForClipboard`,
  `parseFromClipboard`, plus a handful of normalization helpers
  (`closeSlice`, `normalizeSiblings`, `addContext`, `readHTML`,
  `restoreReplacedSpaces`).
- `prosemirror-view/src/input.ts` — the actual `copy` / `cut` / `paste` /
  `dragstart` / `drop` DOM event handlers that call into clipboard.ts.

The design makes one fundamental compromise visible in the code: when content
leaves PM and re-enters it, we want a **lossless round-trip**, but when content
arrives from a foreign producer (Word, Google Docs, GitHub, the OS) we want to
**fit it into the schema**. ProseMirror solves both in the same parser by
embedding a small sidecar of metadata (`data-pm-slice`) on the wrapper element
and falling back to schema-driven repair when that sidecar is missing.

---

## 1. The clipboard data model

ProseMirror puts at most three things on a `DataTransfer`:

| MIME              | Value                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| `text/html`       | Serialized DOM with a `data-pm-slice` attribute on its outer element (the wrapper).    |
| `text/plain`      | Best-effort plain text (`Slice.content.textBetween(..., "\n\n")` by default).          |
| (custom, opt-in)  | The user can replace the HTML serializer / text serializer via `EditorProps`.          |

It does **not** define its own MIME (no `application/x-prosemirror+json` or
similar). The only metadata channel that survives a round-trip through an
external clipboard is the `data-pm-slice` attribute embedded in the HTML.
That's a deliberate choice: many target apps strip non-standard MIMEs but
preserve HTML attributes.

For drag-and-drop, the same data is written to `DataTransfer`, plus the view
holds a private `view.dragging = new Dragging(slice, move, node)` so that an
internal drag knows the *original* `Slice` exactly without round-tripping
through HTML (clipboard.ts:5–40 and input.ts:680–708).

Files (e.g. images dragged in from the desktop) are exposed via
`DataTransfer.files`; ProseMirror does not handle them in core — they are
delivered to userland through `handlePaste` / `handleDrop` and the user can
inspect `event.clipboardData` / `event.dataTransfer` themselves
(input.ts:636, 741). Core's only acknowledgment of files is one Chrome-specific
ordering bug in `dragstart` (input.ts:700–702).

### Editor props that hook the pipeline

From `prosemirror-view/src/index.ts`:

- `clipboardSerializer?: DOMSerializer` (index.ts:766) — overrides the default
  `DOMSerializer.fromSchema` for copy.
- `clipboardTextSerializer?: (slice, view) => string` (index.ts:772) —
  overrides the plain-text fallback.
- `transformCopied?: (slice, view) => Slice` (index.ts:723) — last chance to
  rewrite the slice before it's serialized.
- `clipboardParser?: DOMParser` (index.ts:701) — overrides the default parser
  for paste. Falls through to `domParser`.
- `clipboardTextParser?: (text, $context, plain, view) => Slice`
  (index.ts:714) — overrides the default "split on newlines, wrap in `<p>`,
  parse" pipeline.
- `transformPastedHTML?: (html, view) => string` (index.ts:696) — runs on the
  raw HTML *before* parsing.
- `transformPastedText?: (text, plain, view) => string` (index.ts:705) — runs
  on raw text before it's used.
- `transformPasted?: (slice, view, plain) => Slice` (index.ts:719) — runs on
  the parsed slice immediately before it hits the document.
- `handlePaste?: (view, event, slice) => boolean` (index.ts:666) — full
  override.
- `handleDrop?: (view, event, slice, moved) => boolean` (index.ts:671) — full
  override.
- `dragCopies?: (event) => boolean` (index.ts:682) — controls whether an
  in-editor drag moves or copies (defaults to "alt on mac, ctrl elsewhere"
  via `dragCopyModifier` in input.ts:673).

These are all read with `view.someProp(name, ...)`, so plugins compose: the
first non-undefined return wins.

### Test-only re-exports

`prosemirror-view/src/index.ts:23–25` exposes:

```ts
export const __parseFromClipboard = parseFromClipboard
export const __endComposition = endComposition
```

These are leading-underscore "internal" exports used by the test suite to
exercise paste without synthesizing a real `ClipboardEvent`. There is no
matching `__serializeForClipboard` re-export in the version of the source we
read; `serializeForClipboard` is exported directly from `clipboard.ts:5` and
imported by `input.ts:7`. Userland is welcome to import it from the package
entry — a number of plugins (e.g. table copy/paste) do exactly that.

---

## 2. COPY / CUT pipeline

### 2.1 Wire-up

`input.ts:595`:

```ts
handlers.copy = editHandlers.cut = (view, _event) => {
  let event = _event as ClipboardEvent
  let sel = view.state.selection, cut = event.type == "cut"
  if (sel.empty) return                                          // 598
  let data = brokenClipboardAPI ? null : event.clipboardData     // 601
  let slice = sel.content(), {dom, text} = serializeForClipboard(view, slice)
  if (data) {
    event.preventDefault()
    data.clearData()
    data.setData("text/html", dom.innerHTML)                     // 606
    data.setData("text/plain", text)                             // 607
  } else {
    captureCopy(view, dom)                                       // 609
  }
  if (cut) view.dispatch(view.state.tr.deleteSelection()
                            .scrollIntoView()
                            .setMeta("uiEvent", "cut"))           // 611
}
```

A few things to note:

- Empty selections produce *no* clipboard event (early `return` on 598). This
  matches browser default and, importantly, prevents PM from clobbering an
  external selection that the user copied while the editor was unfocused but
  the event still bubbles.
- The "broken clipboard API" branch (`captureCopy`, input.ts:568) is for
  IE < 15 and ancient iOS WebKit < 604. It synthesizes a copy by appending the
  serialized DOM to a fixed, off-screen wrapper, blurring the editor (so IE
  doesn't fire spurious selectionchange), `selectNodeContents`-ing the wrapper,
  and letting the browser's *native* copy fire on it. After 50ms the wrapper is
  removed and focus is restored.
- The cut delete is dispatched *after* serialization, with
  `setMeta("uiEvent", "cut")` so plugins (history, collab) can distinguish it.

### 2.2 `serializeForClipboard(view, slice)` (clipboard.ts:5–40)

This function does five things in order:

1. **`transformCopied` hook** (clipboard.ts:6). Userland gets first stab at
   rewriting the slice (e.g. converting decorations into real marks, or
   stripping internal-only attributes).

2. **Open-depth flattening** (clipboard.ts:8–15):

   ```ts
   while (openStart > 1 && openEnd > 1 &&
          content.childCount == 1 && content.firstChild!.childCount == 1) {
     openStart--; openEnd--
     let node = content.firstChild!
     context.push(node.type.name,
                  node.attrs != node.type.defaultAttrs ? node.attrs : null)
     content = node.content
   }
   ```

   When you copy from deep inside a structure (say, a paragraph inside a
   blockquote inside a list item), the slice has many "open" levels at the
   sides. Putting *all* of them on the clipboard is harmful — you'd end up
   with an empty `<ul><li><blockquote>` wrapping a single span, which external
   apps render terribly. So we *unwrap* single-child levels, recording the
   discarded wrapper types and attrs into `context`. On paste, this `context`
   is replayed (see `addContext`, clipboard.ts:250–263) so PM can re-wrap and
   land back into the same structural location it came from.

3. **Serialize via `DOMSerializer`** (clipboard.ts:17–19). Default is
   `DOMSerializer.fromSchema(view.state.schema)`; userland can swap it via
   `clipboardSerializer`. `serializeFragment` is called with a *detached*
   document (clipboard.ts:206–209) so styles, IDs, and event handlers from the
   live editor DOM don't leak into the clipboard. The result is appended into
   a freshly created `<div>` wrapper.

4. **Outer-tag fix-up for "fragment-only" elements** (clipboard.ts:21–30).
   Some HTML elements can't be top-level children of a `<div>` and survive a
   round-trip through `innerHTML` — most notably table parts. The `wrapMap`
   constant (clipboard.ts:194–204) is the same table jQuery uses:

   ```ts
   thead/tbody/tfoot/caption/colgroup → ["table"]
   col                                → ["table", "colgroup"]
   tr                                 → ["table", "tbody"]
   td/th                              → ["table", "tbody", "tr"]
   ```

   If the slice's first child is one of those, PM wraps it in the necessary
   ancestors and *counts* the wrappers (`wrappers++`). The count is recorded
   in `data-pm-slice` so the parser can unwrap exactly the same number on the
   way back in.

5. **Stamp `data-pm-slice`** on whatever element ends up as the *first* child
   of the wrapper (clipboard.ts:32–34):

   ```ts
   `${openStart} ${openEnd}${wrappers ? ` -${wrappers}` : ""} ${JSON.stringify(context)}`
   ```

   Format (single space-delimited tokens):
   - `openStart` (post-flatten)
   - `openEnd` (post-flatten)
   - optional `-N` indicating *N* synthetic table-style wrappers to peel
   - `context` — a JSON array `[name1, attrs1, name2, attrs2, ...]` of the
     node levels that were flattened away in step 2.

6. **Plain-text fallback** (clipboard.ts:36–37):

   ```ts
   let text = view.someProp("clipboardTextSerializer", f => f(slice, view))
              || slice.content.textBetween(0, slice.content.size, "\n\n")
   ```

   Block separator is two newlines (paragraph break). `textBetween` recurses
   block-by-block and emits the leaf-block separator for non-text leaves.

The function returns `{dom, text, slice}`. `dom` is the serialized wrapper
(used as `dom.innerHTML` for `text/html`). `slice` is what survived
`transformCopied` — used by `dragstart` to populate `view.dragging`.

### 2.3 Wrapper-tag selection (block vs inline)

The wrapper itself is always a `<div>` (clipboard.ts:18). The reason we don't
e.g. use `<span>` for inline-only slices is twofold: (1) the table-fixup
machinery may need the wrapper to host a `<table>`, and (2) the `data-pm-slice`
attribute is hung on whichever DOM element ends up *first* in the wrapper, not
the wrapper itself, so we don't need the wrapper's tag to match. Many external
apps (Google Docs, MS Word) treat any block-level wrapper identically; the
inline-vs-block distinction is preserved by the *children*.

That said, the parser does care: when `data-pm-slice` is missing entirely, the
parsed slice's `openStart`/`openEnd` are recomputed from `Slice.maxOpen`
(clipboard.ts:97), which infers block-vs-inline from the schema.

### 2.4 The IE wrapper trick (`captureCopy`)

`input.ts:568–587`. Even when the clipboard API is broken, the *native* copy
shortcut still works on a non-editable, off-screen DOM range. So PM:

1. Appends a fixed-position, off-screen `<div>` to `view.dom.parentNode`.
2. Inserts the serialized clipboard DOM into it.
3. Blurs the editor (so IE doesn't fire `selectionchange` toward position 0
   when `removeAllRanges` is called — that would corrupt the editor selection).
4. Selects the temp wrapper and lets the browser's default copy fire.
5. After 50ms, removes the wrapper and refocuses the editor.

This path never touches `event.clipboardData` and writes only `text/html`
implicitly (via DOM selection).

---

## 3. PASTE pipeline

### 3.1 Wire-up

`input.ts:654`:

```ts
editHandlers.paste = (view, _event) => {
  let event = _event as ClipboardEvent
  if (view.composing && !browser.android) return                  // 660
  let data = brokenClipboardAPI ? null : event.clipboardData
  let plain = view.input.shiftKey && view.input.lastKeyCode != 45 // 662
  if (data && doPaste(view, getText(data), data.getData("text/html"), plain, event))
    event.preventDefault()
  else
    capturePaste(view, event)                                     // 666
}
```

Notes:

- **Composition guard** (660): During an active IME composition the browser's
  built-in paste handling is unreliable, so PM lets the native default run —
  except on Android, where the editor is essentially *always* composing and
  bailing out would mean pastes never work.
- **`plain` detection** (662): `shiftKey` is held *and* the last key was not
  keyCode 45 (the **Insert** key). On Windows, `Shift+Insert` is the OS-wide
  "paste" shortcut, so just because shift is down doesn't mean the user wants
  plain-text paste. Real plain paste comes from `Cmd/Ctrl+Shift+V`, where the
  last keyDown was `V` (88), not Insert.
- **Capture fallback** (666): Same as `captureCopy`, but for paste. Used when
  the clipboard API is broken: PM creates an off-screen contenteditable `<div>`
  (or `<textarea>` for plain-text / code-block contexts), focuses it, lets the
  browser's native paste fire into it, and then 50ms later reads its
  `textContent` / `innerHTML` and feeds them through `doPaste`. See
  `capturePaste`, input.ts:618–632.

`getText` (input.ts:647) is mildly clever: `text/plain` first, then `Text`
(IE), and as a last resort `text/uri-list` with newlines collapsed to spaces
— that lets dragged URLs (Files panel, browser address bars) appear as
sensible plain text.

### 3.2 `doPaste` (input.ts:634–645)

```ts
let slice = parseFromClipboard(view, text, html, preferPlain, view.state.selection.$from)
if (view.someProp("handlePaste", f => f(view, event, slice || Slice.empty))) return true
if (!slice) return false
let singleNode = sliceSingleNode(slice)                           // 639
let tr = singleNode
  ? view.state.tr.replaceSelectionWith(singleNode, preferPlain)   // 641
  : view.state.tr.replaceSelection(slice)                         // 642
view.dispatch(tr.scrollIntoView()
                 .setMeta("paste", true).setMeta("uiEvent", "paste"))
```

- **`handlePaste` runs *after* parsing**, so userland always sees the parsed
  slice (or `Slice.empty` if parsing failed). This is the supported escape
  hatch for image paste, link-only paste, etc.
- `sliceSingleNode` (input.ts:614) detects a "fully closed, one-node" slice;
  if so, PM uses `replaceSelectionWith` instead of `replaceSelection`. The
  difference: `replaceSelectionWith` lets the inserted node behave like an
  atomic insertion (selection ends up *after* it, marks are applied / not
  applied as appropriate; with `inheritMarks=preferPlain`, plain-paste keeps
  the surrounding marks, fancy-paste drops them — see
  `Transaction.replaceSelectionWith`, transaction.ts:149–155).
- `setMeta("paste", true)` is the conventional flag plugins (history, collab,
  rules) check to skip input-rule processing or to coalesce history.

### 3.3 `parseFromClipboard` (clipboard.ts:43–110)

This is the central function. Pseudo-flow:

```
                   ┌── inCode? plainText? html missing? ──┐
                   ▼                                      │
   text → transformPastedText                             │
        ├─ inCode → wrap raw text into a Slice; transformPasted; return
        └─ else → clipboardTextParser? → use it
                  else → split on \n, wrap each line in <p>, serialize
                                                                    │
                                                                    ▼
   html → transformPastedHTML → readHTML(html) → restoreReplacedSpaces (webkit)
                                                                    │
                                                                    ▼
   look for [data-pm-slice] anywhere in the parsed DOM              │
   │                                                                │
   │ found?                                                         │
   │   └─ if "-N" wrappers token, peel N first-element children     │
   │      (this unwraps the table fixup from copy step 4)           │
   │                                                                │
   ▼                                                                ▼
   parser.parseSlice(dom, {                                         │
     preserveWhitespace: asText || sliceData,                       │
     context: $context,                                             │
     ruleFromNode: kill trailing <BR> at non-inline parent          │
   })
                                                                    │
                                                                    ▼
   sliceData ?  closeSlice(slice, openStart, openEnd) → addContext(slice, ctxJSON)
            :  Slice.maxOpen(normalizeSiblings(content, $context), true)
                if openStart/openEnd → walk to first/last non-isolating
                                       node, then closeSlice
                                                                    │
                                                                    ▼
   transformPasted(slice, view, asText) → return
```

#### 3.3.1 Plain-text and code branches (clipboard.ts:47–66)

```ts
let asText = !!text && (plainText || inCode || !html)
```

`asText` triggers when (a) the user asked for plain (Shift+paste), (b) the
caret is in a `code` parent (so HTML structure is meaningless), or (c) the
clipboard literally has no HTML.

For code blocks PM short-circuits *immediately* — line endings are normalized
to `\n` and a single text node is wrapped in a slice with both open depths set
to 0 (clipboard.ts:50–53). No HTML parser ever runs; pasting `<b>x</b>` into a
code block produces literal `<b>x</b>`. `transformPasted` still gets to see
the result.

For plain text outside a code block, PM falls through to a synthesized
`<div>` of `<p>` per line (clipboard.ts:60–65). Each `<p>` wraps a *text node
with the active marks at the cursor* — that's why pasting plain text into a
bold span keeps the bold (`schema.text(block, marks)`, clipboard.ts:64).

`clipboardTextParser` lets userland skip the synthesized-`<p>` step entirely.

#### 3.3.2 HTML branch (clipboard.ts:67–71)

```ts
view.someProp("transformPastedHTML", f => { html = f(html!, view) })
dom = readHTML(html!)
if (browser.webkit) restoreReplacedSpaces(dom)
```

`readHTML` (clipboard.ts:224–234) is *not* a trivial `innerHTML` set. It does
three things:

1. **Strip leading `<meta>` tags.** WebKit injects something like
   `<meta charset='utf-8'>` at the start of clipboard HTML; if you set
   `innerHTML` with that prefix you don't visually break, but the *structural*
   first child is now a `<meta>`, which messes up `data-pm-slice` lookup and
   the table-fixup logic. The regex `/^(\s*<meta [^>]*>)*/` removes all
   leading metas (clipboard.ts:225–226).

2. **Pre-wrap orphan table parts.** If the HTML's first tag is `<tr>`, `<td>`,
   `<tbody>`, etc. (anything in `wrapMap`), `innerHTML` will silently *drop*
   those children — browsers refuse to construct an orphan `<td>`. PM wraps
   the HTML in the exact missing ancestors before parsing, then drills back
   down (`querySelector(wrap[i])`) to return the now-correctly-nested element
   (clipboard.ts:228–233).

3. **Trusted Types.** With Chrome's `require-trusted-types-for` CSP active,
   even `innerHTML` on a *detached* document is blocked unless the value is a
   `TrustedHTML`. PM lazily creates a default policy
   (`ProseMirrorClipboard`) that's an identity function, just to satisfy the
   API (`maybeWrapTrusted`, clipboard.ts:213–222). Important: if a default
   policy already exists, PM reuses it (`trustedTypes.defaultPolicy ||
   createPolicy(...)`).

The whole parse happens in a *detached* `HTMLDocument` (clipboard.ts:206–209,
shared singleton `_detachedDoc`) so scripts in the pasted HTML don't run and
the live document's DOM observers don't see mutations.

`restoreReplacedSpaces` (clipboard.ts:241–248) is a WebKit fix-up: when
WebKit puts content on the clipboard, runs of regular spaces become
non-breaking spaces wrapped in plain `<span>` (Chrome) or
`<span class="Apple-converted-space">` (Safari). PM finds them and replaces
each `\u00a0`-only span with a real space. Without this, copy-paste from PM
to PM through the OS clipboard would mutate every consecutive whitespace.

#### 3.3.3 Detecting an internal-PM source (clipboard.ts:73–80)

```ts
let contextNode = dom && dom.querySelector("[data-pm-slice]")
let sliceData = contextNode &&
   /^(\d+) (\d+)(?: -(\d+))? (.*)/.exec(contextNode.getAttribute("data-pm-slice") || "")
if (sliceData && sliceData[3]) for (let i = +sliceData[3]; i > 0; i--) {
  let child = dom!.firstChild
  while (child && child.nodeType != 1) child = child.nextSibling
  if (!child) break
  dom = child as HTMLElement
}
```

The regex's three captures map exactly to the format written in step 2.5:
`openStart`, `openEnd`, optional wrapper count `-N`, and a JSON context. If
`-N` is present, PM walks `N` levels down the *element-only* first-child chain
to undo the synthetic table wrapping. This means after this step, `dom` points
at the same node that originally got the `data-pm-slice` stamp.

#### 3.3.4 Parsing (clipboard.ts:82–93)

```ts
let parser = view.someProp("clipboardParser") ||
             view.someProp("domParser") ||
             DOMParser.fromSchema(view.state.schema)
slice = parser.parseSlice(dom!, {
  preserveWhitespace: !!(asText || sliceData),
  context: $context,
  ruleFromNode(dom) {
    if (dom.nodeName == "BR" && !dom.nextSibling &&
        dom.parentNode && !inlineParents.test(dom.parentNode.nodeName))
      return {ignore: true}
    return null
  }
})
```

Three things to note about the parse options:

- **`preserveWhitespace`** is on whenever (a) we entered via the text branch
  (synthesized `<p>` already has exact spacing), or (b) we know this is PM's
  own content (`sliceData` present). For foreign HTML it's *off*, which
  invokes the parser's normal whitespace collapse (DOMParser does
  `text.replace(/[\s]+/g, " ")` etc, see from_dom.ts whitespace handling).
- **`context: $context`** — this is the resolved position at the *paste
  target*. The parser uses it for `ParseRule.context` matching, so e.g. a
  rule that says "this `<li>` is only valid inside a list" can fire correctly.
- **`ruleFromNode`** kills a trailing `<BR>` whose parent is a block-level
  element (i.e. *not* in `inlineParents` — the regex on clipboard.ts:112
  enumerates phrasing-content tags). Many editors (and contenteditable) emit
  a sentinel `<br>` at the end of a block to make it visible; we don't want
  that to become a real hard break in the model.

`parseSlice` itself (from_dom.ts:233–237) is just `parse` with `isOpen=true`,
finishing with `Slice.maxOpen(fragment)` to compute open depths from the
schema.

#### 3.3.5 Internal vs external normalization (clipboard.ts:94–106)

```ts
if (sliceData) {
  slice = addContext(closeSlice(slice, +sliceData[1], +sliceData[2]), sliceData[4])
} else {
  slice = Slice.maxOpen(normalizeSiblings(slice.content, $context), true)
  if (slice.openStart || slice.openEnd) {
    let openStart = 0, openEnd = 0
    for (let node = slice.content.firstChild;
         openStart < slice.openStart && !node!.type.spec.isolating;
         openStart++, node = node!.firstChild) {}
    for (let node = slice.content.lastChild;
         openEnd < slice.openEnd && !node!.type.spec.isolating;
         openEnd++, node = node!.lastChild) {}
    slice = closeSlice(slice, openStart, openEnd)
  }
}
```

**Internal branch** (sliceData present):

- `closeSlice(slice, openStart, openEnd)` (clipboard.ts:183–189) coerces the
  slice's open depths *down* to the values written on the clipboard, by
  filling in any required content with `ContentMatch.fillBefore` so the
  resulting slice is structurally legal.

  `closeRange` (clipboard.ts:173–181) does the recursive work: at each level
  it descends into the first or last child (depending on side), and once it
  reaches the target depth it prepends/appends the necessary fill content so
  the truncated subtree still satisfies its parent's content expression.
- `addContext(slice, ctxJSON)` (clipboard.ts:250–263) re-wraps the slice in
  the node types that were flattened away during copy step 2:

  ```ts
  for (let i = array.length - 2; i >= 0; i -= 2) {
    let type = schema.nodes[array[i]]
    if (!type || type.hasRequiredAttrs()) break
    content = Fragment.from(type.create(array[i + 1], content))
    openStart++; openEnd++
  }
  ```

  Each replayed wrapper *increments* the open depth, restoring the slice to
  its original "this came from inside a blockquote inside an item" shape.
  The loop stops at any wrapper type that has required attrs that weren't
  recorded — graceful degradation.

**External branch** (no sliceData):

- `normalizeSiblings(content, $context)` (clipboard.ts:122–145): foreign HTML
  often produces top-level fragments that can't *all* be siblings under any
  single parent in the schema. e.g. pasting "a paragraph followed by a list
  item". PM walks up the context's depths trying each ancestor's
  `ContentMatch`; for each top-level fragment node it computes a *wrapping*
  via `match.findWrapping(node.type)`. Adjacent nodes that share a wrapping
  prefix are merged into the same wrapper (`addToSibling`, clipboard.ts:155–
  164), so `[para, li, li]` under a context that allows `<ul>` becomes
  `[para, ul[li, li]]` rather than `[para, ul[li], ul[li]]`. If at some
  depth the wrapping search fails (`return result = null`), PM tries the
  next-shallower depth.
- After normalization, `Slice.maxOpen(fragment, openIsolating=true)` recomputes
  open depths.
- The follow-up loop walks the slice's first and last edges, only counting
  open depth across nodes that aren't `isolating`. Anything past an isolating
  boundary is forced closed via `closeSlice`. This stops a paste from leaking
  *into* a node like a table cell or a figure — both `isolating`.

### 3.3.6 The final hook

```ts
view.someProp("transformPasted", f => { slice = f(slice!, view, asText) })
return slice
```

Plugins get the schema-fitted slice with a flag telling them whether this was
a plain-text paste. Common uses: link autodetection, mention autocomplete,
sanitization that depends on the schema view of the content (rather than the
raw HTML view, which `transformPastedHTML` already saw).

### 3.4 `tr.replaceSelection` and `clearIncompatible`

The slice ends up in the document via `tr.replaceSelection(slice)` (or
`replaceSelectionWith` for a single-node slice). That goes through
`Selection.replace` (state/transaction.ts:141–144), which itself calls into
`prosemirror-transform`'s `replace`/`replaceRange`.

The schema-foreign-mark cleanup happens in `clearIncompatible`
(prosemirror-transform/src/mark.ts:75 and structure.ts:133, 290). The transform
machinery, as part of `replaceRangeWith` and friends, calls `clearIncompatible`
on the destination range to drop marks the parent's `markSet` doesn't allow,
and to convert any text characters disallowed by the new parent (e.g.
newlines into a non-`code` block when joining content). This is *not*
clipboard-specific — it's how every `replaceRange` keeps the document legal —
but it's the reason a paste of `<strong>` content into a parent that disallows
the `strong` mark won't blow up: the mark just disappears.

---

## 4. Drag-and-drop reuse

The same serializer/parser is used for D&D. There is no second pipeline.

### 4.1 `dragstart` (input.ts:680–708)

```ts
let draggedSlice = (node || view.state.selection).content()
let {dom, text, slice} = serializeForClipboard(view, draggedSlice)
if (!event.dataTransfer.files.length || !browser.chrome || browser.chrome_version > 120)
  event.dataTransfer.clearData()
event.dataTransfer.setData(brokenClipboardAPI ? "Text" : "text/html", dom.innerHTML)
event.dataTransfer.effectAllowed = "copyMove"
if (!brokenClipboardAPI) event.dataTransfer.setData("text/plain", text)
view.dragging = new Dragging(slice, dragMoves(view, event), node)
```

Highlights:

- The dragged source can be (in priority order): a draggable node-selection
  resolved from the mousedown target, the *current* selection, or a `desc`
  whose node spec has `draggable: true` (input.ts:686–697).
- `event.dataTransfer.clearData()` is suppressed on Chrome ≤ 120 *if files
  are present* — clearing wipes the files too on those versions
  (PM issue #1472, input.ts:700–701).
- `effectAllowed = "copyMove"` (input.ts:705) is a workaround for a Firefox
  case where the default of `none` blocks the drag entirely.
- `view.dragging` retains the original `Slice` object — internal drops take
  this path and never re-parse HTML. Cross-window / cross-tab drops *do*
  re-parse via `parseFromClipboard`.

### 4.2 `drop` (input.ts:719–778)

```ts
let slice = dragging && dragging.slice
if (slice) {
  view.someProp("transformPasted", f => { slice = f(slice!, view, false) })
} else {
  slice = parseFromClipboard(view, getText(event.dataTransfer),
                             brokenClipboardAPI ? null : event.dataTransfer.getData("text/html"),
                             false, $mouse)
}
```

When `view.dragging` survives (same-window drag), `transformPasted` is
called with `plain=false` so plugins can run. Otherwise `parseFromClipboard`
runs with `plainText=false` — there's no Shift+drop convention.

Drop point selection uses `dropPoint(doc, $mouse.pos, slice)` from
`prosemirror-transform` (input.ts:748), which finds the closest valid
insertion position — important when dropping near a node boundary or into a
block that doesn't accept the slice's content.

If the drag was a *move* (not a copy), the source selection is deleted
*before* the insert (input.ts:751–756). Because deletion shifts positions,
the insert pos is mapped through the transaction's mapping
(input.ts:758: `tr.mapping.map(insertPos)`).

Single-node drops set a `NodeSelection` on the freshly inserted node when the
node is selectable and the post-insert position has the matching markup
(input.ts:768–771); otherwise, a regular text selection is built across the
inserted range using `selectionBetween`.

`dragend` (input.ts:710–715) clears `view.dragging` after a 50ms delay, so a
`dragend` racing with `drop` doesn't accidentally null out the slice the drop
handler is about to consume.

---

## 5. DataTransfer / files / images

ProseMirror core does not touch files. The full file/image strategy is:

1. The user implements `handlePaste(view, event, slice)`. They check
   `event.clipboardData!.files`, do their async upload, and `return true` to
   suppress default insertion.
2. If they return falsy, the parsed `slice` (from HTML or text) is inserted.
   For Safari's behavior of providing both `text/html` *and* `Files` for an
   image copy, this means the parsed HTML wins by default — so handlers must
   pre-empt to insert an upload placeholder.

The MIME ordering issue on Safari: copying an image in Safari produces
`Files`, `text/html` (a `<img>` with a synthesized URL), *and* in some cases
`text/plain` containing the alt text. PM will happily parse the `<img>` if a
schema rule for `<img>` exists, ignoring the file. Userland must handle
files first.

`text/uri-list` (input.ts:650–651) is the only "alternative MIME" PM treats
specially in the pure-text path, and only as a fallback when `text/plain` is
empty (typical for browser address-bar drags).

---

## 6. Internal vs external paste detection

Detection is a single line:

```ts
let contextNode = dom && dom.querySelector("[data-pm-slice]")
```

(clipboard.ts:73). The implications:

- "Internal" doesn't mean "same editor instance". *Any* PM with the same
  schema (or a compatible enough schema) will round-trip through this path.
  Two different PM editors on the same page, or two browser tabs, count as
  internal to each other.
- The query doesn't restrict to *direct* children, so a foreign page that
  embedded PM's HTML inside its own decoration would also be treated as
  internal — a small risk surface but not a security hole because
  `addContext` uses `JSON.parse` with a try/catch (clipboard.ts:253–254) and
  bails out cleanly on garbage.
- The `data-pm-slice` attribute itself is *not* removed during parse. If a
  parse rule preserves attributes, it could leak into the document. PM's
  default node and mark rules don't preserve unknown HTML attributes, so this
  isn't an issue in practice.

External cleanup of weird HTML (Word's `<o:p>`, Google Docs' `<b id="docs-internal-…">`,
etc.) is intentionally *not* done in core. The advice is to hook
`transformPastedHTML` (string-level scrub) or `clipboardParser` (custom
DOMParser with rules that match those quirks). A common third-party setup
adds a parse rule for `b[style*="font-weight: normal"]` to undo Google Docs'
trick of wrapping its entire copy in a normal-weighted `<b>`.

---

## 7. Browser quirks summary

| Quirk | Where | Code |
|---|---|---|
| IE/Edge clipboard API is a lie | `brokenClipboardAPI` | input.ts:592–593 |
| iOS Safari < 604 same | `brokenClipboardAPI` | input.ts:592–593 |
| Pre-Chrome 120 `clearData()` wipes files | dragstart | input.ts:700–701 |
| WebKit injects leading `<meta>` in HTML | `readHTML` regex strip | clipboard.ts:225–226 |
| WebKit replaces spaces with `\u00a0`-spans | `restoreReplacedSpaces` | clipboard.ts:241–248 |
| Trusted Types blocks `innerHTML` | `maybeWrapTrusted` | clipboard.ts:213–222 |
| Native paste during composition is broken (except Android) | paste handler bail-out | input.ts:660 |
| Firefox drop needs `effectAllowed=copyMove` | dragstart | input.ts:705 |
| IE selectionchange on `removeAllRanges` | `captureCopy` blurs first | input.ts:580 |
| `<table>`/`<tr>`/`<td>` can't be top-level via `innerHTML` | `wrapMap` | clipboard.ts:194–204, 228–233 |
| Trailing sentinel `<br>` from contenteditable | `ruleFromNode` in parseSlice | clipboard.ts:87–91 |
| Shift+Insert (keyCode 45) is OS paste, not "plain paste" | plain-mode detection | input.ts:625, 662 |

`prosemirror-view/src/domobserver.ts` does **not** contain any
clipboard-specific code; the observer is paused and resumed around DOM
mutations, but paste/copy go through their own DOM event handlers in
`input.ts` and the resulting transaction is dispatched through the normal
update path. The observer's only indirect role is in the
`captureCopy`/`capturePaste` synthetic-DOM flows: those briefly take
selection out of the editor, which the observer would otherwise interpret
as a user action. The 50ms `setTimeout` (input.ts:583, 626) is short enough
that there's no observable flicker but long enough for the browser's native
clipboard event to complete.

---

## 8. Edge cases

### 8.1 Paste at a node boundary

`parseFromClipboard` uses `$context = view.state.selection.$from` as the
parse context (input.ts:635). For non-text-cursor selections, this is the
"from" position. Then `tr.replaceSelection(slice)` actually inserts. The
slice's open depths drive whether content joins the surrounding nodes:

- Slice with `openStart=0, openEnd=0`: a fully-closed insertion. If at a node
  boundary, it goes *between* nodes.
- Slice with `openStart>0, openEnd>0`: edges merge into the node before/after
  the cursor (when the markup matches).

`replace`/`replaceRange` figure this out structurally; clipboard.ts only
ensures the slice is *coherent* before handing it off.

### 8.2 Paste into an atom

Atomic nodes (`spec.atom`) accept no children. Pasting into an atom-selecting
`NodeSelection` causes `replaceSelection` to *replace the atom* (because that
selection's range covers the atom). Pasting in a `TextSelection` whose parent
is atomic isn't possible because atoms aren't textblock parents.

### 8.3 Paste into a code block

Detected by `inCode = $context.parent.type.spec.code` (clipboard.ts:44).
Forces the text-only path even if HTML is present, normalizes line endings
(`\r\n?`, `\r` → `\n`), and constructs a flat 0/0 slice from a single text
node. `clearIncompatible` will additionally strip any disallowed marks (a
code block's `markSet` is usually empty), turning bold-paste-in-code into
plain text.

### 8.4 Partial HTML (missing wrappers)

For example a clipboard whose HTML is just `<li>foo</li><li>bar</li>` (no
`<ul>`). `readHTML` doesn't add a wrapper for `<li>` (it's not in `wrapMap`),
so `parseSlice` produces two top-level `list_item` nodes. `normalizeSiblings`
(clipboard.ts:122–145) walks ancestor depths in `$context` until it finds a
parent whose content match permits a `bullet_list` (or `ordered_list`)
wrapper, then groups both `list_item`s under one synthesized `bullet_list`.
If even that fails (no list type in schema), the fragment is returned
unchanged and `Slice.maxOpen` does its best.

For `<tr>` orphans the `wrapMap` *does* fire, the parser sees a real
`<tr>` inside `<table><tbody>`, and `data-pm-slice -N` (when present) tells
the paste side how many of those wrappers to peel back off.

### 8.5 Dropping a dragged node onto itself

`drop` calls `dropPoint` to find a valid position; `dropPoint` returns null
inside the dragged node's own range, falling through to `$mouse.pos`. If
that still resolves inside the source (e.g. mouse never moved out), `move`
deletes the source first, then `tr.mapping.map(insertPos)` either maps to a
sensible adjacent position or `tr.doc.eq(beforeInsert)` is true and the drop
silently aborts (input.ts:765).

---

## 9. The round-trip diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              COPY (PM source)                            │
│                                                                          │
│  Selection.content() ─► Slice {content, openStart=4, openEnd=4}          │
│           │                                                              │
│           ▼                                                              │
│  serializeForClipboard()                          clipboard.ts:5         │
│   1. transformCopied(slice)                       :6                     │
│   2. Flatten single-child wrappers                :8-15                  │
│        openStart 4 → 2                                                   │
│        context = ["blockquote", null, "list_item", null]   ◄─ saved     │
│   3. DOMSerializer.serializeFragment              :17-19                 │
│        → detached <div>…</div>                                           │
│   4. wrapMap fix-up if first child is <tr>/<td>/… :22-30                 │
│        wrappers = N (e.g. 2 for a <tr>)                                  │
│   5. Stamp first element with                     :32-34                 │
│        data-pm-slice = "2 2 -2 [\"blockquote\",null,\"list_item\",null]" │
│   6. text = textBetween("\n\n")                   :36-37                 │
│                                                                          │
│  ─── DataTransfer ───────────────────────────────────────────────        │
│   text/html  = wrap.innerHTML  (data-pm-slice carries metadata)          │
│   text/plain = text                                                      │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  ▼
                     ┌────────────────────────────┐
                     │   OS / external app /      │
                     │   another browser tab      │
                     │                            │
                     │   • HTML attributes are    │
                     │     preserved              │
                     │   • some text editors      │
                     │     drop the HTML; if so   │
                     │     paste falls back to    │
                     │     text/plain             │
                     └────────────┬───────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          PASTE (PM target)                               │
│                                                                          │
│  paste handler                                    input.ts:654-667       │
│   plain = shiftKey && lastKeyCode != 45  (Insert) :662                   │
│   doPaste(view, text, html, plain, event)                                │
│           │                                                              │
│           ▼                                                              │
│  parseFromClipboard()                             clipboard.ts:43        │
│   inCode? plain? html missing?                                           │
│      └─► text-only branches                       :47-66                 │
│   else (HTML branch):                                                    │
│     transformPastedHTML(html)                     :68                    │
│     readHTML(html):                               :224-234               │
│       strip leading <meta>                                               │
│       wrapMap pre-wrap if <tr>/<td>/… orphan                             │
│       innerHTML via Trusted Types                                        │
│     restoreReplacedSpaces() on WebKit             :70                    │
│                                                                          │
│   ┌─────────────────────────── PM-source detection ───────────────┐      │
│   │ contextNode = querySelector("[data-pm-slice]")     :73         │      │
│   │ parse "2 2 -2 [...]"                               :74         │      │
│   │ peel N wrapMap layers (-N)                         :75-80      │      │
│   └──────────────────────────────┬──────────────────────────────────┘      │
│                                  │                                       │
│                                  ▼                                       │
│   parser.parseSlice(dom, {preserveWhitespace, context, ruleFromNode})    │
│                                  :82-93                                  │
│           │                                                              │
│           ▼                                                              │
│   ┌── data-pm-slice present? ─────────────────────────────────┐          │
│   │  YES (internal):                                          │          │
│   │     closeSlice(slice, 2, 2)        :95   ◄── exact open   │          │
│   │     addContext(slice, ctxJSON)     :95   ◄── replay wraps │          │
│   │       → re-wrap in blockquote/list_item, openStart 2 → 4  │          │
│   │     RESULT identical-shape Slice; replaceSelection() lands │          │
│   │     it in a structurally equivalent location.             │          │
│   │                                                           │          │
│   │  NO (external):                                           │          │
│   │     normalizeSiblings(content, $context)   :97            │          │
│   │       → group orphan top-level into the schema's wrapper  │          │
│   │     Slice.maxOpen(...)                                    │          │
│   │     walk to first non-isolating, closeSlice               :98-105     │
│   └──────────────────────────────┬────────────────────────────┘          │
│                                  ▼                                       │
│   transformPasted(slice, view, asText)            :108                   │
│           │                                                              │
│           ▼                                                              │
│  handlePaste hook?                                input.ts:636           │
│  tr.replaceSelection(slice)                       input.ts:642           │
│        └─► clearIncompatible drops foreign marks (transform/mark.ts:75)  │
│  dispatch(tr.setMeta("paste", true))              input.ts:643           │
└──────────────────────────────────────────────────────────────────────────┘
```

The persistence of structural context across the external trip is exactly the
pair `(data-pm-slice attribute, addContext + closeSlice on parse)`. Strip the
attribute and PM degrades gracefully into the external-source path:
`normalizeSiblings` rebuilds something insertable, `Slice.maxOpen` re-derives
open depths from the schema, and `clearIncompatible` discards any marks the
target parent doesn't allow. Keep the attribute and the round-trip is exact
up to the schema's tolerance for the recorded context types — including
whether the original wrappers exist in this schema and whether their attrs
are JSON-compatible.

---

## 10. Quick reference — file:line index

- `prosemirror-view/src/clipboard.ts:5` — `serializeForClipboard`.
- `prosemirror-view/src/clipboard.ts:8-15` — open-depth flatten + context.
- `prosemirror-view/src/clipboard.ts:17` — `clipboardSerializer` resolution.
- `prosemirror-view/src/clipboard.ts:22-30` — table-element wrap fix-up.
- `prosemirror-view/src/clipboard.ts:32-34` — `data-pm-slice` stamp.
- `prosemirror-view/src/clipboard.ts:36-37` — `clipboardTextSerializer` /
  `textBetween` fallback.
- `prosemirror-view/src/clipboard.ts:43` — `parseFromClipboard`.
- `prosemirror-view/src/clipboard.ts:50-53` — code-block short-circuit.
- `prosemirror-view/src/clipboard.ts:60-65` — synthesized `<p>` plain-text.
- `prosemirror-view/src/clipboard.ts:73-80` — internal-PM detection /
  unwrap N.
- `prosemirror-view/src/clipboard.ts:82-93` — `parseSlice` with options.
- `prosemirror-view/src/clipboard.ts:94-106` — internal vs external fit-up.
- `prosemirror-view/src/clipboard.ts:122-145` — `normalizeSiblings`.
- `prosemirror-view/src/clipboard.ts:173-189` — `closeRange`/`closeSlice`.
- `prosemirror-view/src/clipboard.ts:194-204` — `wrapMap` jQuery table table.
- `prosemirror-view/src/clipboard.ts:213-222` — Trusted Types policy.
- `prosemirror-view/src/clipboard.ts:224-234` — `readHTML`.
- `prosemirror-view/src/clipboard.ts:241-248` — WebKit space restore.
- `prosemirror-view/src/clipboard.ts:250-263` — `addContext`.
- `prosemirror-view/src/input.ts:568-587` — `captureCopy` (broken-API path).
- `prosemirror-view/src/input.ts:592-593` — `brokenClipboardAPI`.
- `prosemirror-view/src/input.ts:595-612` — copy/cut handler.
- `prosemirror-view/src/input.ts:618-632` — `capturePaste`.
- `prosemirror-view/src/input.ts:634-645` — `doPaste`.
- `prosemirror-view/src/input.ts:647-652` — `getText` (with `text/uri-list`).
- `prosemirror-view/src/input.ts:654-667` — paste handler.
- `prosemirror-view/src/input.ts:669-678` — `Dragging` / `dragMoves`.
- `prosemirror-view/src/input.ts:680-708` — `dragstart`.
- `prosemirror-view/src/input.ts:710-715` — `dragend` deferred clear.
- `prosemirror-view/src/input.ts:719-778` — `drop` / `handleDrop`.
- `prosemirror-view/src/index.ts:23` — `__parseFromClipboard` test export.
- `prosemirror-view/src/index.ts:660-772` — clipboard-related EditorProps.
- `prosemirror-view/src/browser.ts:1-24` — UA flags consumed above.
- `prosemirror-state/src/transaction.ts:141-155` —
  `replaceSelection`/`replaceSelectionWith`.
- `prosemirror-model/src/from_dom.ts:233-237` — `parseSlice`.
- `prosemirror-model/src/replace.ts:90` — `Slice.maxOpen`.
- `prosemirror-transform/src/mark.ts:75` and `structure.ts:133, 290` —
  `clearIncompatible` (foreign mark cleanup invoked from
  `replaceRange`/`replaceRangeWith`).
