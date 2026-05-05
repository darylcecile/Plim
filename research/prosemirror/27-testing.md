# 27 — Testing ProseMirror editors

ProseMirror's architecture — pure functional document model, transactions as data, plugins as reducers — makes it unusually pleasant to test once you stop trying to drive it like a textbox. The actual editor view (DOM, contenteditable, IME) is where the messiness lives; almost everything else is a value transformation that can be unit-tested without a browser. This file walks through the practical testing stack: the test-builder DSL, transform/command tests, mocked views, jsdom's hard limits, real-browser test harnesses, IME, collab round-trips, plugin invariants, property-based testing, and CI.

## The `prosemirror-test-builder` DSL

The test-builder package exists for one reason: writing literal documents in code is intolerable. Compare:

```ts
schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("hello")]),
  schema.node("paragraph", null, [schema.text("world")])
])
```

versus:

```ts
import {doc, p} from "prosemirror-test-builder"
doc(p("hello"), p("world"))
```

The DSL produces real `Node` objects, not a parallel data type. `doc(...)`, `p(...)`, `h1(...)`, `pre(...)`, `ul(...)`, `li(...)`, etc. are exported from `prosemirror-test-builder/src/index.ts` as `NodeBuilder` functions. Marks are `MarkBuilder` functions that return a `{flat, tag}` object — they wrap their children in the mark and merge tags. So `p(em("hi"))` produces a paragraph whose single text node carries an `em` mark.

### Selection markers `<a>`, `<b>`, `<cursor>`

Inside a string child, the regex `/<(\w+)>/g` (see `build.ts` line 19) extracts named markers and records the *position* where they appeared. The text `"hello<a>world<b>"` becomes the literal string `"helloworld"` plus a `tag` map `{a: 5, b: 10}`. The convention is:

- `<a>` and `<b>` — selection anchor and head, used to construct a `TextSelection` or range.
- `<cursor>` — collapsed selection.
- Any other label is fair game; many test suites use `<start>`, `<gap>`, etc.

A typical helper:

```ts
import {EditorState, TextSelection} from "prosemirror-state"

function stateFromDoc(doc: any) {
  let sel = doc.tag.a != null
    ? TextSelection.create(doc, doc.tag.a, doc.tag.b ?? doc.tag.a)
    : undefined
  return EditorState.create({doc, selection: sel})
}
```

Now `stateFromDoc(doc(p("he<a>llo<b>")))` gives you a state with a selection covering `"llo"` — readable in code, no manual offsets.

### Builder-per-schema usage

The default builders are wired to a basic schema (`schema-basic` + lists). For your own schema, call `builders(mySchema, names)`:

```ts
import {builders} from "prosemirror-test-builder"

const b = builders(mySchema, {
  p: {nodeType: "paragraph"},
  h: {nodeType: "heading", level: 2},
  blockquote: {nodeType: "blockquote"},
  link: {markType: "link", href: "https://example.com"},
})
const {doc, p, h, blockquote, link} = b
```

The `names` map both renames and pre-binds attributes. `h({level: 3}, "title")` overrides level 2 for that call (see `takeAttrs` in `build.ts` line 54 — first arg is treated as attrs only if it is *not* a string/Node/`{flat}`). One builder per schema, exported from a `test-helpers.ts` module, is the canonical pattern.

## Testing transforms

`Node.eq` (deep structural equality) is the assertion primitive:

```ts
import {eq} from "prosemirror-test-builder"

test("splitBlock splits a paragraph", () => {
  const before = doc(p("he<a>llo"))
  const tr = stateFromDoc(before).tr
  splitBlock(stateFromDoc(before), tr.dispatch /* ... */)
  expect(eq(tr.doc, doc(p("he"), p("llo")))).toBe(true)
})
```

For transforms that return a `Transform` you don't need a state at all:

```ts
import {Transform} from "prosemirror-transform"
const tr = new Transform(doc(p("hello"))).delete(1, 3)
expect(tr.doc.eq(doc(p("llo")))).toBe(true)
```

A common gotcha: `Node.eq` is strict about marks, attrs, and node types but ignores `tag`. Don't try to assert positions through equality of tagged nodes.

## Testing commands

A command has signature `(state, dispatch?, view?) => boolean`. Two patterns:

**Probe (no dispatch):** call with just `state` to test the boolean return — does the command apply here?

