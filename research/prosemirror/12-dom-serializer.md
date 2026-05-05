# 12 · DOM Serializer (`prosemirror-model/src/to_dom.ts`)

The DOM serializer is the inverse of the parser: it turns a ProseMirror `Node`
or `Fragment` into a DOM tree, driven by `toDOM` functions on each node and
mark spec. Compared to the parser, it is short — ~240 LOC — because the schema
already enforces structure; the serializer is essentially a recursive
`renderSpec` plus a mark-stack reconciler.

All file:line citations are `prosemirror-model/src/to_dom.ts` unless prefixed.

---

## 1. `DOMOutputSpec`

```ts
export type DOMOutputSpec =
  | HTMLElement
  | { dom: HTMLElement, contentDOM?: HTMLElement }
  | readonly [string, ...any[]]
```
— `to_dom.ts:23`.

Three forms:

1. **Pre-built DOM node** — returned as-is.
2. **`{dom, contentDOM}`** — caller materialized DOM and tells us where to put
   children. Used by NodeView-shaped specs.
3. **Array spec** — `[tag, attrs?, ...children]`, the common form. The optional
   second element is the attribute object iff it's a non-Array, non-DOM-node
   plain object. Children may be:
   - another `DOMOutputSpec`
   - a string (text node)
   - the literal `0` — the **content hole**, where the node's children go.

Constraints (enforced in `renderSpec`, lines 224-241):

```ts
if (child === 0) {
  if (i < structure.length - 1 || i > start)
    throw new RangeError("Content hole must be the only child of its parent node")
  return {dom, contentDOM: dom}
}
```

So `0` must be the **only** child of its parent in the spec — multiple holes,
or a hole next to siblings, throw. (Exactly one hole per output spec, hoisted
to the deepest array level it appears in.)

`contentDOM` propagation through nested arrays: `renderSpec` recurses
(line 233-238) and bubbles a single `contentDOM` upward, throwing
`"Multiple content holes"` if two arrive.

Tag namespacing: `"http://www.w3.org/2000/svg svg"` — anything before a single
space in the tag name becomes the XML namespace passed to
`createElementNS` (lines 207-213). Attribute keys can also include a namespace
prefix the same way (line 218-219).

> **The namespace mechanism is *general*, not SVG-specific.** Any URI works:
> MathML (`http://www.w3.org/1998/Math/MathML`), XHTML
> (`http://www.w3.org/1999/xhtml`), or your own. The same `" "` split applies
> to *both* tag names and attribute names — for attributes it triggers
> `setAttributeNS(ns, localName, value)` instead of `setAttribute`. This is
> how `xlink:href` on SVG `<use>` elements gets correctly namespaced:
>
> ```js
> ["http://www.w3.org/2000/svg use",
>  { "http://www.w3.org/1999/xlink href": "#sym" }]
> ```
>
> Note the *attribute* namespace differs from the *tag* namespace. The parser
> recovers them through `Element.namespaceURI` / `Attr.namespaceURI` on the
> way back in.

---

## 2. `DOMSerializer.fromSchema(schema)`

```ts
static fromSchema(schema): DOMSerializer {
  return schema.cached.domSerializer as DOMSerializer ||
    (schema.cached.domSerializer =
      new DOMSerializer(this.nodesFromSchema(schema), this.marksFromSchema(schema)))
}
```
— `to_dom.ts:132-135`.

Cached on the schema. `nodesFromSchema` walks `schema.nodes`, picks up each
spec's `toDOM`, and falls back to identity-text for `text` if missing
(`to_dom.ts:139-143`):

```ts
static nodesFromSchema(schema) {
  let result = gatherToDOM(schema.nodes)
  if (!result.text) result.text = node => node.text
  return result
}
```

`gatherToDOM` (line 151-158) just collects every defined `spec.toDOM`:

```ts
function gatherToDOM(obj) {
  let result = {}
  for (let name in obj) {
    let toDOM = obj[name].spec.toDOM
    if (toDOM) result[name] = toDOM
  }
  return result
}
```

