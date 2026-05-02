# 11 · DOM Parser (`prosemirror-model/src/from_dom.ts`)

The DOM parser converts an arbitrary DOM tree (typed-in HTML, pasted clipboard
fragments, server-rendered content) into a strict ProseMirror `Node` (or `Slice`
for clipboard insertion). It is rule-driven, schema-aware, and operates as a
state machine that walks the DOM, opens/closes ProseMirror node contexts, and
fixes up content to satisfy the schema's `ContentMatch` constraints.

All file:line citations in this file refer to
`prosemirror-model/src/from_dom.ts` unless prefixed with `schema.ts:` or
`to_dom.ts:`.

---

## 1. Top-level shape

```
DOMParser
 ├── schema:       Schema
 ├── rules:        readonly ParseRule[]      // user-supplied order
 ├── tags:         TagParseRule[]            // sliced from rules
 ├── styles:       StyleParseRule[]          // sliced from rules
 ├── matchedStyles: string[]                 // CSS prop names referenced by rules
 └── normalizeLists: boolean                 // computed from schema
```

Constructor partitions rules into `tags` vs `styles` and seeds `matchedStyles`
with the CSS property names referenced by `style` rules so that during parsing
we can `getPropertyValue` directly instead of iterating `style.item` (which
would expand shorthand `text-decoration` etc.) — `from_dom.ts:200-218`.

`normalizeLists` is `true` only when no `<ul>`/`<ol>` rule maps to a list node
that can directly nest itself; in that case `normalizeList` (line 808) reparents
nested `<ul>/<ol>` under the previous `<li>` to fix Word/Google-Docs HTML.

---

## 2. `DOMParser.fromSchema(schema)` — gathering rules

```ts
static fromSchema(schema: Schema) {
  return schema.cached.domParser as DOMParser ||
    (schema.cached.domParser = new DOMParser(schema, DOMParser.schemaRules(schema)))
}
```
— `from_dom.ts:311-314`.

The parser is cached per-schema in `schema.cached.domParser`. The interesting
work is in `schemaRules` (`from_dom.ts:278-306`):

```ts
function insert(rule) {
  let priority = rule.priority == null ? 50 : rule.priority, i = 0
  for (; i < result.length; i++) {
    let next = result[i], nextPriority = next.priority == null ? 50 : next.priority
    if (nextPriority < priority) break
  }
  result.splice(i, 0, rule)
}
for (let name in schema.marks) { ... insert(rule); rule.mark ??= name }
for (let name in schema.nodes) { ... insert(rule); rule.node ??= name }
```

Key points:

- **Stable insertion sort by descending priority.** Default priority is `50`.
  Rules with higher priority are tried first; equal priority preserves
  declaration order — `from_dom.ts:281-287`.
- **Marks are inserted before nodes.** Within equal priority, every mark rule
  ends up before every node rule because the loop processes `schema.marks`
  first. This is *critical* for nodes like `<a>` that some schemas treat as a
  link mark and others as a node — bumping the rule priority is the way to
  reorder.
- The shallow `copy(rule)` (`from_dom.ts:292,300,827`) means `getAttrs` results
  are stored back on the rule (`rule.attrs = result`) without poisoning the
  user's spec. **Beware:** that mutation is *not* threadsafe across parses; a
  re-entrant parse would clobber attrs. ProseMirror is single-threaded so it
  works.
- `rule.mark ??= name` / `rule.node ??= name` lets node/mark specs omit those
  fields in their `parseDOM`, since the field is implied by the spec it lives
  on.

---

## 3. `ParseRule` shape

Two flavors share `GenericParseRule`:

