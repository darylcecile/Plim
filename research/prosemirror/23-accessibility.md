# 23 — Accessibility

ProseMirror is **not** an accessible editor out of the box. It is a
correctness-engine for `contenteditable`, and it deliberately stops at
the point where the browser exposes the editing surface to assistive
technology (AT). Everything above that — roles, labels, focus
management for non-text regions, screen-reader announcements, live
regions — is the **consumer's responsibility**.

This file is the master reference for "what does PM give me, what do I
have to add, and what do I have to fight against?" when building an
accessible editor on top of `prosemirror-view`.

References use `file:line` against `/tmp/pm-source/prosemirror-view/src/`
unless otherwise noted.

---

## 1. PM's stance: contenteditable is the contract

PM does exactly **two** things to mark the editor as editable to the OS:

1. It sets `contenteditable="true"` on the outer DOM node
   (`index.ts:519` — `attrs.contenteditable = String(view.editable)`).
2. It exposes an `editable` prop so consumers can flip the surface
   between RW and RO (`index.ts:780` — `editable?: (this, state) => boolean`,
   resolved by `getEditable` at `index.ts:551`).

That's it. PM does **not** set:

- `role="textbox"`
- `aria-multiline`
- `aria-readonly`
- `aria-label` / `aria-labelledby`
- `aria-describedby`
- `aria-invalid`
- `tabindex` (it inherits the contenteditable default of `0`)

The reasoning is structural: PM ships `attributes` as a prop
(`index.ts:782` — "Control the DOM attributes of the editable element")
so the consumer can layer ARIA without forking the view. Look at how
`computeDocDeco` merges them:

```ts
// index.ts:516-535
function computeDocDeco(view: EditorView) {
  let attrs = Object.create(null)
  attrs.class = "ProseMirror"
  attrs.contenteditable = String(view.editable)

  view.someProp("attributes", value => {
    if (typeof value == "function") value = value(view.state)
    if (value) for (let attr in value) {
      if (attr == "class")
        attrs.class += " " + value[attr]
      else if (attr == "style")
        attrs.style = (attrs.style ? attrs.style + ";" : "") + value[attr]
      else if (!attrs[attr] && attr != "contenteditable" && attr != "nodeName")
        attrs[attr] = String(value[attr])
    }
  })
  if (!attrs.translate) attrs.translate = "no"
  return [Decoration.node(0, view.state.doc.content.size, attrs)]
}
```

Two important details:

- **`attributes` cannot override `contenteditable`** (`index.ts:528`
  explicit blacklist). That's a security rail — flipping
  `contenteditable` mid-state would desync the DOM observer.
- **`translate="no"` is auto-set** unless the consumer overrides it.
  This is the *only* a11y-adjacent attribute PM volunteers, and it's a
  Chrome-translation guard, not a SR feature.

### 1.1 Consumer responsibility — minimal viable a11y

```ts
new EditorView(target, {
  state,
  attributes: state => ({
    role: "textbox",
    "aria-multiline": "true",
    "aria-readonly": state.doc.attrs?.readonly ? "true" : "false",
    "aria-label": "Document body",
    // optional — pair with a visible label/heading
    "aria-labelledby": "doc-title",
    // for inline error/hint reasons
    "aria-describedby": state.doc.attrs?.errors ? "doc-errors" : undefined,
  }),
})
```

This is the **floor**. Without `role="textbox"` NVDA falls back to
"editable region" announcements (works in modern NVDA but lacks
semantics) and JAWS treats it as a generic edit field; with it, both
read content character-by-character in browse mode and switch to
forms/focus mode reliably.

### 1.2 Read-only states

PM toggles `contenteditable="false"` on the doc node when `editable`
returns false (`index.ts:519, 551, 174` re-runs in `update`). But:

- A `contenteditable="false"` element is *not* automatically
  `aria-readonly`. SRs may stop announcing it as a textbox at all.
- Best practice: keep `role="textbox"` *and* set `aria-readonly="true"`
  rather than relying on contenteditable=false alone. AT then knows
  it's "the same field, currently locked".
- For document-attribute-based readonly toggling, drive both via the
  `attributes` prop reading the same state slice that drives `editable`.