Notice: a node/mark whose spec **omits** `toDOM` is silently absent from the
serializer maps. For marks that's a feature — `marks` indexed by name returns
`undefined`, and `serializeFragment` treats that as "skip this mark". For
nodes it's a bug-magnet: `serializeNodeInner` will throw at
`this.nodes[node.type.name](node)` because `this.nodes[name]` is `undefined`.
Schemas always need a node `toDOM` (or stop using `fromSchema`).

---

## 3. Public methods

### 3.1 `serializeNode(node, options)` — single node + its marks (`to_dom.ts:94-104`)

```ts
serializeNode(node, options = {}) {
  let dom = this.serializeNodeInner(node, options)
  for (let i = node.marks.length - 1; i >= 0; i--) {
    let wrap = this.serializeMark(node.marks[i], node.isInline, options)
    if (wrap) {
      ;(wrap.contentDOM || wrap.dom).appendChild(dom)
      dom = wrap.dom
    }
  }
  return dom
}
```

Renders the node, then wraps with marks from inside-out (last mark in the set
becomes the outermost). Used for non-fragment serialization (e.g. clipboard
copy of a single inline node).

### 3.2 `serializeNodeInner(node, options)` (`to_dom.ts:77-87`)

```ts
serializeNodeInner(node, options) {
  if (node.isText) return doc(options).createTextNode(node.text)
  let {dom, contentDOM} =
    renderSpec(doc(options), this.nodes[node.type.name](node), null, node.attrs)
  if (contentDOM) {
    if (node.isLeaf) throw new RangeError("Content hole not allowed in a leaf node spec")
    this.serializeFragment(node.content, options, contentDOM)
  }
  return dom
}
```

- Text → DOM text node directly.
- Otherwise: call the node's `toDOM(node)`, render the spec, recurse children
  into the resulting `contentDOM`.
- **Leaf invariant**: `isLeaf` nodes must not provide a hole. The runtime check
  re-asserts the schema rule.

The 4th arg to `renderSpec` is `node.attrs` — used by the "suspicious
attributes" XSS check (see §6).

### 3.3 `serializeFragment(fragment, options, target?)` (`to_dom.ts:46-74`)

The mark-reconciliation core:

```ts
serializeFragment(fragment, options = {}, target?) {
  if (!target) target = doc(options).createDocumentFragment()
  let top = target, active: [Mark, HTMLElement|DocumentFragment][] = []
  fragment.forEach(node => {
    if (active.length || node.marks.length) {
      let keep = 0, rendered = 0
      while (keep < active.length && rendered < node.marks.length) {
        let next = node.marks[rendered]
        if (!this.marks[next.type.name]) { rendered++; continue }
        if (!next.eq(active[keep][0]) || next.type.spec.spanning === false) break
        keep++; rendered++
      }
      while (keep < active.length) top = active.pop()[1]
      while (rendered < node.marks.length) {
        let add = node.marks[rendered++]
        let markDOM = this.serializeMark(add, node.isInline, options)
        if (markDOM) {
          active.push([add, top])
          top.appendChild(markDOM.dom)
          top = markDOM.contentDOM || markDOM.dom
        }
      }
    }
    top.appendChild(this.serializeNodeInner(node, options))
  })
  return target
}
```

`active` is a stack of `[mark, parentBeforeMark]` pairs, in the same order as
the iteration order of marks on the *previous* sibling. For each child node:

1. **Diff the prefix** of `active` and `node.marks`, advancing `keep`/`rendered`
   while they match. A serializer entry that returned no spec
   (`!this.marks[next.type.name]`) is skipped over on the new side.
   `spanning === false` forces an early break, preventing reuse of the existing
   wrapper.
2. **Pop** the suffix of `active` we no longer need, restoring `top` to the
   parent that existed before that mark was applied.
3. **Push** new marks beyond the matching prefix: render each via
   `serializeMark`, attach into `top`, and set `top` to its
   `contentDOM ?? dom` for subsequent appends.
4. Append the node itself into the (possibly mark-nested) `top`.