| Field | Tag rule | Style rule | Meaning |
|---|---|---|---|
| `priority` | ✓ | ✓ | Sort key, default 50 (`from_dom.ts:57-62`) |
| `consuming` | ✓ | ✓ | When `false`, parser keeps trying further rules after this one matches (`from_dom.ts:65-68`, used in `matchTag`'s `matchAfter` arg, `addElementByRule`'s `continueAfter`, `from_dom.ts:241,488,515,545,553`) |
| `context` | ✓ | ✓ | Selector like `"blockquote/paragraph/"`, `"section//"`, `"a|b/"`. Tested via `matchesContext`. Restricts rule to specific ancestor stacks (`from_dom.ts:71-81, 762-790`) |
| `mark` | ✓ | ✓ | Name of mark to apply (`from_dom.ts:83-84`) |
| `ignore` | ✓ | ✓ | Drop the matched element/style (`from_dom.ts:86-90`) |
| `closeParent` | ✓ | – | Pop one open node before processing (`from_dom.ts:92-94, 494`) |
| `skip` | ✓ | – | Drop wrapper but parse children (`from_dom.ts:96-98, 493-509`) |
| `attrs` | ✓ | ✓ | Static attrs (overridden by `getAttrs`) (`from_dom.ts:100-103`) |
| `tag` | ✓ | – | CSS selector, `dom.matches(rule.tag)` (`from_dom.ts:106-108, 243, 823`) |
| `namespace` | ✓ | – | `dom.namespaceURI === rule.namespace` (`from_dom.ts:110-112, 244`) |
| `node` | ✓ | – | NodeType name to create (`from_dom.ts:114-119`) |
| `getAttrs(el)` | ✓ | – | `Attrs \| false \| null` — `false` rejects (`from_dom.ts:121-126, 246-250`) |
| `contentElement` | ✓ | – | string/HTMLElement/fn — where to look for children (`from_dom.ts:128-134, 590-596`) |
| `getContent(dom, schema)` | ✓ | – | Override children with a precomputed Fragment (`from_dom.ts:136-139, 586-588`) |
| `preserveWhitespace` | ✓ | – | `false \| true \| "full"` per-rule (`from_dom.ts:141-146, 568, 675`) |
| `style` | – | ✓ | `"prop"` or `"prop=value"` (`from_dom.ts:151-159, 259-267`) |
| `clearMark(m)` | – | ✓ | Predicate: which existing marks to remove (`from_dom.ts:163-165, 549-550`) |
| `getAttrs(value)` | – | ✓ | Receives raw style string value (`from_dom.ts:167-169, 269`) |

`getNode` listed in the prompt does **not** exist in this file; the rule field
that overrides children is `getContent` (returns a `Fragment`).

---

## 4. Rule resolution

### 4.1 Tag rules (`matchTag`, `from_dom.ts:240-254`)

```ts
matchTag(dom, context, after?) {
  for (let i = after ? this.tags.indexOf(after) + 1 : 0; i < this.tags.length; i++) {
    let rule = this.tags[i]
    if (matches(dom, rule.tag) &&
        (rule.namespace === undefined || dom.namespaceURI == rule.namespace) &&
        (!rule.context || context.matchesContext(rule.context))) {
      if (rule.getAttrs) {
        let result = rule.getAttrs(dom)
        if (result === false) continue
        rule.attrs = result || undefined
      }
      return rule
    }
  }
}
```

Linear scan of `tags`. `after` lets `consuming: false` rules continue searching
*past* themselves on the next call.

### 4.2 Style rules (`matchStyle`, `from_dom.ts:257-275`)

```ts
if (style.indexOf(prop) != 0 ||                    // must start with prop
    rule.context && !context.matchesContext(rule.context) ||
    style.length > prop.length &&
    (style.charCodeAt(prop.length) != 61 /* = */ ||
     style.slice(prop.length + 1) != value))
  continue
```

Two-form match:
- `style: "font-weight"` — matches any value; receives the value in `getAttrs`.
- `style: "font-weight=bold"` — exact value match.

Note `style.indexOf(prop) != 0` allows `prop` to be a *prefix* of the rule's
style key, which is how the CSS-shorthand-vs-longhand thing is finessed.

### 4.3 Context constraint (`matchesContext`, `from_dom.ts:762-790`)

Quoted from source:

```ts
matchesContext(context) {
  if (context.indexOf("|") > -1)
    return context.split(/\s*\|\s*/).some(this.matchesContext, this)
  let parts = context.split("/")
  let option = this.options.context
  let useRoot = !this.isOpen && (!option || option.parent.type == this.nodes[0].type)
  let minDepth = -(option ? option.depth + 1 : 0) + (useRoot ? 0 : 1)
  let match = (i, depth) => {
    for (; i >= 0; i--) {
      let part = parts[i]
      if (part == "") {                            // "//" wildcard segment
        if (i == parts.length - 1 || i == 0) continue
        for (; depth >= minDepth; depth--)
          if (match(i - 1, depth)) return true
        return false
      } else {
        let next = depth > 0 || (depth == 0 && useRoot) ? this.nodes[depth].type
            : option && depth >= minDepth ? option.node(depth - minDepth).type
            : null
        if (!next || (next.name != part && !next.isInGroup(part))) return false
        depth--
      }
    }
    return true
  }
  return match(parts.length - 1, this.open)
}
```

- `"|"` separates alternatives.
- `"/"` separates ancestor names. Each name can be a node name OR a group name
  (`isInGroup`).
- An empty part (i.e. `"//"`) is the wildcard "any sequence of ancestors".
- If `options.context` (a `ResolvedPos`) is supplied, ancestors above the
  parser's own `topNode` are also matched against it — this is what makes
  context constraints work for `parseSlice` calls during paste, where the
  surrounding document matters.

---

## 5. `ParseContext` — the state machine

### 5.1 The stack

```
nodes: NodeContext[]    open: number = index of "current" frame
                        ↑ the frame parser writes to
```

`open` is **not always** `nodes.length - 1`: `closeExtra` can leave deeper
non-solid frames around in case the parser later wants to re-enter them
(`from_dom.ts:692-698`). That is unusual; usually `closeExtra` collapses
everything above `open` and pushes them as content into their parents.

```ts
class NodeContext {
  type: NodeType | null     // null only for the "fragment" root in parseSlice
  attrs: Attrs | null
  marks: readonly Mark[]    // marks the parser will set on the *node itself*
  solid: boolean            // true if this frame may not be silently closed
  match: ContentMatch | null  // current point in the type's content expression
  options: number           // bitfield: OPT_PRESERVE_WS | OPT_PRESERVE_WS_FULL | OPT_OPEN_LEFT
  content: Node[] = []
  activeMarks: readonly Mark[] = Mark.none
}
```
— `from_dom.ts:340-356`.

`solid` distinguishes user-introduced wrappers (always solid) from auto-inserted
wrappers (e.g. an auto-`paragraph` inserted because we needed inline content
inside something that requires a textblock — non-solid, can be closed eagerly).

### 5.2 Construction (`from_dom.ts:406-425`)

```ts
let topOptions = wsOptionsFor(null, options.preserveWhitespace, 0)
                | (isOpen ? OPT_OPEN_LEFT : 0)
if (topNode)              topContext = new NodeContext(topNode.type, topNode.attrs, Mark.none, true,
                                                        options.topMatch || topNode.type.contentMatch, topOptions)
else if (isOpen)          topContext = new NodeContext(null, null, Mark.none, true, null, topOptions)
else                      topContext = new NodeContext(parser.schema.topNodeType, null, Mark.none, true, null, topOptions)
this.nodes = [topContext]
```

- `topNode`: forces the resulting document's root to be that node type/attrs.
  Used for parsing into a specific `<doc>`, `<table_cell>` block, etc.
- `topMatch`: lets you pass an in-progress `ContentMatch` so partially-filled
  parents resume correctly.
- `topOpen`: when `true`, `finish()` doesn't pad the root with `fillBefore`
  required content — used when parsing a fragment that won't be auto-closed
  (`from_dom.ts:703`).
- `isOpen` (i.e. `parseSlice`): pushes a `null`-typed root frame, sets
  `OPT_OPEN_LEFT`, and finally returns a `Fragment` rather than a node.