---

## 2. ARIA on the editor host: the full menu

### 2.1 `role`

`role="textbox"` is the canonical choice. Alternatives:

- `role="document"` — when the editor is more of a viewer with
  occasional edits (rare; AT reads in *browse* mode).
- `role="application"` — *avoid*. It tells SRs "I handle every
  keypress", which forces users into focus mode and breaks browse-mode
  navigation. PM's keymap does not handle every key (Tab, F6, etc.
  pass through), so `application` is wrong.

### 2.2 `aria-multiline`

Set `"true"` for paragraph-style editors (almost always) and `"false"`
for single-line inputs. SRs use this to decide whether Enter inserts a
newline or submits.

### 2.3 `aria-readonly`

Mirror the `editable` prop. Don't conflate with `aria-disabled` —
disabled implies "not interactive at all", whereas the editor still
takes focus and supports caret navigation when read-only.

### 2.4 `aria-label` / `aria-labelledby`

`aria-labelledby` wins when there is a visible heading. Use
`aria-label` only when no visible label exists. Both are mutually
exclusive in practice — providing both confuses screen readers
(labelledby is preferred and label is ignored).

```html
<h2 id="doc-title">Meeting notes</h2>
<div class="ProseMirror" contenteditable="true"
     role="textbox" aria-multiline="true"
     aria-labelledby="doc-title">…</div>
```

### 2.5 `aria-describedby`

Point at a non-focusable element containing format/help text. Useful
for "Markdown shortcuts available" hints, validation errors, character
counts. Multiple IDs are space-separated.

### 2.6 `aria-invalid`, `aria-required`

Toggle from a plugin that runs validation on `state` changes. PM's
plugin → state cycle gives you the perfect hook: subscribe to
`appendTransaction` or `view.update`, recompute validity, push it via
the `attributes` prop.

### 2.7 `aria-activedescendant` for autocomplete popups

When the editor opens a suggestion menu (slash commands, mentions),
keep DOM focus on the editor and use `aria-activedescendant` to point
at the highlighted menu item. **Do not** move DOM focus into the menu
— that destroys the caret state and PM has to re-derive selection
from scratch when focus returns. Pattern:

```ts
attributes: state => ({
  role: "textbox",
  "aria-haspopup": menuOpen ? "listbox" : undefined,
  "aria-expanded": menuOpen ? "true" : "false",
  "aria-activedescendant": menuOpen ? `mention-opt-${idx}` : undefined,
  "aria-controls": menuOpen ? "mention-listbox" : undefined,
}),
```

This is **userland** — PM does nothing here.

---

## 3. Widget decorations and ARIA

Widget decorations [10 §3](./10-decorations.md) render real DOM into
the contenteditable. Because they're real DOM, all ARIA attributes
work, but you have to set them yourself.

```ts
const placeholder = Decoration.widget(pos, () => {
  const span = document.createElement("span")
  span.className = "placeholder"
  span.textContent = "Type / to insert…"
  // critical:
  span.setAttribute("aria-hidden", "true")  // don't speak placeholders
  span.contentEditable = "false"            // PM also forces this for non-editable widgets
  return span
}, { side: -1, marks: [] })
```

### 3.1 `aria-hidden` is the default for visual-only decorations

Anything that exists purely to *show* (cursor wrappers, drop indicators,
lint underlines, presence avatars) should be `aria-hidden="true"`.
Otherwise SRs will speak the decoration text every time the user
arrow-keys past it.

PM itself does this for the **mark cursor wrapper** at
`index.ts:540-544`:

```ts
let dom = document.createElement("img")
dom.className = "ProseMirror-separator"
dom.setAttribute("mark-placeholder", "true")
dom.setAttribute("alt", "")  // alt="" — SRs ignore the IMG entirely
```

`alt=""` on an `<img>` is the historical equivalent of `aria-hidden`;
both work but `aria-hidden` is more general.

### 3.2 Announcing decoration content

If the decoration *carries information* (e.g., a comment marker, a
presence cursor with a name), choose between:

- **Visible text + aria-hidden + alt label**: SR reads alt only.
- **`role="img"` + `aria-label`**: SR speaks the label.
- **`role="note"`**: SR may include in browse mode.
- **Nothing visible, only an aria-live region elsewhere**: best for
  transient announcements (peer joined, peer typing).

Decisions to make per decoration:

| Decoration kind        | Recommended ARIA                              |
| ---------------------- | --------------------------------------------- |
| Cursor / drop marker   | `aria-hidden="true"`                          |
| Spell underline        | `aria-hidden="true"` (errors announced via aria-invalid on the editor) |
| Comment thread anchor  | `role="button"` + `aria-label="Comment by …"` + `tabindex="-1"` |
| Mention chip           | NodeView (see §4) — not a widget              |
| Presence cursor        | `aria-hidden="true"` + live-region text       |
| Inline placeholder     | `aria-hidden="true"`                          |

### 3.3 Inline-content decorations on text

`Decoration.inline()` adds attributes to spans wrapping text. SRs read
the wrapped text either way, so this is mostly for visual styling. If
you add `aria-label` to the span, *Some* SRs will substitute it for the
text content — usually **not** what you want.

### 3.4 The cursor wrapper IMG — odd but correct

PM injects a 0-width `<img>` to anchor stored marks
([10 §6](./10-decorations.md), `index.ts:540-548`). The `alt=""`
keeps it silent. NVDA in browse mode sometimes still announces
"graphic" — add `role="presentation"` if that occurs in your support
matrix:

```ts
// userland override via a custom cursorWrapper
dom.setAttribute("role", "presentation")
```

---

## 4. NodeViews and atom nodes

Atom nodes (`atom: true` in NodeSpec — see [02 §2.2](./02-document-model.md))
are leaf-like blocks that the user cannot edit *into*. Examples: image,
mention chip, math block, embedded iframe, video.

PM forces them to be `contenteditable="false"` if no contentDOM exists
(`viewdesc.ts:708-709`):

```ts
if (!contentDOM && !node.isText && dom.nodeName != "BR") {
  // Chrome gets confused by <br contenteditable=false>
  if (!(dom as HTMLElement).hasAttribute("contenteditable"))
    (dom as HTMLElement).contentEditable = "false"
}
```

That solves caret containment, **not accessibility**. To make atom
NodeViews accessible, the consumer must add:

- **`role`** — `img`, `button`, `link`, `figure`, etc. depending on
  semantic.
- **`aria-label`** — the alt text equivalent. For mentions:
  `aria-label="Mention: Alice"`. For an image: `aria-label="Photo of …"`
  or `alt="…"` if it's an `<img>`.
- **`tabindex`** — see §4.1.
- **Keyboard activation handlers** if the atom is interactive
  (Enter/Space → open lightbox, edit metadata, follow link).

### 4.1 Tabindex policy for non-editable atoms

The hard rule: **do not put `tabindex="0"` inside the contenteditable
unless you mean it**.

Reasoning:

- The contenteditable host already takes focus once, with caret. A
  tabindex=0 child means Tab moves focus **into** the atom, away from
  the caret. PM has no idea, the caret state goes stale, and on
  blur-back the selection is re-derived but probably wrong.
- Browser-default behavior for tabindex=0 inside contenteditable
  varies (Firefox vs Chromium handle drag and focus differently,
  see [18 §2.2](./18-cross-browser-quirks.md)).

The recommended policy:

| Atom nature                | tabindex | role          | Notes |
| -------------------------- | -------- | ------------- | ----- |
| Decorative image           | (none)   | `presentation`/`img` + `alt=""` | Caret moves over it via NodeSelection. |
| Static mention chip        | `-1`     | `link` or `button` | Reachable programmatically; Tab skips it. |
| Interactive widget (poll, code-runner, math editor) | `-1` | `application` *(carefully)* | Activate via Enter from caret; once activated, manage focus internally and provide Escape to return. |
| Standalone embed (iframe)  | `0`      | `iframe`'s own | Tab into it deliberately; embed must implement F6/Escape to leave. |