> **Three subtle semantics in this loop:**
>
> - **`keep`/`rendered`/`pop`-and-walk-back.** `keep` counts active wrappers
>   we'll reuse; `rendered` counts marks consumed from `node.marks`. When
>   `keep < active.length` after the prefix loop, we `active.pop()` until
>   they match, *and* we walk `top` back via the captured
>   `parentBeforeMark`. This is what limits wrapper depth and is also why
>   declaring marks in a stable schema-rank order matters: if `[em, strong]`
>   becomes `[strong, em]` between siblings, the prefix has length 0 and
>   *both* wrappers churn.
> - **`null`-toDOM silently drops the mark.** If `this.marks[name]` is
>   `undefined` (mark spec omitted `toDOM`, or `toDOM = null`), the loop
>   `rendered++; continue` — the mark is silently dropped from output, not
>   thrown on. Plugin authors hitting this lose marks without warning.
> - **`spanning: false` forces a fresh wrapper.** Even when `next.eq(active[keep][0])`,
>   the loop breaks. So three consecutive `text` nodes each carrying a `code`
>   mark with `spanning:false` produce three separate `<code>` elements —
>   never one merged wrapper.

This is what produces idiomatic HTML like
`<em><strong>a</strong>b</em><strong>c</strong>` from a fragment with marks
`[em,strong]`, `[em]`, `[strong]` on three text nodes — the `em` wrapper is
*reused* across the first two siblings, then closed, then `strong` opens
fresh.

### 3.4 `serializeMark(mark, inline, options)` (`to_dom.ts:107-110`)

```ts
serializeMark(mark, inline, options = {}) {
  let toDOM = this.marks[mark.type.name]
  return toDOM && renderSpec(doc(options), toDOM(mark, inline), null, mark.attrs)
}
```

Returns `undefined` if the mark has no serializer (so `serializeFragment` skips
it). Mark `toDOM` receives `(mark, inline)` — useful for marks that wrap inline
vs block content differently (rare; mostly only `inline=true` in practice).

### 3.5 `DOMSerializer.renderSpec` (static, `to_dom.ts:115-128`)

The public, *backwards-compatibly-typed* wrapper around `renderSpec`. It
accepts a string for legacy reasons:

```ts
if (typeof structure == "string") return {dom: doc.createTextNode(structure)}
```

— purely a "kludge for backwards compatibility with accidental original
behaviour" (line 124 comment). Otherwise delegates to internal `renderSpec`.

---

## 4. Mark rendering order & inclusivity

ProseMirror's `Mark.addToSet` keeps marks sorted by **schema rank** — the
order in which the mark types were declared in the schema (`MarkType.rank`).
That means in `serializeFragment` the `node.marks` arrays of consecutive
siblings have predictable ordering, which is exactly what makes the prefix
diff in `serializeFragment` actually find shared prefixes.

Practical consequences for spec design:

- **Declare more-stable marks earlier**, so they sit at the *outside* of the
  rendered nesting and don't churn across siblings. e.g. `link` before
  `strong` produces `<a><strong>...</strong></a>` and lets the `<a>` span
  multiple stylings.
- **`spanning: false`** (defaulting `true`) on a mark spec forces a *fresh*
  DOM wrapper for every contiguous run, even when the mark is identical
  (`to_dom.ts:56`: `next.type.spec.spanning === false → break`). Use this for
  things like `code` mark in some schemas where you don't want adjacent
  `<code>` runs collapsing.
- **`inclusive`** (parser/edit semantics) does not affect serialization
  directly — but it affects which marks live on the node in the first place.

Mark `toDOM` typically *omits* the hole, e.g. `["em"]`. In that case
`renderSpec` returns `{dom, contentDOM: undefined}` and `serializeFragment`
does `top = markDOM.contentDOM || markDOM.dom` (line 66) — i.e. children are
appended directly into the mark's outer element. If a mark *does* include a
hole, content goes inside the hole exactly as for nodes.

`serializeNode` walks marks **in reverse** (line 96) — that is correct
because the inner mark in the rendered nesting should be the **first** mark in
the array, so wrapping the rendered DOM with `marks[i]` from `length-1` down
to `0` makes `marks[0]` end up outermost. This is *opposite* to how
`serializeFragment` handles things, because here we're wrapping a single
already-built `dom`, not building from scratch.

---

## 5. `renderSpec` low-level