### 5.3 The methods

#### `addDOM(dom, marks)` — dispatch (`from_dom.ts:434-437`)
```ts
if (dom.nodeType == 3) this.addTextNode(dom, marks)
else if (dom.nodeType == 1) this.addElement(dom, marks)
```
(Comments, processing instructions, etc. are silently skipped.)

#### `addTextNode(dom, marks)` — whitespace normalization (`from_dom.ts:439-477`)

```ts
let value = dom.nodeValue
let preserveWS = (top.options & OPT_PRESERVE_WS_FULL) ? "full"
  : this.localPreserveWS || (top.options & OPT_PRESERVE_WS) > 0
if (preserveWS === "full" || top.inlineContext(dom) || /[^ \t\r\n\u000c]/.test(value)) {
  if (!preserveWS) {
    value = value.replace(/[ \t\r\n\u000c]+/g, " ")
    // strip leading space if no node before, or after BR, or after WS-ending text
    if (/^[ \t\r\n\u000c]/.test(value) && this.open == this.nodes.length - 1) {
      let nodeBefore = top.content[top.content.length - 1]
      let domNodeBefore = dom.previousSibling
      if (!nodeBefore ||
          (domNodeBefore && domNodeBefore.nodeName == 'BR') ||
          (nodeBefore.isText && /[ \t\r\n\u000c]$/.test(nodeBefore.text)))
        value = value.slice(1)
    }
  } else if (preserveWS === "full") {
    value = value.replace(/\r\n?/g, "\n")
  } else if (schema.linebreakReplacement && /[\r\n]/.test(value) &&
             this.top.findWrapping(schema.linebreakReplacement.create())) {
    let lines = value.split(/\r?\n|\r/)
    for (let i = 0; i < lines.length; i++) {
      if (i) this.insertNode(schema.linebreakReplacement.create(), marks, true)
      if (lines[i]) this.insertNode(schema.text(lines[i]), marks, !/\S/.test(lines[i]))
    }
    value = ""
  } else {
    value = value.replace(/\r?\n|\r/g, " ")
  }
  if (value) this.insertNode(schema.text(value), marks, !/\S/.test(value))
  this.findInText(dom)
} else {
  this.findInside(dom)
}
```

Three modes:

| Mode | Trigger | Behavior |
|---|---|---|
| **collapsed** (default) | no `OPT_PRESERVE_WS` | `[ \t\r\n\u000c]+` → single space; leading WS stripped if `nodeBefore` is whitespace, BR, or absent |
| **`true`** | `OPT_PRESERVE_WS` | newlines kept; if schema has a `linebreakReplacement` node (e.g. hard_break), each `\r?\n` becomes one of those, otherwise `\r?\n` → space |
| **`"full"`** | `OPT_PRESERVE_WS_FULL` | only `\r\n?` → `\n` normalization; everything else literal |

**Trailing trim** happens later in `NodeContext.finish` (line 378-385):

```ts
if (!(this.options & OPT_PRESERVE_WS)) {
  let last = this.content[this.content.length - 1], m
  if (last && last.isText && (m = /[ \t\r\n\u000c]+$/.exec(last.text))) {
    let text = last as TextNode
    if (last.text.length == m[0].length) this.content.pop()
    else this.content[this.content.length - 1] = text.withText(text.text.slice(0, -m[0].length))
  }
}
```

`localPreserveWS` (line 482-484) is set when entering `<pre>` or any element
with `style="white-space: pre"`, propagating preserve-ws downward without
mutating ancestor frame options. `sync()` (line 706-716) OR-folds it into
ancestor `options` if we ever sync back through them while still preserving.

#### `addElement(dom, marks, matchAfter?)` (`from_dom.ts:481-518`)

Pseudocode:

```
1. localPreserveWS ← true if PRE or white-space: pre on element
2. if (UL/OL) and normalizeLists → normalizeList(dom)   [reparent nested lists into li]
3. rule = options.ruleFromNode?.(dom) || matchTag(dom, this, matchAfter)
4. if rule.ignore (or no rule and tag is in ignoreTags head/script/style/...):
       ignoreFallback(dom, marks)
   else if !rule || rule.skip || rule.closeParent:
       if closeParent → open = max(0, open-1)
       if blockTags[name]:
           if top has inline content and we're in a non-root open frame, pop one
           sync = true; if !top.type → needsBlock = true
       else if !dom.firstChild:
           leafFallback(dom, marks); break
       innerMarks = rule?.skip ? marks : readStyles(dom, marks)
       if innerMarks: addAll(dom, innerMarks)
       if sync: sync(top)
   else:
       innerMarks = readStyles(dom, marks)
       if innerMarks:
           addElementByRule(dom, rule, innerMarks,
                            rule.consuming === false ? ruleID : undefined)
```

Note the special case **inline-content cascade** in the `!rule || skip` branch:
when we encounter a block tag inside a frame whose first content is inline, we
pop one open level so the new block doesn't end up nested in an
auto-paragraph. That's how `<p>foo<div>bar</div></p>` gets unzipped.

`leafFallback` (line 521-524) maps a stray `<br>` to a literal `\n` text node
*if* the current frame allows inline content. This is what handles
non-textblock `<br>`s inside e.g. a `<div>` that is going to become a paragraph.

`ignoreFallback` (line 527-531) handles `<br>` inside an ignored container by
faking a placeholder text insert so positions track.

#### `readStyles(dom, marks)` (`from_dom.ts:536-558`)

Iterates `parser.matchedStyles` (only those declared by rules), reads
`style.getPropertyValue(name)`, and for each non-empty value walks
`matchStyle` until exhaustion (`consuming: false` continues with `after = rule`).
A rule with `ignore: true` short-circuits and **returns `null`** — telling the
caller to drop the entire element including children.

`clearMark` rules filter the active mark set; otherwise the rule's mark is
appended via `marks.concat(...)`. This is how e.g. `font-weight: 400` can
*remove* a `strong` mark inserted by a parent `<b>`.

#### `addElementByRule(dom, rule, marks, continueAfter?)` (`from_dom.ts:563-599`)

```
if rule.node:
    type = nodes[rule.node]
    if !type.isLeaf: enter(type, attrs, marks, preserveWS) ⇒ inner marks
    else:            insertNode(type.create(attrs), ...) or leafFallback
else: marks = marks ⊕ markType.create(rule.attrs)

if leaf: findInside(dom)
else if continueAfter: addElement(dom, marks, continueAfter)   // re-run matchTag
else if rule.getContent: insertNode(... for n in rule.getContent(dom, schema))
else:
    contentDOM =
        typeof rule.contentElement == "string"   ? dom.querySelector(...)
      : typeof rule.contentElement == "function" ? rule.contentElement(dom)
      : rule.contentElement                       ?? dom
    findAround(dom, contentDOM, true)
    addAll(contentDOM, marks)
    findAround(dom, contentDOM, false)

if synced inner: open--
```

`findAround/findInside/findAtPoint/findInText` (lines 730-759) implement
`options.findPositions` — a cute side channel where the caller hands in DOM
points and gets ProseMirror positions back, used by `prosemirror-view`'s
selection-restoration after a re-render.

#### `findPlace(node, marks, cautious)` — auto-wrapping (`from_dom.ts:618-638`)

**This is the core wrap-finding loop.** Quoted verbatim:

```ts
findPlace(node, marks, cautious) {
  let route, sync
  for (let depth = this.open, penalty = 0; depth >= 0; depth--) {
    let cx = this.nodes[depth]
    let found = cx.findWrapping(node)
    if (found && (!route || route.length > found.length + penalty)) {
      route = found
      sync = cx
      if (!found.length) break
    }
    if (cx.solid) {
      if (cautious) break
      penalty += 2
    }
  }
  if (!route) return null
  this.sync(sync)
  for (let i = 0; i < route.length; i++)
    marks = this.enterInner(route[i], null, marks, false)
  return marks
}
```