PM's NodeSelection (`prosemirror-state/src/selection.ts` —
`NodeSelection.create`) is the keyboard primitive: when caret enters
an atom from either side, PM creates a NodeSelection covering the
node. AT typically announces "selected: {nodeName}", but **only if
the wrapping element has appropriate role/label**. Otherwise it's
silent.

### 4.2 Focus management for interactive atoms

The flow when Enter "activates" an interactive atom:

```
caret-in-doc → NodeSelection on atom → [user presses Enter]
          ↓
plugin handles Enter, calls atom.focus()  (DOM focus moves into atom subtree)
          ↓
[user edits inside]  — atom owns focus, manages own keyboard
          ↓
[user presses Escape] → atom calls view.focus(), restores selection
```

The atom is responsible for:

1. Saving the prior selection before stealing focus.
2. Trapping focus inside (focus-trap pattern — first/last tabbable
   roundtrip).
3. Restoring DOM focus to `view.dom` and dispatching a transaction to
   place caret back at the atom's position.

PM exposes `view.focus()` for step 3 (`index.ts:339`):

```ts
focus() {
  this.domObserver.stop()
  if (this.editable) focusPreventScroll(this.dom)
  selectionToDOM(this)
  this.domObserver.start()
}
```

Note `focusPreventScroll` is a polyfilled `focus({preventScroll: true})`
to avoid the page jumping when AT routes focus. Consumers should match
this when delegating focus into atoms.

### 4.3 NodeView ARIA in practice (image example)

```ts
class ImageNodeView implements NodeView {
  dom: HTMLElement
  constructor(node: Node) {
    const fig = document.createElement("figure")
    fig.setAttribute("role", "img")
    fig.setAttribute("aria-label", node.attrs.alt || "Image")
    fig.tabIndex = -1
    fig.contentEditable = "false"

    const img = document.createElement("img")
    img.src = node.attrs.src
    img.alt = node.attrs.alt || ""    // empty alt because aria-label is on figure
    fig.appendChild(img)

    if (node.attrs.caption) {
      const cap = document.createElement("figcaption")
      cap.textContent = node.attrs.caption
      fig.appendChild(cap)
    }
    this.dom = fig
  }
  // ignoreMutation: prevent PM treating internal mutations as edits
  ignoreMutation() { return true }
  stopEvent() { return false }  // let clicks reach PM for selection
}
```

### 4.4 Mention chips — anti-pattern catalog

A frequently broken pattern. Common bugs:

- **Missing `aria-label`**: SR reads the visible text only ("@alice"),
  swallowing the `@`. Better: `aria-label="Mention: alice"`.
- **`tabindex="0"`**: Tab traps user inside chips. Use `-1`.
- **Wrapping in `<button>`**: button receives clicks but PM's
  NodeSelection logic relies on event bubbling at specific phases
  ([13 §3](./13-input-pipeline.md)). Use `<span role="button">` and
  swallow only Enter/Space in `stopEvent`.
- **Forgetting `contentEditable="false"`**: caret can land *inside*
  the chip text, AT reads character-by-character. PM auto-sets this
  via `viewdesc.ts:709` only when there's no contentDOM; if you provide
  a wrapping element with children that aren't a contentDOM, set it
  yourself.

---

## 5. Live regions for collab presence

Collaborative cursors and presence updates must be announced **without
stealing focus or interrupting typing**. ARIA live regions are the
mechanism.

### 5.1 Anatomy of a presence live region

```html
<div id="pm-presence-live"
     aria-live="polite"
     aria-atomic="false"
     aria-relevant="additions text"
     class="visually-hidden">
</div>
```

- `aria-live="polite"` — announce when the SR is idle. Never use
  `assertive` for presence; it interrupts the user's own dictation.
- `aria-atomic="false"` — only newly added text is read.
- `aria-relevant="additions text"` — additions and text changes only
  (no removals).
- Visually hidden via the standard `clip:rect(0 0 0 0)` SR-only CSS,
  not `display:none` (which removes it from the AT tree entirely).

### 5.2 Throttling announcements

Collab can be chatty. Throttle to ~one announcement per 2-3 seconds
per peer to avoid SR queue overload:

```ts
const announceQueue = new Map<peerId, string>()
let flushTimer: number | null = null

function announce(peerId: string, text: string) {
  announceQueue.set(peerId, text)
  if (flushTimer != null) return
  flushTimer = window.setTimeout(() => {
    const live = document.getElementById("pm-presence-live")!
    for (const [, msg] of announceQueue) {
      const p = document.createElement("p")
      p.textContent = msg
      live.appendChild(p)
    }
    announceQueue.clear()
    flushTimer = null
    // GC: keep the last 5 announcements
    while (live.children.length > 5) live.removeChild(live.firstChild!)
  }, 2000)
}

// usage:
collab.on("peerJoined", p => announce(p.id, `${p.name} joined the document`))
collab.on("peerEdited", p => announce(p.id, `${p.name} is editing the heading`))
```

### 5.3 Don't announce caret position

Tempting: "Alice moved to line 5". Don't — it's noise. Announce
*entries*, *exits*, and *significant edits in summary form*.

### 5.4 Multiple polite regions for different categories

- `pm-presence-live` (peer events, polite).
- `pm-status-live` (autosave, "saved 3:42 PM", polite).
- `pm-error-live` (validation errors, assertive — but only when the
  user explicitly triggered an action, never on background sync).

---

## 6. High-contrast and forced-colors

Windows High Contrast Mode (WHCM) and the CSS `forced-colors` media
query strip authored colors and replace them with system colors. PM
itself uses no colors except the cursor wrapper IMG, which has no
visible rendering.

### 6.1 Decorations under forced-colors

Inline decorations relying purely on color (spelling underline,
highlight, presence color) **disappear** in forced-colors mode unless
they use:

- A `border` / `outline` / `text-decoration` rather than `background`.
- The `forced-color-adjust: none` opt-out (rarely justified).
- System-color values: `Highlight`, `HighlightText`, `Mark`, `MarkText`,
  `LinkText`, `VisitedText`, `ButtonFace`, etc.

Pattern:

```css
.pm-spell-error {
  text-decoration: underline wavy currentColor;
}
@media (forced-colors: active) {
  .pm-spell-error { text-decoration-color: Mark; }
}

.pm-comment-anchor {
  background: var(--comment-bg);
  outline: 1px solid transparent;  /* invisible normally; visible in WHCM */
}
@media (forced-colors: active) {
  .pm-comment-anchor { outline-color: LinkText; }
}
```

### 6.2 Presence cursors in WHCM

Different peers usually get different `--peer-color` CSS variables.
WHCM ignores them. Use shape/initial differentiation as a fallback:

```css
.pm-presence-cursor::after {
  content: attr(data-peer-initial);
  background: var(--peer-color);
}
@media (forced-colors: active) {
  .pm-presence-cursor::after {
    border: 1px solid CanvasText;
    background: Canvas;
  }
}
```

### 6.3 Selection visibility

PM uses the native selection (no custom selection rendering except
gap/cursor wrappers — [10 §5–6](./10-decorations.md)). Native
selection respects WHCM automatically. **Don't** override
`::selection` with hard-coded colors; the override survives WHCM and
hurts contrast.

---

## 7. Keyboard navigation for non-text users

Users who navigate purely by keyboard (motor impairment, SR users in
focus mode) need:

- Every interactive widget reachable.
- Atom selection to be obvious — a visible focus ring on the selected
  node.
- Escape to deselect / return to caret context.
- Arrow keys to walk through atoms predictably.

### 7.1 Gap cursor and arrow keys

The gap cursor (`prosemirror-gapcursor` plugin) lets users place the
caret in positions where a normal text cursor cannot exist — e.g.,
between two block-level atoms with no surrounding paragraph. See
[08 §11](./08-selection.md) for the model layer; the visible
manifestation is a thin blinking line styled by CSS.

For a11y this means:

- A non-text user can get the caret to **every** position with arrow
  keys alone. Without gap cursor, two adjacent images would make the
  position between them unreachable.
- Make the gap cursor **visible in WHCM** — it uses
  `border-left: 1px solid` by default, which survives forced-colors,
  but if you restyle, keep a system-color fallback.
- Some SRs announce "blank" at the gap cursor; that's correct — the
  position is content-less.