`to_dom.ts:193-242`. Algorithm:

```
if structure is a text node:                return {dom: structure}
if structure is {dom, contentDOM} where dom is text:  return as-is
tagName = structure[0]; assert string
if (xss check)                              throw
if tagName has " ":  xmlNS = head, tag = tail
dom = xmlNS ? doc.createElementNS(xmlNS, tag) : doc.createElement(tag)
attrs = structure[1]
if attrs is a plain object (non-array, non-DOM):
  start = 2
  for (name in attrs):
    if name has " " : setAttributeNS(ns, localName, value)
    else if name == "style" && dom.style: dom.style.cssText = value
    else: setAttribute(name, value)
else:
  start = 1
for i in [start, length):
  child = structure[i]
  if child === 0:    require sole child; return {dom, contentDOM: dom}
  if typeof child == "string": appendChild(createTextNode)
  else:  recurse renderSpec, appendChild result, propagate single contentDOM
return {dom, contentDOM}
```

Key fine points:

- `style` attribute is set via `dom.style.cssText` rather than
  `setAttribute("style", …)` (line 220) — this exists so XSS-stripped
  shorthand style values get re-canonicalized by the browser. **In
  non-browser DOMs (`jsdom`, server SSR), `dom.style` may or may not
  exist** — the `&& dom.style` guard handles that.