```ts
expect(toggleMark(schema.marks.strong)(state)).toBe(true)
```

**Capture (mock dispatch):** pass a stub that records the transaction:

```ts
function run(cmd: Command, state: EditorState) {
  let captured: Transaction | null = null
  const ok = cmd(state, tr => { captured = tr })
  return {ok, tr: captured, doc: captured?.doc}
}

const {ok, doc: out} = run(toggleMark(schema.marks.em), stateFromDoc(doc(p("<a>hi<b>"))))
expect(ok).toBe(true)
expect(out.eq(doc(p(em("hi"))))).toBe(true)
```

If you need to assert step shape rather than the resulting doc:

```ts
expect(captured!.steps).toHaveLength(1)
expect(captured!.steps[0].toJSON()).toMatchObject({stepType: "addMark", mark: {type: "em"}})
```

This is more brittle but useful when the *kind* of operation matters (e.g., ensuring a command produces a `ReplaceAroundStep`, not multiple `ReplaceStep`s, for collab efficiency).

## Mocking EditorView for command unit tests

Most commands never touch the view. Some — `goToNextCell`, anything calling `view.dispatch`, `view.endOfTextblock` — do. For these, a tiny mock suffices:

```ts
function mockView(state: EditorState) {
  let cur = state
  return {
    get state() { return cur },
    dispatch(tr: Transaction) { cur = cur.apply(tr) },
    endOfTextblock() { return false },        // pessimistic default
    domAtPos() { throw new Error("not in test") },
    focus() {},
  } as unknown as EditorView
}
```

`endOfTextblock` is the one method commands genuinely depend on for arrow-key handling. Returning `false` makes commands assume "not at boundary" — fine for testing the *logic* path, fragile for testing the *boundary* path. For boundary tests, return `true` and assert the alternate branch.

Avoid stubbing `view.dom` or `view.coordsAtPos` — if your command reads those, it's a view-level concern and belongs in a browser test.

## jsdom: what it can't do

jsdom is great for parser/serializer tests. It is hostile to anything geometric or selection-API-heavy:

- **`Range.getClientRects()` and `Element.getBoundingClientRect()`** return zeros. Anything that calls `view.coordsAtPos` or measures line wrapping is meaningless.
- **`Selection.modify("move", "forward", "character")`** is unimplemented. PM uses this in some keymap fallbacks; in jsdom it's a no-op. `endOfTextblock` therefore lies.
- **`document.caretRangeFromPoint` / `caretPositionFromPoint`** absent — drag-drop position resolution can't be tested.
- **Composition events** are not synthesized by jsdom. `compositionstart`/`compositionupdate`/`compositionend` won't fire from typing characters; you can dispatch them manually but `view.composing` won't reflect real IME.
- **Clipboard events** with `DataTransfer` work partially; HTML/text payload is OK, file payloads aren't.
- **`MutationObserver`** works but timing differs from a real browser, which can mask races.