Walking from the deepest frame outward, it picks the **shortest wrapping
route** (tie-broken with a `+2` penalty per solid frame crossed) that lets
`node` fit. `cautious=true` (used for whitespace inserts and many leaf inserts)
forbids climbing past a solid frame at all. If a route is found, we sync to
that frame (popping intermediate non-solid contexts) and `enterInner` each
wrapper as a non-solid frame.

`NodeContext.findWrapping` (`from_dom.ts:358-375`) is a three-step cascade:

```ts
findWrapping(node) {
  if (!this.match) {
    if (!this.type) return []
    let fill = this.type.contentMatch.fillBefore(Fragment.from(node))
    if (fill) {
      this.match = this.type.contentMatch.matchFragment(fill)
    } else {
      let start = this.type.contentMatch, wrap
      if (wrap = start.findWrapping(node.type)) {
        this.match = start
        return wrap
      } else {
        return null
      }
    }
  }
  return this.match.findWrapping(node.type)
}
```

The `!this.match` branch handles `OPT_OPEN_LEFT` frames where we hadn't yet
materialized a `ContentMatch`: we first try `fillBefore` (insert any
mandatorily-required content, e.g. a leading `paragraph` in a `blockquote`),
fall back to a wrapping path, else give up.

#### `insertNode(node, marks, cautious)` (`from_dom.ts:641-659`)

```
if node.isInline && needsBlock && !top.type:
    block = textblockFromContext()
    if block: marks = enterInner(block, null, marks)
innerMarks = findPlace(node, marks, cautious)
if !innerMarks: return false
closeExtra()
top = this.top
if top.match: top.match = top.match.matchType(node.type)
nodeMarks = filter `innerMarks ⊕ node.marks` to those allowed by top
top.content.push(node.mark(nodeMarks))
```

The `needsBlock` path is the auto-paragraph: inline content seen at the
fragment root in `parseSlice` triggers wrapping in the schema's default
textblock (chosen by `textblockFromContext`, line 792-802).

Mark filtering (`top.type.allowsMarkType` or `markMayApply`, lines 836-851)
drops marks that the schema forbids in this position — e.g. `code` mark on a
`heading` if the heading disallows it.

#### `enter` / `enterInner` / `closeExtra` / `closeNode`

- `enter(type, attrs, marks, preserveWS)` — `findPlace` first to find the
  wrapping route to make `type` fit, then `enterInner` (`from_dom.ts:663-667`).
- `enterInner` pushes a new `NodeContext`, splits marks into "applied to this
  node itself" vs "passed to children" (`from_dom.ts:670-688`).
- `closeExtra(openEnd=false)` finalizes frames above `this.open` by
  `finish()`-ing them and pushing the result into their parent's content
  (`from_dom.ts:692-698`). When `openEnd` is true, `NodeContext.finish` skips
  the "pad with `fillBefore(Fragment.empty, true)`" step.
- The prompt's "`closeNode`" corresponds to `closeExtra` plus
  `NodeContext.finish` (line 377-390).

#### `finish()` (`from_dom.ts:700-704`)

```ts
finish() {
  this.open = 0
  this.closeExtra(this.isOpen)
  return this.nodes[0].finish(!!(this.isOpen || this.options.topOpen))
}
```

Forces `open` to root, closes all stacked frames (open-ended if `parseSlice`),
then asks the root frame to materialize. For `parseSlice` the root has
`type=null` so `finish` returns a `Fragment`; otherwise a `Node`.

---

## 6. Public API

### 6.1 `parser.parse(dom, options) : Node`

```ts
parse(dom, options = {}) {
  let context = new ParseContext(this, options, /*isOpen=*/false)
  context.addAll(dom, Mark.none, options.from, options.to)
  return context.finish() as Node
}
```
— `from_dom.ts:221-225`. The result is a complete document and any unmet
`ContentMatch.fillBefore(Fragment.empty, true)` requirements get filled with
default content (think: empty `<p>` inserted at end of a `blockquote` that
must end with a textblock).