- Attribute values are coerced via the browser; nullish values are skipped
  (`if (attrs[name] != null)`, line 217). To **delete** an attribute, pass
  `null`/`undefined` (or just don't include it).
- There is no HTML-escaping for text children — `createTextNode` handles that.

---

## 6. XSS / "suspicious attributes" guard (`to_dom.ts:164-191, 204-206`)

> **🛑 Security-critical.** This guard is the single defence between
> attacker-controlled JSON in `node.attrs` and arbitrary DOM injection at
> render time. Removing or bypassing it (e.g. by calling the static
> `DOMSerializer.renderSpec` from a custom `toDOM`) re-opens the hole.

```ts
const suspiciousAttributeCache = new WeakMap()

function suspiciousAttributesInner(attrs) {
  let result = null
  function scan(value) {
    if (value && typeof value == "object") {
      if (Array.isArray(value)) {
        if (typeof value[0] == "string") { (result ??= []).push(value) }
        else for (let v of value) scan(v)
      } else for (let p in value) scan(value[p])
    }
  }
  scan(attrs); return result
}

// In renderSpec:
if (blockArraysIn && (suspicious = suspiciousAttributes(blockArraysIn)) &&
    suspicious.indexOf(structure) > -1)
  throw new RangeError("Using an array from an attribute object as a DOM spec. " +
                       "This may be an attempted cross site scripting attack.")
```

The 4th arg to internal `renderSpec` (`blockArraysIn`) is set to `node.attrs`
(or `mark.attrs`) by `serializeNodeInner`/`serializeMark`. The cache scans the
attrs for any `[string, ...]`-shaped sub-array. If a `toDOM` ever returns one
of those very arrays as its output spec, that's almost certainly an attacker
having placed a malicious DOMOutputSpec inside an attribute string and a
poorly-written `toDOM` having returned it verbatim — so we throw. The cache is
keyed by attrs identity in a `WeakMap`, so it's amortized free across renders
of the same node.

### 6.1 Threat model

The attack the guard defends against:

1. The application stores documents from untrusted sources (collab, paste,
   external API).
2. A node has an attribute (say, `data` on a custom embed) that is a
   `[string, …]` array shaped like a `DOMOutputSpec`. Postgres / JSON-typed
   storage round-trips arrays through node attrs as-is.
3. A naïve `toDOM(node)` returns `node.attrs.data` — perhaps because the
   author wanted "user-supplied DOM tree" semantics.
4. Without the guard, attacker-supplied
   `["script", {}, "alert(document.cookie)"]` would render as a real
   `<script>` element.

The guard catches step 4. **It does not** catch `toDOM` functions that
hand-construct DOM from attrs (e.g. setting `dom.innerHTML = node.attrs.html`).
That's a separate hazard the schema author owns — the guard is specifically
about array-shaped spec injection.

### 6.2 Worked example

```ts
// Schema:
const embed = {
  attrs: { spec: { default: ["span"] } },
  toDOM: node => node.attrs.spec   // ← naive
}

// Attacker-controlled doc:
embed.create({ spec: ["script", {}, "alert(1)"] })

// At serialization time:
//   serializeNodeInner calls renderSpec(doc, node.attrs.spec, null, node.attrs)
//   blockArraysIn = node.attrs = { spec: ["script", {}, "alert(1)"] }
//   suspiciousAttributes(blockArraysIn) = [["script", {}, "alert(1)"]]
//   structure === blockArraysIn.spec → matches → throws
//
// → RangeError: "Using an array from an attribute object as a DOM spec.
//                This may be an attempted cross site scripting attack."
```

The render aborts the entire `serializeFragment` call — that is, **a single
poisoned attr blast-radius is the whole document fragment, not just the
offending node.** Callers should sanitise input upstream rather than rely on
this throw.

### 6.3 The static `renderSpec` escape hatch

The public `DOMSerializer.renderSpec(...)` static method does **not** receive a
`blockArraysIn` (line 115-128), so the check is skipped there. That's because
it's intended for callers (like NodeView authors) that have already vetted the
spec themselves. *Do not call it with attacker-derived arrays.*

---

## 7. SSR / non-browser usage

`doc(options)` (line 160-162):

```ts
function doc(options) { return options.document || window.document }
```

Every entry point accepts `{document}` as an option:

```ts
serializer.serializeFragment(frag, {document: jsdom.window.document})
```

Without it, the serializer touches `window.document` and crashes in Node.
Custom `Document`s must implement `createElement`, `createElementNS`,
`createTextNode`, `createDocumentFragment`, and elements must support
`appendChild`, `setAttribute`, `setAttributeNS`, and ideally `style.cssText`.

For string output, render into a `DocumentFragment` then `outerHTML`/`innerHTML`
the wrapper — there's no built-in `serializeToString`.

XML namespaces work transparently via `"NS tag"` form, so you can render to
SVG or MathML inline without extra config.

---

## 8. Edge cases

1. **Leaf with hole** → `serializeNodeInner` throws `"Content hole not
   allowed in a leaf node spec"` (line 83). This is post-hoc — the spec
   author is expected to omit the `0`. `["br"]`, `["img", {src}]` are correct.
2. **Multiple holes** → `renderSpec` throws `"Multiple content holes"`
   (line 236) when more than one nested array contributes a `contentDOM`.
   Even legitimate-looking specs like `["div", ["span", 0], ["span", 0]]`
   are illegal.
3. **Hole next to siblings** → `["div", "before", 0]` throws `"Content hole
   must be the only child of its parent node"` (line 228). Wrap the hole:
   `["div", "before", ["div", 0]]`.
4. **Text node serialization**: only via the `text` node spec. The default
   from `nodesFromSchema` is `node => node.text`, which `renderSpec` then
   wraps as `{dom: createTextNode(...)}` via the legacy string handling in the
   *public* `DOMSerializer.renderSpec` — but **not** via the internal
   `renderSpec`. Internal `renderSpec` only handles strings as *child elements
   inside an array spec*. So custom `text` `toDOM`s should return a string
   inside an array, e.g. `node => ["span", node.text]`, not a bare string.
   In practice nobody overrides text serialization (and the parser explicitly
   doesn't support it).
5. **Attribute encoding**: delegated to `setAttribute`/`setAttributeNS`. There
   is no manual escaping; the browser DOM handles `&`, `<`, `"` etc.
6. **`"style"` attribute**: assigned via `dom.style.cssText` — the browser
   will silently drop unparseable declarations. To pass through arbitrary
   strings as-is (e.g. for non-browser DOMs), provide a `Document`
   implementation whose elements have no `.style` property.
7. **`spanning: false` + `keep == rendered`**: the loop `break`s, so all
   active marks beyond `keep` get popped and re-pushed for this node, even
   if they were identical. That is the entire point.
8. **DOM-form output spec returning the *same* node twice**: if a `toDOM`
   returns the same `HTMLElement` reference for two different fragment
   children, `appendChild` will move the node, breaking earlier output.
   Always create fresh DOM. `["tag", ...]` form does this for you.
9. **Mark nesting around cross-node selections**: `serializeFragment` only
   diffs against the immediately-previous sibling's marks. A mark that
   appears on `marks[0]` and `marks[2]` but not `marks[1]` will produce
   `<m>a</m>b<m>c</m>`, not `<m>a b c</m>` — there's no global merge.

---

## 9. Inverse trace: Doc → Fragment → DOM

Continuing the example from `11-dom-parser.md`:

```
doc
├── paragraph
│   └── text "Hello foo"   marks=[strong]   ← actually "Hello "+strong("foo")
└── paragraph
    └── text "bar"
```

The realistic node breakdown:

```
paragraph
  text "Hello "
  text "foo"   marks=[strong]
```

`DOMSerializer.serializeNode(doc)` →

```
serializeNodeInner(doc):
  this.nodes.doc(doc) = ["div", {class:"ProseMirror"}, 0]   (typical spec)
  renderSpec → dom=<div>, contentDOM=<div>
  serializeFragment(doc.content, {}, <div>):
    forEach:
      paragraph #1:
        active=[], marks=[]
        skip mark loop
        serializeNodeInner(paragraph) →
          this.nodes.paragraph(p) = ["p", 0]
          renderSpec → <p>+contentDOM=<p>
          serializeFragment(p.content, {}, <p>):
            text "Hello ":
              active=[], marks=[]
              top.appendChild(createTextNode("Hello "))
            text "foo" marks=[strong]:
              active=[], marks=[strong]
              keep=0, rendered=0; loop never enters (0<0 false)
              push strong: serializeMark(strong, true) =
                renderSpec(["strong"]) → <strong>
                active=[[strong, <p>]]; <p>.appendChild(<strong>); top=<strong>
              top.appendChild(createTextNode("foo"))
        ⇒ <p>Hello <strong>foo</strong></p>
        appendChild to outer <div>
      paragraph #2:
        active still has [strong, <p>] — but iterating *fragment* level (the doc),
        the mark stack resets fresh because we're inside a *new* invocation of
        serializeFragment for the doc itself, not the paragraph.

        Wait — at the doc level, paragraphs have NO marks. active starts empty
        per-call to serializeFragment. So:
        active=[], marks=[]
        serializeNodeInner(p2) → <p>bar</p>
        appendChild to outer <div>

⇒ <div class="ProseMirror"><p>Hello <strong>foo</strong></p><p>bar</p></div>
```

The `active` stack is **per `serializeFragment` invocation**, not global. So
mark wrappers never escape their parent block, and the implicit "marks live on
inline content" rule is enforced for free.

---

## 10. Cross-references

- `from_dom.ts:311-314` — parser cache mirror of the serializer cache here.
- `from_dom.ts:241-275` — rule matching is the inverse mapping for §2-3 here.
- `schema.ts:447-459` — `NodeSpec.toDOM` declaration.
- `schema.ts:521-533` — `MarkSpec.spanning` and `MarkSpec.toDOM`.
- `dom.ts:1` — `export type DOMNode = InstanceType<typeof window.Node>` —
  every DOM-handling type in the package routes through this single typedef so
  swapping in a non-browser DOM means only stubbing `window.Node`.

---

## 11. Why-questions

**Why is `mark.toDOM === null` silently dropped instead of throwing?** So a
schema can declare a mark for parser-side / state-side use (e.g. an internal
"composing" or "dirty" flag) without forcing a DOM representation. The mark
roundtrips through ProseMirror state but vanishes at serialization. If you
*want* loud failure, write `toDOM: () => { throw new Error("…") }`.

**Why does the serializer not `cloneNode` to amortise repeated `toDOM` calls?**
Because `toDOM`'s contract is "produce fresh DOM each call." Some specs return
DOM nodes directly (form 1) and the serializer trusts the spec to either
construct a new node or accept the consequences if it doesn't.
`["tag", …]` form sidesteps this entirely — `renderSpec` always
`createElement`s a fresh tree. The cost of cloning would also defeat NodeView
authors who rely on `dom`/`contentDOM` identity.

**Why isn't the mark `excludes` relationship enforced at serialization?**
Because excludes is a *schema-construction-time* invariant: the `Mark.addToSet`
operation enforces it whenever marks are placed onto a node. By the time
serialization runs, `node.marks` already satisfies all `excludes` rules — there
is nothing for the serializer to check. (Contrast with `spanning`, which is a
*serialization-shape* concern and therefore lives here.)

**Why is there no text-node coalescing at serialization?**
`serializeNodeInner` calls `createTextNode` once per ProseMirror text node
(line 78); two adjacent text siblings with identical marks become two adjacent
DOM `Text` nodes. Browsers will *normalise* them into one when the resulting
HTML is later re-parsed (via `Element.normalize()` or implicitly through
`innerHTML` round-tripping), so for visible output it doesn't matter. But it
does affect:

- `Selection`/`Range` reconstruction in `prosemirror-view`, which expects 1:1
  PM-text ↔ DOM-text correspondence.
- Round-trip stability via `innerHTML` → `parseSlice`: if you serialize then
  re-parse, you may end up with a single PM text node where you started with
  two — generally fine, but plugin tests sometimes notice.

The serializer deliberately does not coalesce because it would need to inspect
mark identity across siblings, which is exactly the work `serializeFragment`
already does at the *wrapper* level. Replicating that for text would double
the loop's complexity for a marginal output-size win.

---

## 12. Worked micro-examples

### 12.1 SVG with namespaced tag *and* attribute

```ts
const symbolUseSpec: DOMOutputSpec = [
  "http://www.w3.org/2000/svg use",
  { "http://www.w3.org/1999/xlink href": "#icon-check" }
]
DOMSerializer.renderSpec(document, symbolUseSpec)
// produces:
//   <use xlink:href="#icon-check"/>   (in the SVG namespace)
//   .namespaceURI === "http://www.w3.org/2000/svg"
//   .getAttributeNS("http://www.w3.org/1999/xlink", "href") === "#icon-check"
```

The leading-space convention applies independently on tag and attr names.
Children of the `<use>` would inherit `xmlNS = SVG ns` via `renderSpec`'s
recursive `xmlNS` parameter (line 233), so nested `["path", ...]` becomes an
SVG `<path>` without further annotation.

### 12.2 `code` mark with `spanning: false`

```ts
// Schema:
const codeMark = { spec: { spanning: false, toDOM: () => ["code"] } }

// Document fragment:
//   text("foo", marks=[code])
//   text("bar", marks=[code])
//   text("baz", marks=[code])

serializeFragment(frag) →
  // Loop iteration 1: active=[], marks=[code]; push <code>1; append "foo"
  // Loop iteration 2: keep<active && rendered<marks → next=code, eq, but
  //                   spec.spanning===false → break.
  //                   Pop <code>1 (top ← parent). Push fresh <code>2; append "bar"
  // Loop iteration 3: same → fresh <code>3; append "baz"
  →
  <code>foo</code><code>bar</code><code>baz</code>
```

Without `spanning: false` (the default `true`) the three runs would collapse
into `<code>foobarbaz</code>` because the first `<code>` wrapper is reused.

### 12.3 XSS attempt and the RangeError

```ts
const node = embedType.create({ payload: ["script", {}, "alert(1)"] })
// embedType.spec.toDOM = node => node.attrs.payload   (naive)

serializer.serializeNode(node)
// → serializeNodeInner(node)
// → renderSpec(doc, ["script", {}, "alert(1)"], null, node.attrs)
//   blockArraysIn = node.attrs                     // contains the array
//   suspiciousAttributes(blockArraysIn)            // returns [<that array>]
//   suspicious.indexOf(structure) > -1             // true
// → throw RangeError("Using an array from an attribute object as a DOM spec.
//                     This may be an attempted cross site scripting attack.")
```

The error halts the entire `serializeFragment` invocation. In a `prosemirror-view`
context, this surfaces as an exception during `view.updateState`, which
ProseMirror does not catch — the view is left in a partially-rendered state.
Treat this guard as a *last-resort tripwire*; sanitise upstream.