### 7.2 NodeSelection visual indicator

When PM creates a NodeSelection, it adds the
`ProseMirror-selectednode` class to the node DOM (`viewdesc.ts`,
`selectNode`/`deselectNode`). Style it for visibility:

```css
.ProseMirror-selectednode {
  outline: 2px solid Highlight;
  outline-offset: 2px;
}
@media (forced-colors: active) {
  .ProseMirror-selectednode { outline-color: Highlight; }
}
```

Without this, keyboard users have **no idea** an atom is selected.

### 7.3 Tabbable interactive controls outside the document

Toolbar buttons, the slash menu, the find bar — these go in roving
tabindex groups *outside* the contenteditable. Escape from menu →
focus returns to the editor at the previous selection. Standard
combobox / menu / toolbar ARIA patterns apply; PM adds nothing here
but also imposes nothing.

### 7.4 Cross-link

Detailed keyboard handling lives in [19 §3](./19-commands-keymap-inputrules.md);
arrow-key + selection movement lives in [08 §6–§9](./08-selection.md).
Vertical motion across atoms uses `selectVertically`
(`capturekeys.ts:247-264`); horizontal motion uses `selectHorizontally`
(`capturekeys.ts:19-58`).

---

## 8. Screen-reader announcements of edits

This is where PM's contenteditable-only stance hurts most.

### 8.1 What the browser tells the SR

When a user types a character, the browser fires text-edit events into
the OS accessibility tree (UIA on Windows, AX on macOS, AT-SPI on
Linux). The SR picks these up and speaks the inserted character.

PM **does not interfere** with this for typed input — it lets the
browser write the DOM, then the DOMObserver picks up the change and
re-syncs PM state ([15](./15-domobserver-and-domchange.md)). The OS
a11y tree sees the same DOM mutation and announces it.

### 8.2 What the browser does *not* tell the SR

- **Typing replaced by an input rule.** When `> ` becomes a blockquote,
  the user typed "> " but the SR sees the *result* — a blockquote
  appeared. Some SRs announce "blockquote, group, edit" on the next
  caret move; some say nothing.
- **Smart quotes / autoreplace.** Typed `"` becomes `“`. The SR
  usually says "left double quotation mark", which is correct but
  surprising.
- **Programmatic transactions** (e.g., a plugin inserting a mention
  chip when you type `@a`). The DOM mutates, but the *cause* is
  invisible. SRs announce based on focus + selection deltas; if PM
  preserves selection, AT may say nothing at all.

### 8.3 Announcing programmatic edits via live region

Pattern: when you dispatch a transaction the user didn't directly
cause, drop a message into a polite live region:

```ts
function dispatchWithAnnouncement(tr: Transaction, message: string) {
  view.dispatch(tr)
  announceStatus(message)  // writes into #pm-status-live
}

dispatchWithAnnouncement(
  state.tr.replaceSelectionWith(blockquote.create(null, paragraph.create())),
  "Converted to blockquote"
)
```

### 8.4 Virtual cursor implications

NVDA and VoiceOver have a *virtual cursor* (browse mode) that can roam
the page independently of the DOM caret. Inside `contenteditable`,
they switch to *focus mode* automatically (NVDA based on
`role="textbox"`; VoiceOver based on `contenteditable`).

What can go wrong:

- If the user **leaves focus mode** mid-edit (NVDA: Insert+Space),
  arrow keys move the virtual cursor only — PM never sees them,
  selection desyncs. There is no fix; documenting this in the
  app's a11y help is the workaround.
- Atom NodeViews with `contentEditable="false"` may **flip the SR back
  into browse mode** while the caret is over them, then back to focus
  mode when the caret leaves. The result is a verbose "out of edit
  field … in edit field" sequence. Mitigations:
  - Keep the atom container `contentEditable="false"` but its parent
    `contentEditable="true"` (PM does this automatically).
  - Use `aria-hidden="true"` on purely decorative widget content so
    the virtual cursor skips it.
  - Avoid focusable descendants inside atoms (see §4.1).

### 8.5 Composition and IME announcements