What you *can* test in jsdom:
- ParseRule round-trips (DOM in → Node out → DOM out).
- Plugin state transitions via `state.apply(tr)`.
- Commands that don't read geometry.
- Decorations applied to a mounted view (the DOM tree is real even if measurements aren't).
- Keymap dispatch by synthesizing a `KeyboardEvent` and calling `view.someProp("handleKeyDown", f => f(view, evt))`.

What you *cannot* trust in jsdom:
- Anything that depends on layout (line-wrap commands, gap-cursor positioning at line ends, `endOfTextblock`).
- IME flows.
- Drag-and-drop with `dropcursor`.
- Native selection rendering.

The rule: jsdom for *value* tests, real browser for *DOM* tests.

## Browser tests with Playwright/Cypress

For end-to-end behavior, drive a real Chromium/Firefox/WebKit:

```ts
// Playwright example
test("typing inserts text", async ({page}) => {
  await page.goto("/editor")
  const editor = page.locator(".ProseMirror")
  await editor.click()
  await page.keyboard.type("hello")
  await expect(editor).toContainText("hello")
})
```

Synthesizing low-level events:

- **Keypress:** `page.keyboard.press("Control+B")` actually fires a real keydown; PM's keymap will see it and the contenteditable will handle the input.
- **Paste:** `page.evaluate(() => navigator.clipboard.writeText("..."))` then `page.keyboard.press("Control+V")`. Or dispatch a synthetic `ClipboardEvent` with a populated `DataTransfer` if you need HTML — Playwright's `page.evaluate` lets you build it in-page.
- **Drag:** `editor.dragTo(target)`. For exotic cases (drag from outside the page, files), use the CDP session: `client.send("Input.dispatchDragEvent", ...)`.

Cypress can do all of this too with `cy.realPress`, `cy.realType` from `cypress-real-events` (Cypress's default `cy.type` skips the contenteditable beforeinput pipeline that PM relies on, so always use the real-events plugin).

### Testing IME

IME is the testing nightmare of any contenteditable editor and PM is no exception. jsdom does not synthesize composition events at all. In a real browser:

```ts
await page.evaluate(() => {
  const el = document.querySelector(".ProseMirror") as HTMLElement
  el.focus()
  el.dispatchEvent(new CompositionEvent("compositionstart", {data: ""}))
  el.dispatchEvent(new CompositionEvent("compositionupdate", {data: "あ"}))
  // browser typically inserts the composing text via input event with isComposing=true
  el.dispatchEvent(new InputEvent("input", {data: "あ", isComposing: true, inputType: "insertCompositionText"}))
  el.dispatchEvent(new CompositionEvent("compositionend", {data: "あ"}))
})
```

Even this is approximate — real IMEs cause bursts of input/composition events the browser owns. The high-fidelity option is OS-level injection (e.g., on macOS, AppleScript driving the IME), which is impractical for CI. Most teams settle for: assert that PM enters `view.composing === true` between start and end, and that the final document matches expectation.

## Testing collab

`prosemirror-test-builder` plus `prosemirror-collab` makes server-free round-trips trivial. Set up two states sharing an initial doc, run sendable/receive cycles:

```ts
import {collab, sendableSteps, receiveTransaction, getVersion} from "prosemirror-collab"
import {EditorState} from "prosemirror-state"

function makePeer(name: string, initial = doc(p("hello"))) {
  return EditorState.create({doc: initial, plugins: [collab({clientID: name})]})
}

let alice = makePeer("alice"), bob = makePeer("bob")

// alice types
alice = alice.apply(alice.tr.insertText(" world", 6))

// flush alice -> server -> bob
const sendable = sendableSteps(alice)!
bob = bob.apply(receiveTransaction(bob, sendable.steps, sendable.clientIDs))
alice = alice.apply(receiveTransaction(alice, sendable.steps, sendable.clientIDs))

expect(alice.doc.eq(bob.doc)).toBe(true)
```

The pattern generalizes to N peers with a fake "authority" array of accepted steps. Property-based fuzzing over interleavings of peer edits is the gold-standard test for any custom step type — PM's own collab tests do exactly this.

## Plugin tests

Three things to verify for a custom plugin:

1. **State field invariants** — given an arbitrary transaction, the resulting plugin state still satisfies its contract (sorted, deduped, references valid positions, etc.). Drive the plugin through a sequence of real transactions and assert.

2. **`appendTransaction` termination** — if your plugin appends transactions, ensure it doesn't loop. Test by feeding in an input that triggers your append, and assert that re-running `appendTransaction` on the resulting state returns `null` (no further work). PM's reducer would otherwise loop forever.

   ```ts
   const tr1 = plugin.spec.appendTransaction!([initialTr], oldState, newState)
   const after = newState.apply(tr1!)
   const tr2 = plugin.spec.appendTransaction!([tr1!], newState, after)
   expect(tr2).toBeNull()
   ```

3. **Decoration generation** — assert via `plugin.props.decorations(state)?.find()` that the right decoration set is produced for a given doc.

## Property-based testing of transforms

PM transforms have a powerful invariant: every step is invertible against the doc it was applied to. Use fast-check:

```ts
import fc from "fast-check"
import {Transform} from "prosemirror-transform"

const arbDoc = /* generator producing random valid docs */
const arbStep = /* generator producing random valid step on a doc */

test("steps are invertible", () => {
  fc.assert(fc.property(arbDoc, (d) => {
    const tr = new Transform(d)
    // apply N random steps
    for (let i = 0; i < 10; i++) {
      const step = randomStep(tr.doc)
      if (!step) break
      tr.step(step)
    }
    // invert all steps in reverse and re-apply
    const inverse = new Transform(tr.doc)
    for (let i = tr.steps.length - 1; i >= 0; i--)
      inverse.step(tr.steps[i].invert(tr.docs[i]))
    expect(inverse.doc.eq(d)).toBe(true)
  }))
})
```

Generating valid random docs is the hard part — easiest is to start from a known doc and apply random `replaceWith`/`insertText`/`addMark` transforms, since those are guaranteed to produce schema-valid output. The same fuzzer reused for collab rebase: random steps on two diverging branches, then converge via `rebaseSteps`, assert the docs match.

## CI patterns

A typical PM-based product runs three test layers:

1. **Vitest + jsdom** for everything pure: transforms, commands (with mocked view), plugins, schema, parser/serializer round-trips. Fast (<10s for a hundred files), runs on every push.
2. **Playwright** matrix across `chromium`, `firefox`, `webkit` for: keyboard and IME flows, drag-drop, real selection, paste with HTML payloads, copy of selection. Run on PR and nightly.
3. **Visual regression** (Playwright + screenshot diff) for decoration rendering, gap-cursor placement, table resize handles — anything where a CSS regression silently breaks UX.

GitHub Actions matrix:

```yaml
strategy:
  matrix:
    browser: [chromium, firefox, webkit]
steps:
  - run: npx playwright install --with-deps ${{matrix.browser}}
  - run: npx playwright test --project=${{matrix.browser}}
```

Webkit is where PM bugs hide — Safari's selection model and IME differ enough that "works in Chrome" is not enough. Run it.

## Snapshot testing pitfalls

Snapshot tests of `node.toJSON()` are tempting but brittle. Any schema attr addition (even with a default) changes every snapshot, drowning real regressions in noise. Prefer structural assertions via `Node.eq` against a builder-constructed expected doc — those tests survive schema evolution and read as documentation. Reserve snapshots for HTML serialization output where the diff *is* the point of the test (e.g., copy-paste regression suites).

When a snapshot must exist, normalize first: strip default attrs, sort marks alphabetically, omit empty content arrays. PM's own `toJSON` already omits empties, but if you add custom attrs with defaults (`width: {default: null}`), every node carries `attrs: {width: null}` and your snapshots churn on every `null`. Run a normalizer before serializing to JSON: walk the tree, drop attrs equal to their type's default. The snapshot then describes only meaningful structure.

## Testing parse rules

DOM parser rules (`parseDOM` on a node spec) are best tested by feeding HTML strings through `DOMParser.fromSchema(schema).parse(div)` and asserting the result with `Node.eq` against a builder doc:

```ts
function parseHTML(html: string) {
  const div = document.createElement("div")
  div.innerHTML = html
  return DOMParser.fromSchema(schema).parse(div)
}

expect(parseHTML("<p>hi <em>there</em></p>"))
  .toEqualDoc(doc(p("hi ", em("there"))))
```

Round-trip tests (parse → serialize → parse again) catch asymmetries: a `parseDOM` rule that captures attrs not emitted by `toDOM`, or vice-versa. Asymmetry is fine for *lossy* tolerance (parse Word HTML, normalize on output) but should be deliberate and documented.

## Testing input rules and paste handlers

Input rules (`prosemirror-inputrules`) trigger on text typed into the view. Test them by dispatching input events through a real or mocked view, or — easier — by directly invoking the rule's `handler` with a synthetic `(state, match, start, end)`:

```ts
const rule = headingRule(schema.nodes.heading, 6)
const state = stateFromDoc(doc(p("## <a>")))
const tr = rule.handler(state, ["## ", "##"], 1, state.tr.selection.from)
expect(tr).not.toBeNull()
expect(tr!.doc.eq(doc(h2("")))).toBe(true)
```

Paste handlers (`transformPasted`, `clipboardParser`) get the same treatment: build a DataTransfer, call `view.someProp("transformPasted", f => f(slice, view))`, assert the result. Browser tests are still required for the full clipboard pipeline because Chrome and Firefox normalize HTML differently before handing it to your parser — a paste from Google Docs looks one way in Chrome and another in Firefox.

A final tip: keep the test-builder export co-located with your schema (`src/schema/test-helpers.ts`), re-export `eq` and a `state(...)` helper, and write tests that read like prose: `expect(after).toMatchDoc(doc(p("hello"), p("world")))` with a custom Vitest matcher wrapping `Node.eq`. Readable tests are the leverage that pays off across hundreds of edge cases.