### 6.2 `parser.parseSlice(dom, options) : Slice`

```ts
parseSlice(dom, options = {}) {
  let context = new ParseContext(this, options, /*isOpen=*/true)
  context.addAll(dom, Mark.none, options.from, options.to)
  return Slice.maxOpen(context.finish() as Fragment)
}
```
— `from_dom.ts:233-237`. The output is a `Slice` with `Slice.maxOpen` chosen
open depth, ready for `Transform.replace`. `OPT_OPEN_LEFT` keeps the leftmost
spine "non-matched", letting paste re-attach to the surrounding context.

### 6.3 `ParseOptions`

| Option | Effect |
|---|---|
| `preserveWhitespace: false \| true \| "full"` | Initial root-frame WS mode (`from_dom.ts:14-18, 414`) |
| `findPositions[]` | Hand DOM points in, get pos out (`from_dom.ts:20-25, 423`) |
| `from`, `to` | Subrange of `parent.childNodes` (`from_dom.ts:27-31, 605-608`) |
| `topNode` | Force root to be this `Node`'s type+attrs (`from_dom.ts:33-37, 415-417`) |
| `topMatch` | Resume parsing at a partial `ContentMatch` (`from_dom.ts:39-41, 417`) |
| `context: ResolvedPos` | Extra ancestor stack used by `matchesContext` (`from_dom.ts:43-46, 768-790`) |
| `topOpen` *(internal)* | Don't fill end of root with required content (`from_dom.ts:51, 703`) |
| `ruleFromNode` *(internal)* | Per-DOM-node rule override, beats `matchTag` (`from_dom.ts:49, 487`) |

---

## 7. Pitfalls

1. **Ambiguous content** — if two rules match the same tag with the same
   priority, declaration order wins. For nodes overlaid with marks (`<a>` is
   often both), the *mark* rule wins because of the marks-first iteration in
   `schemaRules`. To force node interpretation, set `priority > 50`.
2. **Marks on block boundaries** — `serializeFragment` (in `to_dom.ts`) cannot
   span a mark across two block siblings without `spanning: true`. The parser
   side has the inverse pitfall: a `<b>` containing `<p>foo</p><p>bar</p>` ends
   up with `strong` applied inside each paragraph, not on the paragraphs
   themselves, because `readStyles`/marks always travel with inline content.
3. **Browser `<meta>` from clipboard** — Word, Safari, etc. paste as
   `<meta charset>...`. `<meta>` is not in `blockTags`, has no rule, and falls
   through `addElement`'s `!rule || skip` branch as a "leaf" (no `firstChild`),
   firing `leafFallback` which only handles `BR`. The element therefore
   contributes nothing — fine — but any sibling text loses its leading-space
   strip context. Most editors strip `<meta>`/`<style>` upstream.
4. **Browser-inserted `<br>`** — Chromium emits `<br>` at the end of empty
   contenteditable blocks. A trailing `<br>` inside a paragraph becomes a `\n`
   via `leafFallback`, but in collapsed-whitespace mode the `\n` is then
   normalized to a space and trimmed by `NodeContext.finish` — net zero.
   Inside `<pre>`-flavored blocks it survives, which is correct.
5. **`closeParent` + `consuming: false`** — combining these can pop the parent
   then re-enter on the next tag-rule iteration; harmless but easy to
   misdesign.
6. **`copy(rule)` + `rule.attrs = result`** — see §2; not reentrant.
7. **`normalizeLists`** mutates the input DOM (reparents `<ul>`/`<ol>` under
   prior `<li>`). If you parse the same DOM twice, the second parse sees the
   already-normalized structure.

---

## 8. End-to-end paste trace: DOM → Slice → Doc

Suppose the user has the document:

```
doc
└── paragraph "Hello |"            ← cursor at |
```