During IME composition ([14](./14-ime-composition.md)) the DOM has
*provisional* characters that PM ignores until `compositionend`. SRs
generally do the right thing — they wait for the final string. But:

- If your plugin renders a candidate-list popup *during* composition,
  use an `aria-live="polite"` region to announce the highlighted
  candidate (some IMEs announce themselves; some don't, on web pages).
- Don't `preventDefault` on composition events — PM doesn't, and
  doing so hides the IME from AT.

---

## 9. Interactions with the OS accessibility tree

Each platform exposes a different a11y API:

| OS         | API     | Notes |
| ---------- | ------- | ----- |
| Windows    | UIA / MSAA | UIA is the modern API; Chromium and Firefox both expose `contenteditable` as a `Document` + `Edit` pattern. |
| macOS / iOS| AX (NSAccessibility) | `AXTextArea` role for multiline contenteditable. VoiceOver respects `aria-label` for the role description. |
| Linux      | AT-SPI 2 | Less commonly the target for editor a11y work but supported by Orca. |
| Android    | TalkBack via AccessibilityNodeInfo | Web content goes through the WebView's a11y bridge — variable quality. |

### 9.1 What the browser maps from your DOM

- `role="textbox"` + `aria-multiline="true"` → `AXTextArea` / UIA Edit
  multiline.
- `contenteditable` alone → some platforms still expose as edit, but
  with default name = innerText (long; AT verbose).
- `aria-label` → `AXName` / UIA Name. **Always prefer aria-label over
  innerText** for the editor host so the SR doesn't read the entire
  doc as the field name.
- Inline elements with `role="img"` → `AXImage`.
- `aria-describedby` → `AXHelp` / UIA HelpText.

### 9.2 Text patterns

UIA exposes a `TextPattern` for edit fields, used by Narrator and
third-party SRs to do range-based reading and search. Browsers
implement this on top of the DOM tree; PM doesn't have to do anything,
but custom NodeViews that synthesize content via canvas / shadow DOM
**break** the TextPattern.

Rule: if you build a NodeView whose visible text isn't in light DOM,
add a fallback:

```ts
class MathNodeView {
  dom: HTMLElement
  constructor(node: Node) {
    this.dom = document.createElement("span")
    this.dom.setAttribute("role", "img")
    this.dom.setAttribute("aria-label", `Equation: ${node.attrs.tex}`)
    // visible rendering via canvas (fast):
    const canvas = renderTexToCanvas(node.attrs.tex)
    this.dom.appendChild(canvas)
    // fallback text for the a11y tree:
    const sr = document.createElement("span")
    sr.className = "visually-hidden"
    sr.textContent = node.attrs.tex
    this.dom.appendChild(sr)
  }
}
```

### 9.3 Shadow DOM and a11y

Closed shadow DOM is *invisible* to AT. Open shadow DOM is exposed,
but `aria-*` attributes don't cross shadow boundaries (the
`ariaActiveDescendantElement` / `aria-*` IDREF cross-root work is
slowly landing — see whatwg/html#3917). For PM NodeViews, prefer
**light DOM**. Shadow DOM is rarely worth the a11y debt.

---

## 10. Test tooling and checklists

### 10.1 Automated

- **axe-core** (DevTools, CLI, CI). Catches missing roles, contrast
  failures, missing labels. False-positive rate is high inside
  contenteditable — review every flag.
- **Accessibility Insights for Web** (Microsoft). Includes the FastPass
  + assessment workflow. Wraps axe.
- **Lighthouse a11y category**. Coarse but cheap.
- **Playwright `expect(locator).toHaveAccessibleName(…)` /
  `toHaveAccessibleDescription(…)`**. Use in component tests for
  NodeViews.
- **`@axe-core/playwright`** in CI on a fixture editor with rich
  content (image, mention, code block, blockquote, list).

### 10.2 Manual SR checklists

Run each of these against the editor:

**NVDA + Firefox (Windows)**
1. Tab into editor → announces label + "edit, multi-line".
2. Type three characters → echoes each.
3. Type past an input rule (e.g., `# ` → heading) → caret announces
   "heading level 1" on next move.
4. Insert image via paste → after insert, arrow over → announces
   "image, {alt}".
5. Browse mode (Insert+Space toggles): can navigate by heading (H),
   list (L), graphic (G).
6. Comment / mention reachable → arrow lands on it; Enter activates;
   Escape returns caret.

**VoiceOver + Safari (macOS)**
1. VO+Right Arrow into editor → "edit text, {label}".
2. VO+A reads the entire document.
3. VO+Cmd+L lists links — mentions/links present.
4. VO+I (item chooser) shows headings.
5. Atom node selected → announces aria-label + "selected".

**VoiceOver + Safari (iOS)**
1. Triple-tap focuses editor; rotor for headings/links works.
2. Bluetooth keyboard arrows match desktop behavior.
3. Insertion at the bottom: viewport scrolls and SR follows.

**JAWS + Chrome (Windows)**
1. Forms mode auto-engages on focus.
2. JAWS Insert+F1 reports "edit field" with label.
3. "Quick keys" (H, L, T) work in virtual mode.

### 10.3 Forced-colors smoke test

Windows: Settings → Accessibility → Contrast themes → Aquatic.
- Editor border visible.
- Caret visible.
- Decorations (lint underlines, comment anchors) visible.
- Selected node outline visible.
- Presence cursors distinguishable (initial vs color).

### 10.4 Zoom and reflow

- 200% browser zoom: editor reflows; no horizontal scroll on a 1280px
  viewport.
- 400% zoom (WCAG 1.4.10): content reflows without loss; toolbars
  collapse to overflow menus.
- `prefers-reduced-motion` honored for caret-blink, drop indicator,
  presence cursor pulse.

---

## 11. Honest summary: PM ✅ / Consumer ✅

What `prosemirror-view` provides:

- ✅ `contenteditable="true"/"false"` on the host (`index.ts:519`).
- ✅ The `editable` prop (`index.ts:780`) for RW/RO toggling.
- ✅ The `attributes` prop for adding ARIA without forking
  (`index.ts:782, 516-535`).
- ✅ Forces `contenteditable="false"` on atom NodeViews missing a
  contentDOM (`viewdesc.ts:708-709`).
- ✅ Sets `translate="no"` so Chrome translation doesn't mangle
  documents (`index.ts:533`).
- ✅ Marks the cursor wrapper IMG with `alt=""` so SRs ignore it
  (`index.ts:543`).
- ✅ `focusPreventScroll` polyfill so AT-driven focus doesn't jump
  the viewport (`index.ts:339`).
- ✅ Gap cursor (separate package) for keyboard-only access to
  positions between atoms.
- ✅ NodeSelection / `ProseMirror-selectednode` class hook for
  styled focus rings.

What `prosemirror-view` does **not** provide and the consumer must
add:

- ❌ `role="textbox"` (or any role).
- ❌ `aria-multiline`, `aria-readonly`, `aria-label`,
  `aria-labelledby`, `aria-describedby`.
- ❌ `aria-invalid`, `aria-required`.
- ❌ `aria-activedescendant` for combobox patterns.
- ❌ Live regions for collab presence / autosave / errors.
- ❌ ARIA roles, labels, or `aria-hidden` on widget decorations.
- ❌ ARIA on atom NodeViews (role, label, tabindex policy).
- ❌ Keyboard activation handlers for interactive atoms.
- ❌ Forced-colors / WHCM-friendly decoration styling.
- ❌ Visible focus ring CSS for `ProseMirror-selectednode`.
- ❌ Announcements for programmatic transactions, input-rule rewrites,
  smart-quote substitutions.
- ❌ a11y testing harness, axe integration, SR-fixture suite.

If your editor is "accessible" because you typed
`contenteditable="true"` and called it a day, it is **not**
accessible. The consumer-side checklist above is the floor. The
spec'd target (WCAG 2.2 AA + APG textbox pattern) is the ceiling and
involves judgment calls per feature.

For platform-specific quirks see [18](./18-cross-browser-quirks.md);
for the keyboard semantics that drive arrow/selection movement see
[08 §6–§9](./08-selection.md) and [19 §3](./19-commands-keymap-inputrules.md).