…and pastes `<b>foo</b><p>bar</p>`. Browser delivers a clipboard
`DocumentFragment` containing a `<meta>`, a `<b>foo</b>`, and a `<p>bar</p>`.

```
                  ┌─────────────────────────────────────┐
                  │  Clipboard DOM                      │
                  │  <fragment>                         │
                  │    <meta charset="utf-8">           │
                  │    <b>foo</b>                       │
                  │    <p>bar</p>                       │
                  │  </fragment>                        │
                  └────────────────┬────────────────────┘
                                   │
                                   ▼  parser.parseSlice(dom, {context: $cursor})
                  ┌─────────────────────────────────────┐
                  │  ParseContext (isOpen=true)         │
                  │  nodes = [ NC(null, OPEN_LEFT) ]    │
                  │  open = 0                            │
                  └────────────────┬────────────────────┘
                                   │
   addAll iterates fragment.childNodes:
                                   │
   <meta>      → addElement → no rule, no firstChild → leafFallback (not BR) → noop
                                   │
   <b>foo</b>  → addElement
                  rule = strongRule (mark=strong)        ← from `[strong].parseDOM`
                  innerMarks = readStyles(...) ⊕ strong = [strong]
                  addElementByRule:
                    rule has `mark`, no `node`           → enter mark only
                    contentDOM = <b>; addAll:
                       text "foo" → addTextNode
                          collapsed mode (no PRE)
                          insertNode(text("foo"), [strong], cautious=false)
                            findPlace:
                              top is NC(null, OPEN_LEFT)
                              top.match == null
                              top.findWrapping(text):
                                no type → return [] (empty wrap, the open-left frame swallows it)
                              ⇒ route = []; sync(top); innerMarks = [strong]
                            closeExtra(); top.content.push(text("foo", strong))
                                   │
   <p>bar</p>  → addElement
                  rule = paragraphRule (node=paragraph)
                  addElementByRule:
                    enter(paragraph, null, [], false)
                      findPlace:
                        top is NC(null, OPEN_LEFT) with content=[text("foo")]
                        top.findWrapping(paragraph) = []     (open-left)
                      enterInner pushes NC(paragraph, solid=true)
                    addAll: text "bar" → insertNode(text("bar"), [], false)
                      findPlace within paragraph → []
                      top.content.push(text("bar"))
                    closeExtra at end of element pops paragraph back into root content
                                   │
                                   ▼  finish() with isOpen=true
                  ┌─────────────────────────────────────┐
                  │  Fragment                            │
                  │  [ text("foo", marks:[strong]),     │
                  │    paragraph(text("bar")) ]          │
                  └────────────────┬────────────────────┘
                                   │
                                   ▼  Slice.maxOpen(fragment)
                  ┌─────────────────────────────────────┐
                  │  Slice {                             │
                  │    content: <as above>,              │
                  │    openStart: 0,    // root null     │
                  │    openEnd:   1,    // paragraph     │
                  │  }                                   │
                  └────────────────┬────────────────────┘
                                   │
                                   ▼  tr.replaceSelection(slice)
                  ┌─────────────────────────────────────┐
                  │  doc                                 │
                  │  ├── paragraph "Hello foo"           │  ← inline foo merged
                  │  └── paragraph "bar"                 │  ← block split
                  └─────────────────────────────────────┘
```

The two key bits are:

- **`OPT_OPEN_LEFT` on the root** — lets the bare inline `text("foo")` live at
  the root of the fragment with no synthetic paragraph wrapper, so when the
  slice is replaced it merges with the existing paragraph at the cursor.
- **`Slice.maxOpen`** — auto-detects how many levels of `openStart`/`openEnd`
  are valid given the schema (e.g. text inside paragraph: openStart=1,
  openEnd=1; here `openStart=0` because the root frame is null-typed).

If we instead called `parser.parse(dom)` (`isOpen=false`), the open-left flag
would be absent and `findPlace(text("foo"))` would auto-wrap via
`textblockFromContext()`, producing two paragraphs — ideal for "open this HTML
as a document" but wrong for paste merging.
