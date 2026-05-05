# ProseMirror Schema and Content Expressions — In Depth

> Source: `prosemirror-model/src/{schema,content}.ts` (with cross-refs into `node.ts`, `mark.ts`, `fragment.ts`).
> All citations below use the form `prosemirror-model/src/<file>:<line>`.
> Companion: `02-document-model.md` covers the runtime tree (`Node`, `Fragment`, `Mark`, `Slice`).

The **schema** is what gives a ProseMirror document its types. It's a runtime, declarative description of:

* what kinds of nodes can exist,
* what marks they can carry,
* what each node may contain (a regex-like content expression),
* how nodes/marks serialize to and parse from the DOM.

This file covers the schema layer end-to-end: the spec language, the compilation pipeline, and the NFA/DFA-backed `ContentMatch` engine that powers every structural validity check and most transform-layer searches.

---

## 1. The `SchemaSpec`

`prosemirror-model/src/schema.ts:351-369`:

```ts
export interface SchemaSpec<Nodes extends string = any, Marks extends string = any> {
  nodes: {[name in Nodes]: NodeSpec} | OrderedMap<NodeSpec>,
  marks?: {[name in Marks]: MarkSpec} | OrderedMap<MarkSpec>,
  topNode?: string
}
```

Three top-level properties:

* `nodes` — an `OrderedMap<NodeSpec>` (or a plain object that gets converted). **Order matters.** It determines:
  * Which `parseDOM` rules win when multiple match (later-declared types break ties unless they specify `priority`).
  * Which type comes first when a content expression names a *group* (e.g. `"block"`).
  * Which type is treated as the "default" (used by `ContentMatch.defaultType`, see §6.5).
* `marks` — an `OrderedMap<MarkSpec>`. The order assigns each mark type a numeric **rank** (`prosemirror-model/src/schema.ts:316-317`), which is the canonical sort order used by `Mark.addToSet`/`setFrom`.
* `topNode` — defaults to `"doc"`. Used by `prosemirror-state` when constructing a new editor from the schema.

The `Schema` constructor immediately wraps `spec.nodes`/`spec.marks` in `OrderedMap.from` (`prosemirror-model/src/schema.ts:599-600`):

```ts
instanceSpec.nodes = OrderedMap.from(spec.nodes),
instanceSpec.marks = OrderedMap.from(spec.marks || {}),
```

Why `OrderedMap`? Plain JS objects don’t guarantee iteration order across exotic key shapes, and the schema-extension idiom (`schema.spec.nodes.append({...}).update(name, spec)…`) wants insertion-order semantics with cheap copies. `OrderedMap` is the (separate) `marijnh/orderedmap` package — a tiny immutable list-of-pairs data structure.

---

## 2. `NodeSpec` Fields

`prosemirror-model/src/schema.ts:371-491`. Every field is optional unless noted; defaults apply when omitted.

| Field | Type | Meaning |
|---|---|---|
| `content` | `string` | A content expression (see §4). When omitted, the node allows no content (it’s a leaf). |
| `marks` | `string` | Space-separated mark names/groups, `"_"` for "all marks", or `""` for "no marks". When omitted, inline-content nodes default to allowing all marks; others default to none. |
| `group` | `string` | Space-separated group names this node belongs to. Groups are referenced from content expressions. |
| `inline` | `boolean` | True for inline nodes. The `text` type is implicitly inline. |
| `atom` | `boolean` | If true, the node is treated as a single editable unit even if it has content. |
| `attrs` | `{[name]: AttributeSpec}` | Per-attribute spec, with optional `default` and `validate`. |
| `selectable`, `draggable` | `boolean` | View-layer behavior hints. |
| `code` | `boolean` | "This node contains code." Used by commands; also defaults `whitespace` to `"pre"`. |
| `whitespace` | `"pre" \| "normal"` | Controls DOM-parser whitespace handling. |
| `definingAsContext` | `boolean` | When pasting *into* this node, prefer to keep it as the surrounding context. |
| `definingForContent` | `boolean` | When pasting *content from* this node, preserve it as a wrapping. |
| `defining` | `boolean` | Shortcut: enables both above. |
| `isolating` | `boolean` | Editing operations like backspace/lift won't cross this node's boundaries. Used by `Slice.maxOpen`. |
| `toDOM` | `(node) => DOMOutputSpec` | Serializer to DOM. |
| `parseDOM` | `readonly TagParseRule[]` | Parser rules. |
| `toDebugString` | `(node) => string` | Override for `Node#toString()`. |
| `leafText` | `(node) => string` | Override for `Node#textContent` on leaves. |
| `linebreakReplacement` | `boolean` | Marks this inline leaf as the schema's "newline equivalent". |
| `[key: string]: any` | — | Open-ended; available via `nodeType.spec.<key>`. |

A canonical example from `prosemirror-schema-basic`:

```ts
paragraph: {
  content: "inline*",
  group: "block",
  parseDOM: [{tag: "p"}],
  toDOM() { return ["p", 0] }
}

heading: {
  attrs: {level: {default: 1, validate: "number"}},
  content: "inline*",
  group: "block",
  defining: true,
  parseDOM: [{tag: "h1", attrs: {level: 1}}, /* ... */],
  toDOM(node) { return ["h" + node.attrs.level, 0] }
}

code_block: {
  content: "text*",
  marks: "",                      // disallow all marks
  group: "block",
  code: true,
  defining: true,
  parseDOM: [{tag: "pre", preserveWhitespace: "full"}],
  toDOM() { return ["pre", ["code", 0]] }
}
```

Notice:

* `content: "inline*"` — paragraph has inline-content (it's a *textblock*).
* `marks: ""` on `code_block` — it’s textual but disallows all marks.
* `defining: true` — paste preserves the heading wrapping.

### 2.1 `MarkSpec` Fields

`prosemirror-model/src/schema.ts:494-544`:

| Field | Default | Meaning |
|---|---|---|
| `attrs` | none | Same shape as nodes. |
| `inclusive` | `true` | Whether typing past the end of a marked range continues the mark. View/state-layer concern; the model doesn’t branch on this. |
| `excludes` | `null` (= self) | Space-separated mark names/groups, `"_"` for "all marks", `""` for "none". See §3.5 of `02-document-model.md`. |
| `group` | none | Mark groups for use in `NodeSpec.marks` and other `excludes` lists. |
| `spanning` | `true` | Whether the rendered DOM may span multiple adjacent inline nodes. |
| `code` | `false` | "Marks code"; commands may treat differently. |
| `toDOM`, `parseDOM` | — | Same role as on `NodeSpec`. |
| `[key: string]: any` | — | Open-ended. |

### 2.2 `AttributeSpec`

`prosemirror-model/src/schema.ts:548-563`:

```ts
export interface AttributeSpec {
  default?: any
  validate?: string | ((value: any) => void)
}
```

* `default` is what makes an attr **optional**. Attrs without a `default` are *required*: they must be supplied at node-creation time and at JSON-deserialize time.
* `validate` accepts:
  * a string of `|`-separated primitive type names (`"number|null"`, `"string"`, etc.), validated by `validateType` (`prosemirror-model/src/schema.ts:249-255`):
    ```ts
    function validateType(typeName, attrName, type) {
      let types = type.split("|")
      return (value) => {
        let name = value === null ? "null" : typeof value
        if (types.indexOf(name) < 0) throw new RangeError(...)
      }
    }
    ```
  * or a function that throws on invalid values.

The `Attribute` class (`prosemirror-model/src/schema.ts:259-273`) wraps a spec:

```ts
class Attribute {
  hasDefault: boolean
  default: any
  validate: undefined | ((value: any) => void)
  constructor(typeName, attrName, options) {
    this.hasDefault = Object.prototype.hasOwnProperty.call(options, "default")
    this.default = options.default
    this.validate = typeof options.validate == "string"
      ? validateType(typeName, attrName, options.validate)
      : options.validate
  }
  get isRequired() { return !this.hasDefault }
}
```

And `defaultAttrs(attrs)` (lines 17-25) precomputes a single shared default-attrs object iff every attr has a default — that shared object then becomes `NodeType.defaultAttrs`, which `Node.copy(...)` and bare `nodeType.create()` reuse without allocation.

---

## 3. Schema Compilation Pipeline

`prosemirror-model/src/schema.ts:596-631` is the heart of the compiler:

```ts
constructor(spec: SchemaSpec<Nodes, Marks>) {
  let instanceSpec = this.spec = {} as any
  for (let prop in spec) instanceSpec[prop] = (spec as any)[prop]
  instanceSpec.nodes = OrderedMap.from(spec.nodes),
  instanceSpec.marks = OrderedMap.from(spec.marks || {}),

  this.nodes = NodeType.compile(this.spec.nodes, this)
  this.marks = MarkType.compile(this.spec.marks, this)

  let contentExprCache = Object.create(null)
  for (let prop in this.nodes) {
    if (prop in this.marks)
      throw new RangeError(prop + " can not be both a node and a mark")
    let type = this.nodes[prop], contentExpr = type.spec.content || "", markExpr = type.spec.marks
    type.contentMatch = contentExprCache[contentExpr] ||
      (contentExprCache[contentExpr] = ContentMatch.parse(contentExpr, this.nodes))
    ;(type as any).inlineContent = type.contentMatch.inlineContent
    if (type.spec.linebreakReplacement) {
      if (this.linebreakReplacement) throw new RangeError("Multiple linebreak nodes defined")
      if (!type.isInline || !type.isLeaf) throw new RangeError("Linebreak replacement nodes must be inline leaf nodes")
      this.linebreakReplacement = type
    }
    type.markSet = markExpr == "_" ? null :
      markExpr ? gatherMarks(this, markExpr.split(" ")) :
      markExpr == "" || !type.inlineContent ? [] : null
  }
  for (let prop in this.marks) {
    let type = this.marks[prop], excl = type.spec.excludes
    type.excluded = excl == null ? [type] : excl == "" ? [] : gatherMarks(this, excl.split(" "))
  }

  this.nodeFromJSON = json => Node.fromJSON(this, json)
  this.markFromJSON = json => Mark.fromJSON(this, json)
  this.topNodeType = this.nodes[this.spec.topNode || "doc"]
  this.cached.wrappings = Object.create(null)
}
```

The pipeline, in stages:

```
            ┌────────────────────────────────────┐
            │ SchemaSpec (user-supplied)         │
            │  nodes, marks, topNode             │
            └────────────────┬───────────────────┘
                             │  OrderedMap.from
                             ▼
            ┌────────────────────────────────────┐
            │ this.spec = {nodes, marks, topNode}│
            └────────────────┬───────────────────┘
                             │  NodeType.compile, MarkType.compile
                             ▼
            ┌────────────────────────────────────┐
            │ this.nodes : {name -> NodeType}    │
            │ this.marks : {name -> MarkType}    │
            │  - groups parsed (split " ")       │
            │  - attrs initAttrs'd               │
            │  - defaultAttrs precomputed        │
            │  - rank assigned (mark order)      │
            │  - mark.instance pre-cached        │
            └────────────────┬───────────────────┘
                             │  for each NodeType:
                             │    parse content expr → ContentMatch
                             │    cache by raw expression string
                             ▼
            ┌────────────────────────────────────┐
            │ NodeType.contentMatch  (DFA root)  │
            │ NodeType.inlineContent (boolean)   │
            └────────────────┬───────────────────┘
                             │  resolve marks: markSet
                             │   "_" -> null  (allow all)
                             │   ""   -> []
                             │   list -> gatherMarks(...)
                             │   else: inlineContent? null : []
                             ▼
            ┌────────────────────────────────────┐
            │ NodeType.markSet                   │
            └────────────────┬───────────────────┘
                             │  resolve excludes per MarkType
                             ▼
            ┌────────────────────────────────────┐
            │ MarkType.excluded (resolved list)  │
            └────────────────┬───────────────────┘
                             ▼
            ┌────────────────────────────────────┐
            │ topNodeType, JSON helpers, cache   │
            └────────────────────────────────────┘
```

### 3.1 `NodeType.compile`

`prosemirror-model/src/schema.ts:236-246`:

```ts
static compile<Nodes extends string>(nodes: OrderedMap<NodeSpec>, schema: Schema<Nodes>): {readonly [name in Nodes]: NodeType} {
  let result = Object.create(null)
  nodes.forEach((name, spec) => result[name] = new NodeType(name, schema, spec))

  let topType = schema.spec.topNode || "doc"
  if (!result[topType]) throw new RangeError("Schema is missing its top node type ('" + topType + "')")
  if (!result.text) throw new RangeError("Every schema needs a 'text' type")
  for (let _ in result.text.attrs) throw new RangeError("The text node type should not have attributes")

  return result
}
```

Three hard requirements every schema must satisfy:

1. The configured `topNode` (default `"doc"`) must exist.
2. A `"text"` node type must exist.
3. The `text` type must declare no attributes.

The `NodeType` constructor (`prosemirror-model/src/schema.ts:69-87`) initializes:

```ts
this.groups = spec.group ? spec.group.split(" ") : []
this.attrs = initAttrs(name, spec.attrs)
this.defaultAttrs = defaultAttrs(this.attrs)

;(this as any).contentMatch = null     // filled in later
;(this as any).inlineContent = null    // filled in later

this.isBlock = !(spec.inline || name == "text")
this.isText = name == "text"
```

`contentMatch` and `inlineContent` are deliberately deferred. They can’t be resolved until *all* node types exist, because a content expression like `"block+"` references types by name (or group). So the constructor leaves them null and the schema constructor fills them in a second pass.

### 3.2 `MarkType.compile`

`prosemirror-model/src/schema.ts:315-319`:

```ts
static compile(marks: OrderedMap<MarkSpec>, schema: Schema) {
  let result = Object.create(null), rank = 0
  marks.forEach((name, spec) => result[name] = new MarkType(name, rank++, schema, spec))
  return result
}
```

`rank` is the mark-set sort order. Lower rank → earlier in the `addToSet` output. Because the user controls declaration order, they control mark "z-order" in JSON output and DOM rendering.

The `MarkType` constructor (`prosemirror-model/src/schema.ts:290-304`) precomputes a singleton instance when no required attrs exist:

```ts
this.attrs = initAttrs(name, spec.attrs)
;(this as any).excluded = null
let defaults = defaultAttrs(this.attrs)
this.instance = defaults ? new Mark(this, defaults) : null
```

Then `MarkType.create(null)` returns the cached singleton (`schema.ts:309-312`):

```ts
create(attrs: Attrs | null = null) {
  if (!attrs && this.instance) return this.instance
  return new Mark(this, computeAttrs(this.attrs, attrs))
}
```

So every `<strong>` mark in a document is *the same object* — saves a lot of allocation and makes `Mark.eq` fast (identity short-circuit).

### 3.3 Resolving `markSet`

After all `NodeType`s are compiled, `markSet` is resolved per-type:

```ts
type.markSet = markExpr == "_" ? null :
  markExpr ? gatherMarks(this, markExpr.split(" ")) :
  markExpr == "" || !type.inlineContent ? [] : null
```

| `marks` field | `markSet` value | Meaning |
|---|---|---|
| `"_"` | `null` | All marks allowed (sentinel: `null` means unrestricted) |
| `"strong em link"` | `[strongType, emType, linkType]` | Only those |
| `"_inline"` (a group) | resolved via `gatherMarks` | Group expansion |
| `""` | `[]` | No marks allowed |
| omitted, inline content | `null` | All marks allowed (textblocks default to permissive) |
| omitted, no inline content | `[]` | No marks allowed (block-only nodes) |

`gatherMarks` (`prosemirror-model/src/schema.ts:689-705`) handles names and groups:

```ts
function gatherMarks(schema: Schema, marks: readonly string[]) {
  let found: MarkType[] = []
  for (let i = 0; i < marks.length; i++) {
    let name = marks[i], mark = schema.marks[name], ok = mark
    if (mark) {
      found.push(mark)
    } else {
      for (let prop in schema.marks) {
        let mark = schema.marks[prop]
        if (name == "_" || (mark.spec.group && mark.spec.group.split(" ").indexOf(name) > -1))
          found.push(ok = mark)
      }
    }
    if (!ok) throw new SyntaxError("Unknown mark type: '" + marks[i] + "'")
  }
  return found
}
```

So `marks: "inline_format"` resolves to every mark whose `group` includes `"inline_format"`. `"_"` matches all marks.

`NodeType.allowsMarkType` / `allowsMarks` (`prosemirror-model/src/schema.ts:209-219`) consult `markSet`:

```ts
allowsMarkType(markType) {
  return this.markSet == null || this.markSet.indexOf(markType) > -1
}
allowsMarks(marks) {
  if (this.markSet == null) return true
  for (let i = 0; i < marks.length; i++) if (!this.allowsMarkType(marks[i].type)) return false
  return true
}
allowedMarks(marks) {
  if (this.markSet == null) return marks
  let copy
  for (let i = 0; i < marks.length; i++) {
    if (!this.allowsMarkType(marks[i].type)) {
      if (!copy) copy = marks.slice(0, i)
    } else if (copy) {
      copy.push(marks[i])
    }
  }
  return !copy ? marks : copy.length ? copy : Mark.none
}
```

`allowedMarks` is the "filter to legal subset" routine used by transforms when content is moved between nodes with different mark policies.

### 3.4 Resolving `excludes`

`prosemirror-model/src/schema.ts:622-625`:

```ts
for (let prop in this.marks) {
  let type = this.marks[prop], excl = type.spec.excludes
  type.excluded = excl == null ? [type] : excl == "" ? [] : gatherMarks(this, excl.split(" "))
}
```

Same `gatherMarks` machinery. `excludes` defaults to `[type]` (mark excludes itself — only one of each type allowed on a given inline node).

### 3.5 Content-expression caching

```ts
let contentExprCache = Object.create(null)
for (let prop in this.nodes) {
  …
  type.contentMatch = contentExprCache[contentExpr] ||
    (contentExprCache[contentExpr] = ContentMatch.parse(contentExpr, this.nodes))
  …
}
```

Many node types share the same expression string (e.g. all textblocks have `content: "inline*"`). The cache makes them share the same compiled DFA — so `paragraph.contentMatch === heading.contentMatch` in `prosemirror-schema-basic`.

---

## 4. The Content Expression Mini-Language

`prosemirror-model/src/content.ts:169-274`. The grammar, in roughly EBNF form:

```
expr        ::= seq ('|' seq)*               # alternation (choice)
seq         ::= subscript+                   # juxtaposition (concatenation)
subscript   ::= atom ( '+' | '*' | '?' | range )*
range       ::= '{' NUM ( ',' NUM? )? '}'
atom        ::= '(' expr ')'                 # grouping
              | NAME                         # node type or group reference
```

Token examples:

```
""                  empty (no content)
"text*"             zero or more text nodes
"text+"             one or more text nodes
"inline*"           zero or more nodes from the "inline" group (or named "inline")
"paragraph block*"  one paragraph, then any blocks
"(heading | paragraph)+"   one or more, each heading-or-paragraph
"text{1,5}"         one to five text nodes
"text{3}"           exactly three text nodes
"text{1,}"          one or more (same as text+ but explicit)
"image | text"      a single image or a single text node
```

### 4.1 The tokenizer

`prosemirror-model/src/content.ts:169-188`:

```ts
class TokenStream {
  inline: boolean | null = null
  pos = 0
  tokens: string[]
  constructor(readonly string: string, readonly nodeTypes) {
    this.tokens = string.split(/\s*(?=\b|\W|$)/)
    if (this.tokens[this.tokens.length - 1] == "") this.tokens.pop()
    if (this.tokens[0] == "") this.tokens.shift()
  }
  get next() { return this.tokens[this.pos] }
  eat(tok: string) { return this.next == tok && (this.pos++ || true) }
  err(str: string): never { throw new SyntaxError(str + " (in content expression '" + this.string + "')") }
}
```

The split regex `\s*(?=\b|\W|$)` is a zero-width split at every word/nonword boundary, swallowing whitespace. So `"paragraph (heading | block)+"` becomes `["paragraph", "(", "heading", "|", "block", ")", "+"]`.

The `inline` field is set by `parseExprAtom` the first time it sees a named type, and validated thereafter — this is what enforces "no mixing inline and block content in a single expression" (`content.ts:264-267`).

### 4.2 The parser

The parser is a textbook recursive-descent with three precedence levels:

```
parseExpr           handles |
  └── parseExprSeq        handles juxtaposition
        └── parseExprSubscript    handles + * ? {…}
              └── parseExprAtom       handles ( … ) and NAME
```

`prosemirror-model/src/content.ts:199-274`:

```ts
function parseExpr(stream): Expr {
  let exprs: Expr[] = []
  do { exprs.push(parseExprSeq(stream)) } while (stream.eat("|"))
  return exprs.length == 1 ? exprs[0] : {type: "choice", exprs}
}

function parseExprSeq(stream): Expr {
  let exprs: Expr[] = []
  do { exprs.push(parseExprSubscript(stream)) }
  while (stream.next && stream.next != ")" && stream.next != "|")
  return exprs.length == 1 ? exprs[0] : {type: "seq", exprs}
}

function parseExprSubscript(stream): Expr {
  let expr = parseExprAtom(stream)
  for (;;) {
    if (stream.eat("+"))      expr = {type: "plus", expr}
    else if (stream.eat("*")) expr = {type: "star", expr}
    else if (stream.eat("?")) expr = {type: "opt",  expr}
    else if (stream.eat("{")) expr = parseExprRange(stream, expr)
    else break
  }
  return expr
}

function parseExprAtom(stream): Expr {
  if (stream.eat("(")) {
    let expr = parseExpr(stream)
    if (!stream.eat(")")) stream.err("Missing closing paren")
    return expr
  } else if (!/\W/.test(stream.next)) {
    let exprs = resolveName(stream, stream.next).map(type => {
      if (stream.inline == null) stream.inline = type.isInline
      else if (stream.inline != type.isInline) stream.err("Mixing inline and block content")
      return {type: "name", value: type} as Expr
    })
    stream.pos++
    return exprs.length == 1 ? exprs[0] : {type: "choice", exprs}
  } else {
    stream.err("Unexpected token '" + stream.next + "'")
  }
}
```

### 4.3 Name and group resolution

`prosemirror-model/src/content.ts:246-256`:

```ts
function resolveName(stream, name): readonly NodeType[] {
  let types = stream.nodeTypes, type = types[name]
  if (type) return [type]
  let result: NodeType[] = []
  for (let typeName in types) {
    let type = types[typeName]
    if (type.isInGroup(name)) result.push(type)
  }
  if (result.length == 0) stream.err("No node type or group '" + name + "' found")
  return result
}
```

If the name is a node type, return `[that type]`. Otherwise treat it as a group name and return every type in that group. `parseExprAtom` then turns a multi-element group reference into a `{type: "choice", exprs}` of name nodes — i.e. `block` is internally compiled the same way `(paragraph | heading | blockquote | …)` would be.

### 4.4 The intermediate `Expr` AST

`prosemirror-model/src/content.ts:190-197`:

```ts
type Expr =
  {type: "choice", exprs: Expr[]} |
  {type: "seq",    exprs: Expr[]} |
  {type: "plus",   expr: Expr} |
  {type: "star",   expr: Expr} |
  {type: "opt",    expr: Expr} |
  {type: "range",  min: number, max: number, expr: Expr} |
  {type: "name",   value: NodeType}
```

This is short-lived — it’s just the input to the NFA compiler.

---

## 5. NFA Construction (Thompson’s Construction)

`prosemirror-model/src/content.ts:282-350` builds an NFA where:

* States are integers (indices into a `nfa: Edge[][]` array).
* Edges are `{term: NodeType | undefined, to: number | undefined}`.
* `term === undefined` is an ε-transition (null edge).
* The first state (`0`) is the entry; the last state pushed (the success state) is the accept state.
* **Edge order is significant** — used to construct filler content (see §6.4).

```ts
function nfa(expr: Expr): Edge[][] {
  let nfa: Edge[][] = [[]]
  connect(compile(expr, 0), node())
  return nfa

  function node() { return nfa.push([]) - 1 }
  function edge(from: number, to?: number, term?: NodeType) {
    let edge = {term, to}
    nfa[from].push(edge)
    return edge
  }
  function connect(edges: Edge[], to: number) {
    edges.forEach(edge => edge.to = to)
  }

  function compile(expr: Expr, from: number): Edge[] {
    if (expr.type == "choice") {
      return expr.exprs.reduce((out, expr) => out.concat(compile(expr, from)), [] as Edge[])
    } else if (expr.type == "seq") {
      for (let i = 0;; i++) {
        let next = compile(expr.exprs[i], from)
        if (i == expr.exprs.length - 1) return next
        connect(next, from = node())
      }
    } else if (expr.type == "star") {
      let loop = node()
      edge(from, loop)
      connect(compile(expr.expr, loop), loop)
      return [edge(loop)]
    } else if (expr.type == "plus") {
      let loop = node()
      connect(compile(expr.expr, from), loop)
      connect(compile(expr.expr, loop), loop)
      return [edge(loop)]
    } else if (expr.type == "opt") {
      return [edge(from)].concat(compile(expr.expr, from))
    } else if (expr.type == "range") {
      let cur = from
      for (let i = 0; i < expr.min; i++) { let next = node(); connect(compile(expr.expr, cur), next); cur = next }
      if (expr.max == -1) {
        connect(compile(expr.expr, cur), cur)
      } else {
        for (let i = expr.min; i < expr.max; i++) {
          let next = node()
          edge(cur, next)              // bypass
          connect(compile(expr.expr, cur), next)
          cur = next
        }
      }
      return [edge(cur)]
    } else if (expr.type == "name") {
      return [edge(from, undefined, expr.value)]
    }
  }
}
```

ASCII diagram for `"paragraph block*"`:

```
           paragraph              ε
   (0) ───────────────► (1) ──────────► (2) ◄──┐
                                          │   │ block (loops back via ε)
                                          ▼   │
                                         ε    │
                                          └───┘
                          ε
                         ─────► (3)  accept state
```

(states/edges abbreviated; the actual NFA may have more intermediate states — the algorithm doesn’t collapse aggressively because the DFA pass will).

For `"text*"`:

```
       ε                ε
  (0) ────► (1) ◄─┐ ────► (2)  accept
              │  │
              ▼  │
              text
```

For `"(heading | paragraph)+"`:

```
       heading ────►(loop)◄─── paragraph
  (0) ─┘                  └─ε──► (accept)
       └─paragraph────►(loop)◄── heading
```

(Two parallel entry edges — one per alternative — lead into a shared loop state from which more headings/paragraphs may be consumed.)

The reference at the top of `content.ts` is the canonical Russ Cox writeup at https://swtch.com/~rsc/regexp/regexp1.html, which the implementation closely follows.

---

## 6. NFA → DFA → `ContentMatch`

`prosemirror-model/src/content.ts:354-400`. The NFA is determinized into a DFA whose states are `ContentMatch` instances.

### 6.1 ε-closure

`nullFrom` (lines 357-371) is the ε-closure helper:

```ts
function nullFrom(nfa: Edge[][], node: number): readonly number[] {
  let result: number[] = []
  scan(node)
  return result.sort(cmp)

  function scan(node: number): void {
    let edges = nfa[node]
    if (edges.length == 1 && !edges[0].term) return scan(edges[0].to!)   // collapse trivial chains
    result.push(node)
    for (let i = 0; i < edges.length; i++) {
      let {term, to} = edges[i]
      if (!term && result.indexOf(to!) == -1) scan(to!)
    }
  }
}
```

The "single ε-out" optimization avoids creating useless duplicate DFA states.

### 6.2 Subset construction

`dfa(nfa)` (lines 376-400):

```ts
function dfa(nfa: Edge[][]): ContentMatch {
  let labeled = Object.create(null)
  return explore(nullFrom(nfa, 0))

  function explore(states: readonly number[]) {
    let out: [NodeType, number[]][] = []
    states.forEach(node => {
      nfa[node].forEach(({term, to}) => {
        if (!term) return
        let set: number[] | undefined
        for (let i = 0; i < out.length; i++) if (out[i][0] == term) set = out[i][1]
        nullFrom(nfa, to!).forEach(node => {
          if (!set) out.push([term, set = []])
          if (set.indexOf(node) == -1) set.push(node)
        })
      })
    })
    let state = labeled[states.join(",")] = new ContentMatch(states.indexOf(nfa.length - 1) > -1)
    for (let i = 0; i < out.length; i++) {
      let states = out[i][1].sort(cmp)
      state.next.push({type: out[i][0], next: labeled[states.join(",")] || explore(states)})
    }
    return state
  }
}
```

Standard subset construction: each DFA state is labeled by a sorted list of NFA states (joined by commas); explored states are memoized. The accept flag `validEnd` is `true` for any DFA state whose subset includes the NFA accept state (the last node).

### 6.3 The `ContentMatch` API

`prosemirror-model/src/content.ts:10-167`:

```ts
export class ContentMatch {
  readonly next: MatchEdge[] = []          // outgoing transitions: {type, next}
  readonly wrapCache: (NodeType | readonly NodeType[] | null)[] = []
  constructor(readonly validEnd: boolean) {}

  static parse(string, nodeTypes): ContentMatch { … }
  matchType(type: NodeType): ContentMatch | null { … }
  matchFragment(frag, start = 0, end = frag.childCount): ContentMatch | null { … }
  get inlineContent() { return this.next.length != 0 && this.next[0].type.isInline }
  get defaultType(): NodeType | null { … }
  compatible(other: ContentMatch) { … }
  fillBefore(after, toEnd = false, startIndex = 0): Fragment | null { … }
  findWrapping(target: NodeType): readonly NodeType[] | null { … }
  computeWrapping(target: NodeType): readonly NodeType[] | null { … }
  get edgeCount() { return this.next.length }
  edge(n: number): MatchEdge { … }
  toString() { … }
  static empty = new ContentMatch(true)
}
```

Each `ContentMatch` is a DFA state with:

* `next`: outgoing edges (DFA transitions). Order preserves NFA edge order — important for `defaultType` and `fillBefore`.
* `validEnd`: can the content expression terminate here?
* `wrapCache`: per-state memo for `findWrapping` (each `target` is cached as a 2-element pair `[target, wrapping]`).

### 6.4 `matchType` and `matchFragment`

`prosemirror-model/src/content.ts:35-48`:

```ts
matchType(type: NodeType): ContentMatch | null {
  for (let i = 0; i < this.next.length; i++)
    if (this.next[i].type == type) return this.next[i].next
  return null
}

matchFragment(frag: Fragment, start = 0, end = frag.childCount): ContentMatch | null {
  let cur: ContentMatch | null = this
  for (let i = start; cur && i < end; i++)
    cur = cur.matchType(frag.child(i).type)
  return cur
}
```

`matchType` is a linear scan (DFA edge counts are typically small — single-digits). `matchFragment` walks children.

This is the single most-called function in the entire schema layer. It’s used by:

* `Node.contentMatchAt(index)` (`node.ts:265-269`) → drives `canReplace`/`canReplaceWith`.
* `NodeType.validContent` (`schema.ts:188-194`) → drives `Node.check`.
* `prosemirror-transform`’s `Transform#replace`/`#step` machinery.

### 6.5 `defaultType`

`content.ts:57-63`:

```ts
get defaultType(): NodeType | null {
  for (let i = 0; i < this.next.length; i++) {
    let {type} = this.next[i]
    if (!(type.isText || type.hasRequiredAttrs())) return type
  }
  return null
}
```

The first edge whose target type doesn’t require attributes (and isn’t the text type — text nodes can’t be auto-created without text). This is used by transforms to "pick something to fill with."

### 6.6 `fillBefore` — auto-filling required content

`content.ts:79-98`:

```ts
fillBefore(after: Fragment, toEnd = false, startIndex = 0): Fragment | null {
  let seen: ContentMatch[] = [this]
  function search(match, types: readonly NodeType[]): Fragment | null {
    let finished = match.matchFragment(after, startIndex)
    if (finished && (!toEnd || finished.validEnd))
      return Fragment.from(types.map(tp => tp.createAndFill()!))
    for (let i = 0; i < match.next.length; i++) {
      let {type, next} = match.next[i]
      if (!(type.isText || type.hasRequiredAttrs()) && seen.indexOf(next) == -1) {
        seen.push(next)
        let found = search(next, types.concat(type))
        if (found) return found
      }
    }
    return null
  }
  return search(this, [])
}
```

Question: "Given current state `this`, what nodes (if any) can I prepend to `after` such that `[prepended..., after]` matches?" If `toEnd` is true, additionally require the result to be a valid end state.

This is BFS over the DFA, skipping edges into types that are text or have required attrs (you can’t auto-generate those). If a suffix match is found, the *recorded path* of types is materialized via `createAndFill`. Recursion through `createAndFill` (`schema.ts:172-184`) means the filling is recursive — fillers can themselves contain auto-filled descendants.

`createAndFill` itself also uses `fillBefore` on the type’s own content match:

```ts
createAndFill(attrs, content, marks) {
  attrs = this.computeAttrs(attrs)
  content = Fragment.from(content)
  if (content.size) {
    let before = this.contentMatch.fillBefore(content)
    if (!before) return null
    content = before.append(content)
  }
  let matched = this.contentMatch.matchFragment(content)
  let after = matched && matched.fillBefore(Fragment.empty, true)
  if (!after) return null
  return new Node(this, attrs, (content as Fragment).append(after), Mark.setFrom(marks))
}
```

Sequence: prepend any required leading content, validate the middle, append any required trailing content. If any step fails, the whole creation fails. This is what powers commands like `Schema#node(name)` for nodes that *must* contain something (e.g. a `list_item` whose content is `"paragraph block*"` will be auto-filled with an empty paragraph).

### 6.7 `findWrapping` — finding insertion wrappings

`content.ts:104-133`:

```ts
findWrapping(target: NodeType): readonly NodeType[] | null {
  for (let i = 0; i < this.wrapCache.length; i += 2)
    if (this.wrapCache[i] == target) return this.wrapCache[i + 1]
  let computed = this.computeWrapping(target)
  this.wrapCache.push(target, computed)
  return computed
}

computeWrapping(target: NodeType): readonly NodeType[] | null {
  type Active = {match: ContentMatch, type: NodeType | null, via: Active | null}
  let seen = Object.create(null), active: Active[] = [{match: this, type: null, via: null}]
  while (active.length) {
    let current = active.shift()!, match = current.match
    if (match.matchType(target)) {
      let result: NodeType[] = []
      for (let obj: Active = current; obj.type; obj = obj.via!) result.push(obj.type)
      return result.reverse()
    }
    for (let i = 0; i < match.next.length; i++) {
      let {type, next} = match.next[i]
      if (!type.isLeaf && !type.hasRequiredAttrs() && !(type.name in seen) && (!current.type || next.validEnd)) {
        active.push({match: type.contentMatch, type, via: current})
        seen[type.name] = true
      }
    }
  }
  return null
}
```

Question: "Starting from this match position, can I wrap a `target`-typed node in *some* set of allowed wrapper types so it fits?" The result is the wrapping list (e.g. `[bullet_list, list_item]` if you want to drop a paragraph into a position that allows lists).

It’s a BFS through the *type graph*: for each reachable allowable type, try to match the target inside its own content. Per-state and per-target memoization (`wrapCache`) makes this cheap on repeated calls — important because `prosemirror-transform`’s wrap commands probe many positions.

### 6.8 `compatible`

`content.ts:66-71`:

```ts
compatible(other: ContentMatch) {
  for (let i = 0; i < this.next.length; i++)
    for (let j = 0; j < other.next.length; j++)
      if (this.next[i].type == other.next[j].type) return true
  return false
}
```

"Can these two states transition on at least one common type?" — used by `NodeType.compatibleContent` (`schema.ts:136-138`) and ultimately by `Node.canAppend` and `replace.ts`’s `checkJoin`.

### 6.9 Dead-end detection

`content.ts:402-413`:

```ts
function checkForDeadEnds(match: ContentMatch, stream: TokenStream) {
  for (let i = 0, work = [match]; i < work.length; i++) {
    let state = work[i], dead = !state.validEnd, nodes: string[] = []
    for (let j = 0; j < state.next.length; j++) {
      let {type, next} = state.next[j]
      nodes.push(type.name)
      if (dead && !(type.isText || type.hasRequiredAttrs())) dead = false
      if (work.indexOf(next) == -1) work.push(next)
    }
    if (dead) stream.err("Only non-generatable nodes (" + nodes.join(", ") + ") in a required position (see https://prosemirror.net/docs/guide/#generatable)")
  }
}
```

This catches schemas like `content: "image+"` where every required step demands a node with a required attr (`src`) that can’t be auto-generated. Such schemas would render `createAndFill` (and thus `prosemirror-state`’s default-doc-creation) unable to produce a valid empty document, so the schema is rejected at compile time.

### 6.10 `inlineContent`

`content.ts:51-53`:

```ts
get inlineContent() {
  return this.next.length != 0 && this.next[0].type.isInline
}
```

The result is propagated to `NodeType.inlineContent` during compilation (`schema.ts:612`). Used by:

* `NodeType.isTextblock` (block + inlineContent).
* The default `markSet` resolution (inline-content nodes default to allowing all marks).
* `prosemirror-state` selection logic.

Note the assumption: a content match either points exclusively at inline types or exclusively at block types (the parser enforces this).

---

## 7. Validation Surface

Three layered checks; each calls into the next.

### 7.1 `node.checkAttrs(attrs)`

`prosemirror-model/src/schema.ts:41-48` (a free function):

```ts
export function checkAttrs(attrs, values, type, name) {
  for (let name in values)
    if (!(name in attrs)) throw new RangeError(`Unsupported attribute ${name} for ${type} of type ${name}`)
  for (let name in attrs) {
    let attr = attrs[name]
    if (attr.validate) attr.validate(values[name])
  }
}
```

Two passes:

1. Reject unknown attribute names.
2. Run each registered `validate`.

Note: required-attr presence is checked at `computeAttrs` time, not here — `computeAttrs` throws `"No value supplied for attribute X"` (`schema.ts:34`).

### 7.2 `nodeType.checkContent(content)`

`prosemirror-model/src/schema.ts:188-202`:

```ts
validContent(content: Fragment) {
  let result = this.contentMatch.matchFragment(content)
  if (!result || !result.validEnd) return false
  for (let i = 0; i < content.childCount; i++)
    if (!this.allowsMarks(content.child(i).marks)) return false
  return true
}

checkContent(content: Fragment) {
  if (!this.validContent(content))
    throw new RangeError(`Invalid content for node ${this.name}: ${content.toString().slice(0, 50)}`)
}
```

Conditions:

1. `matchFragment` returns a non-null state.
2. That state is `validEnd`.
3. Every child’s marks are permitted by this node type.

### 7.3 `Node.check()`

Already covered in `02-document-model.md` §2.7. It orchestrates the three: `checkContent`, `checkAttrs`, mark canonicality, then recurses.

---

## 8. Marks Expression — the parallel mini-language

Marks have a *much* simpler expression language than nodes: it’s just a space-separated list of names/groups, plus `_` and `""`. There is no NFA — the parser is `markExpr.split(" ")` followed by `gatherMarks`.

Examples:

| Expression | Meaning |
|---|---|
| `"_"` | All marks allowed (sentinel `markSet = null`). |
| `""` | No marks allowed (`markSet = []`). |
| `"strong em"` | Only those two marks. |
| `"strong em link"` | Three marks. |
| `"_inline"` (a group name) | All marks in the `_inline` group. |
| omitted | If the node has inline content, all marks; otherwise none. |

The same gatherMarks function handles both `NodeSpec.marks` and `MarkSpec.excludes`, so all four "list of marks" surfaces use one resolver.

---

## 9. Edge Cases

### 9.1 Required content at start: "this expression must produce a node"

If a content expression starts with `+` (e.g. `"paragraph+"` or `"block+"`), the start state is *not* `validEnd` — an empty fragment doesn’t satisfy it. `createAndFill` will auto-generate one of the allowed types (specifically `defaultType`, recursively). For `"block+"` in a doc, that’s a paragraph (the first non-required-attr type in the `block` group, in declaration order).

### 9.2 Required content with required attrs

If the only types reachable in a required position have required attrs (e.g. `image+` where `image` requires `src`), the schema is invalid: `checkForDeadEnds` throws at compile time. This forces schema authors to ensure every required position has at least one auto-generatable type.

### 9.3 Linebreak replacement

`prosemirror-model/src/schema.ts:613-617`:

```ts
if (type.spec.linebreakReplacement) {
  if (this.linebreakReplacement) throw new RangeError("Multiple linebreak nodes defined")
  if (!type.isInline || !type.isLeaf) throw new RangeError("Linebreak replacement nodes must be inline leaf nodes")
  this.linebreakReplacement = type
}
```

Exactly zero-or-one inline leaf may be declared as the schema’s "newline equivalent" (typically `hard_break`). `prosemirror-transform`’s `setBlockType` uses this to translate between `\n`-in-pre-text and explicit `<br>` nodes when changing block types.

### 9.4 Cross-schema nodes

`Schema#node` checks that the requested type’s schema is the same instance (`schema.ts:653-655`):

```ts
else if (type.schema != this) throw new RangeError("Node type from different schema used (" + type.name + ")")
```

This is why two equivalent schemas built from the same spec are not interoperable — type identity is by reference, not name.

### 9.5 Same-name node and mark

```ts
if (prop in this.marks)
  throw new RangeError(prop + " can not be both a node and a mark")
```

(`prosemirror-model/src/schema.ts:607-608`.) The constraint is global: a name belongs to either the node namespace or the mark namespace, never both.

### 9.6 Empty top-level

If `topNode`’s content expression has `validEnd` at start (e.g. `"block*"`), an empty doc is valid. If it doesn’t (`"block+"`), `createAndFill` is required at doc-construction time. `prosemirror-state`’s `EditorState.create({schema})` calls `topNodeType.createAndFill()`.

### 9.7 The `text` type

* Must exist.
* Must have no attrs.
* Has `isText = true`, `isBlock = false`, `isInline = true`, `isLeaf = true` (its content match is `ContentMatch.empty`).
* Cannot be created via `nodeType.create` (`node.ts:153`):
  ```ts
  if (this.isText) throw new Error("NodeType.create can't construct text nodes")
  ```
  Use `schema.text(string, marks?)` instead.

---

## 10. Diagrams

### 10.1 Schema compilation — call graph

```
new Schema(spec)
   │
   ├─► OrderedMap.from(spec.nodes)
   ├─► OrderedMap.from(spec.marks)
   │
   ├─► NodeType.compile(orderedNodes, this)
   │      └─► for each entry: new NodeType(name, schema, spec)
   │            ├─ groups = spec.group?.split(" ") ?? []
   │            ├─ attrs = initAttrs(name, spec.attrs)
   │            ├─ defaultAttrs = defaultAttrs(attrs) | null
   │            ├─ isBlock, isText derived
   │            └─ contentMatch / inlineContent left null
   │      └─ asserts: topNode exists, text exists, text has no attrs
   │
   ├─► MarkType.compile(orderedMarks, this)
   │      └─► for each entry, with rank++: new MarkType(name, rank, schema, spec)
   │            ├─ attrs = initAttrs(name, spec.attrs)
   │            ├─ instance = defaults ? new Mark(this, defaults) : null
   │            └─ excluded left null
   │
   ├─► [contentExprCache shared across types]
   │   for each NodeType in this.nodes:
   │      assert(name not in this.marks)
   │      type.contentMatch = cache[expr] ?? ContentMatch.parse(expr, this.nodes)
   │             │
   │             ├─► TokenStream(expr, types)
   │             ├─► parseExpr(stream)               → Expr AST
   │             ├─► nfa(expr)                       → Edge[][]
   │             ├─► dfa(nfa)                        → ContentMatch root
   │             └─► checkForDeadEnds(root, stream)
   │      type.inlineContent = type.contentMatch.inlineContent
   │      handle linebreakReplacement
   │      type.markSet = resolveMarkSet(spec.marks, type)
   │
   ├─► for each MarkType:
   │      type.excluded = resolveExcluded(spec.excludes, type)
   │
   ├─► nodeFromJSON, markFromJSON bound
   ├─► topNodeType selected
   └─► cached.wrappings = {} ready for transform-layer use
```

### 10.2 Content expression `"paragraph block*"` — DFA

After parse + NFA + DFA, the resulting `ContentMatch` graph for `"paragraph block*"` is:

```
   ┌─────────────────────────┐
   │ S0  validEnd=false      │
   │ next:                   │
   │  - paragraph → S1       │
   └────────────┬────────────┘
                │ matchType(paragraph)
                ▼
   ┌─────────────────────────┐
   │ S1  validEnd=true       │ ← can stop here (one paragraph satisfies the +)
   │ next:                   │
   │  - paragraph → S1       │ (paragraph is in "block" group, so it's reachable)
   │  - heading   → S1       │
   │  - blockquote→ S1       │
   │  - …          → S1      │
   └─────────────────────────┘
```

For `"inline*"`:

```
   ┌─────────────────────────┐
   │ S0  validEnd=true       │ ← empty content is valid
   │ next:                   │
   │  - text       → S0      │
   │  - image      → S0      │
   │  - hard_break → S0      │
   └─────────────────────────┘
```

Self-loop because `*` allows any number of repetitions, including zero.

For `"text*"`:

```
   ┌─────────────────────────┐
   │ S0  validEnd=true       │
   │ next:                   │
   │  - text → S0            │
   └─────────────────────────┘
```

Note: `S0.inlineContent === true` because `next[0].type.isInline === true`.

For `"(heading | paragraph)+"`:

```
   ┌─────────────────────────┐
   │ S0  validEnd=false      │
   │ next:                   │
   │  - heading   → S1       │
   │  - paragraph → S1       │
   └────────────┬────────────┘
                ▼
   ┌─────────────────────────┐
   │ S1  validEnd=true       │
   │ next:                   │
   │  - heading   → S1       │
   │  - paragraph → S1       │
   └─────────────────────────┘
```

For `"text{2,4}"`:

```
   S0 ──text──► S1 ──text──► S2 ──text──► S3 ──text──► S4
   v=false      v=false      v=true       v=true       v=true
                                                       (no out edges; max reached)
```

Each state from S2 onward is `validEnd = true`; S2..S3 also have a "text" out-edge; S4 is terminal.

---

## 11. How transforms exploit this

`prosemirror-transform`’s strategies all reduce to questions answered by the model:

| Transform task | ContentMatch query |
|---|---|
| Can I insert this slice? | `parent.contentMatchAt(i).matchFragment(slice.content)` then check `.validEnd` after the tail. |
| What can I auto-generate to satisfy required content? | `match.fillBefore(after, toEnd)` |
| What wrappers can I use to put X here? | `match.findWrapping(targetType)` |
| Can these two open nodes merge? | `nodeA.type.compatibleContent(nodeB.type)` (calls `match.compatible`) |
| Default child for empty position? | `match.defaultType` |

Because all of these are pure functions over compiled DFAs, they are cheap and deterministic. The schema layer therefore acts as an **oracle** for every structural decision — the transform layer only has to enumerate moves and ask the oracle which ones are legal.

---

## 12. Cheat-Sheet

| Concern | API | File:line |
|---|---|---|
| Schema constructor | `new Schema(spec)` | `schema.ts:596` |
| Compile a content expr | `ContentMatch.parse(string, types)` | `content.ts:23` |
| Walk DFA | `match.matchType(t)`, `match.matchFragment(frag, start, end)` | `content.ts:35,43` |
| Auto-fill | `match.fillBefore(after, toEnd)` | `content.ts:79` |
| Find wrapping | `match.findWrapping(target)` | `content.ts:104` |
| Compatible | `match.compatible(other)` | `content.ts:66` |
| Default type | `match.defaultType` | `content.ts:57` |
| Mark set membership | `type.allowsMarkType(mt)` / `allowsMarks(marks)` | `schema.ts:210,215` |
| Resolve mark/group list | `gatherMarks(schema, names)` | `schema.ts:689` |
| Validate fragment | `nodeType.validContent(frag)` / `checkContent(frag)` | `schema.ts:188,199` |
| Validate attrs | `nodeType.checkAttrs(attrs)` / `markType.checkAttrs(attrs)` | `schema.ts:205,338` |
| Create with auto-fill | `nodeType.createAndFill(attrs, content, marks)` | `schema.ts:172` |
| Required attrs? | `nodeType.hasRequiredAttrs()` | `schema.ts:129` |
| Mark exclusion | `markType.excludes(other)` | `schema.ts:344` |

---

## 13. Implications for a next-gen editor

Things to inherit:

1. **Two-pass compilation: types first, then expressions and exclusions.** This breaks the cycle "expression references types, types depend on expressions" cleanly.
2. **Cache compiled expressions by string.** Cheap, real win; many node types share expressions.
3. **Order matters everywhere** — for parser priority, mark sort order, group expansion, default-type selection. Make insertion order a first-class part of the schema spec, not an accident.
4. **Compile to a DFA and answer all structural questions through it.** Transforms can then be purely declarative ("find a sequence of edits that the schema accepts"), and the DFA is the engine.
5. **Detect dead ends statically.** `checkForDeadEnds` is a small but valuable static check that turns user errors into compile-time exceptions instead of runtime "can’t create document" failures.
6. **Distinguish `markSet = null` ("anything") from `[]` ("nothing").** A nullable allow-list with the right defaults (inline-content → all, otherwise → none) gives schemas concise, intuitive defaults.
7. **Singleton attrs + singleton mark instances.** Pre-compute `defaultAttrs` and `MarkType.instance` at compile time. Saves allocation on the hot path.
8. **Static schema, dynamic queries.** The schema never changes after construction; that immutability is what makes the cached DFA, the wrap cache, and the type-identity equality checks safe.

---

## 14. Addenda — gap fills

The following sections add coverage that was elided from the main body.

### 14.1 `Schema.cached` — per-schema memoization

`prosemirror-model/src/schema.ts:640`:

```ts
cached: {[key: string]: any} = Object.create(null)
```

A free-form per-schema cache that the schema constructor itself
populates with `cached.wrappings = Object.create(null)` (line 630), and
that `prosemirror-transform` extends with its own keys (e.g.
`structure.ts` stores `findWrapping` results keyed by `(parentType,
target)`).

For plugin authors who memoize per-schema metadata (e.g. "list of all
block types that allow `text` content", or compiled regex tables for
input rules), `schema.cached["my-plugin:foo"] = …` is the idiomatic
location. The cache is reset only when a new `Schema` is constructed —
never within the lifetime of a single schema.

### 14.2 Schema factory shortcuts

`prosemirror-model/src/schema.ts:646-689` provides convenience methods
for constructing nodes/marks/text against the schema:

```ts
schema.node(type, attrs?, content?, marks?)   // → createChecked
schema.text(text, marks?)                     // → new TextNode directly
schema.mark(type, attrs?)                     // → markType.create(attrs)
schema.nodeType(name)                         // → throws if unknown
```

Notes:

- `schema.node` accepts `type` as either a name string or a `NodeType`
  instance (and validates the `NodeType` belongs to *this* schema —
  cross-schema use throws, see §9.4).
- `schema.text` is the **only** way to construct a text node.
  `nodeType("text").create()` throws (`node.ts:153`: "NodeType.create
  can't construct text nodes").
- `schema.mark` returns the cached singleton for marks with no required
  attrs (see §3.2).
- `schema.nodeType(name)` is the validated lookup; bare
  `schema.nodes[name]` returns `undefined` for unknown names while
  `nodeType(name)` throws `RangeError("Unknown node type: …")`.

### 14.3 `Schema.nodeFromJSON`, `Schema.markFromJSON`

`prosemirror-model/src/schema.ts:627-628`:

```ts
this.nodeFromJSON = json => Node.fromJSON(this, json)
this.markFromJSON = json => Mark.fromJSON(this, json)
```

Bound methods — they capture `this` so the reference can be passed
around without losing context (e.g. `array.map(schema.nodeFromJSON)`).
This is the round-trip entry point for `EditorState.fromJSON`, snapshot
restoration, and any wire-protocol that delivers JSON documents.

The `Node.fromJSON` / `Mark.fromJSON` static factories use the schema
to:

1. Look up the type by name (throws on unknown).
2. Construct the value via `create` (and explicit `checkAttrs`).
3. Recurse into `content` and `marks` arrays.

`Fragment.fromArray` in the construction path means adjacent same-mark
text nodes are re-merged on the way in (see `02-document-model.md`
§3.1), so a wire-format that emitted unmerged text nodes still produces
canonical fragments.

### 14.4 `create` vs `createChecked` vs `createAndFill` — failure modes

`prosemirror-model/src/schema.ts:152-184`:

```ts
create(attrs, content?, marks?)        // node.ts:152
createChecked(attrs, content?, marks?) // node.ts:160
createAndFill(attrs, content?, marks?) // node.ts:172
```

| Method | Schema check | Failure mode | When to use |
|---|---|---|---|
| `create` | None on content | Always succeeds (modulo `computeAttrs` throwing on missing required attrs); produces an *invalid* node if content doesn't match the type's content expression | Test builders, internal performance-critical paths, code that has *just* validated content |
| `createChecked` | `checkContent(content)` runs | Throws `RangeError("Invalid content for node X: …")` | "I expect this to be valid, fail loudly if it's not" |
| `createAndFill` | `contentMatch.fillBefore` + `matchFragment` + trailing `fillBefore(empty, true)` | Returns `null` if no fitting wrapping/filling exists | "Construct a node, auto-supplying any required content (e.g. a `list_item` whose content is `paragraph block*` will be filled with an empty paragraph)" |

Beginners frequently conflate the three. The right rule of thumb:

- Building a doc from user input or untrusted JSON: `createChecked`.
- Building a *required* node where some content may be missing (e.g. a
  fresh `list_item` from a "make a new list" command): `createAndFill`,
  and bail if it returns `null`.
- Test code with hand-written valid content: `create` is fine.

`createAndFill` is also recursive in spirit: the auto-generated fillers
themselves use `createAndFill` so a chain of required nesting can be
filled in one call. See §6.6 for the algorithm.

### 14.5 `NodeType.allowsMarkType`, `allowsMarks`, `allowedMarks`

§3.3 covered these. Worth emphasizing the `allowedMarks` contract:

```ts
allowedMarks(marks: readonly Mark[]): readonly Mark[]
```

Returns:

- The *same* array (identity-equal `==`) if all marks are allowed.
- A *new* array with disallowed marks dropped. If everything was
  dropped, returns `Mark.none` (the shared empty singleton).

This identity-preserving contract matters: callers can compare
`result === marks` to detect "did anything change?" without iterating.
`prosemirror-transform`'s `clearIncompatible` uses this to short-circuit
mark-stripping when no marks are filtered.

```ts
let cleaned = nodeType.allowedMarks(child.marks)
if (cleaned !== child.marks) {
  // some mark was dropped; rebuild the child with the cleaned set
  child = child.mark(cleaned)
}
```

### 14.6 `MarkType.excludes`, `removeFromSet`, `isInSet`

The exclusion semantics:

- Default `excludes: null` → mark excludes itself only (one `link` per
  text run; multiple `strong` would coexist if `strong` declared
  `excludes: ""`).
- `excludes: ""` → mark excludes nothing; multiple of the same type can
  coexist.
- `excludes: "_"` → excludes all marks (typically used by `code`-style
  marks in some schemas to suppress formatting inside code).
- `excludes: "em strong"` → excludes those types specifically.

The compiled `MarkType.excluded` is an array of `MarkType` instances
(`schema.ts:622-625`). `MarkType.excludes(other)` is a simple `indexOf`:

```ts
excludes(other: MarkType): boolean {
  return this.excluded.indexOf(other) > -1
}
```

`Mark.removeFromSet(set)` (`mark.ts:49-53`) returns a new array with the
matching mark removed (or the same array if not present).
`Mark.isInSet(set)` is a linear `eq` scan. Both are exposed for plugin
use (e.g. menu state: "is the cursor inside a `link` mark?").

### 14.7 `AttributeSpec.validate` — security-relevant attrs guards

`prosemirror-model/src/schema.ts:548-563` plus `validateType` (lines
249-255). Used to harden attrs against attacker-controlled JSON:

```ts
nodes: {
  image: {
    attrs: {
      src:  {validate: "string"},
      alt:  {default: "", validate: "string"},
      width: {default: null, validate: "number|null"}
    },
    /* ... */
  }
}
```

The `validate` value can be:

- A `|`-separated string of primitive type names (`"number"`, `"string"`,
  `"boolean"`, `"null"`); any value whose `typeof` (or `=== null`)
  matches passes. Compiled to a closure by `validateType` at schema
  construction.
- A function `(value) => void` that throws on invalid input. Use this
  for custom invariants (`href` must be a same-origin URL, `level` must
  be in `1..6`, etc.).

`checkAttrs` (`schema.ts:41-48`) runs every registered `validate` when
called, which happens from `Node.check`, `NodeType.checkAttrs`, and
`Mark.fromJSON`. So untrusted JSON deserialization is the canonical
hardening site — make sure your `Node.fromJSON` path goes through
something that calls `checkAttrs` (it does by default; the explicit
`type.checkAttrs(node.attrs)` call after `create` in `Node.fromJSON` is
that line).

### 14.8 `linebreakReplacement` — schema-side semantics

`prosemirror-model/src/schema.ts:486` (NodeSpec) and lines 593, 613-617
(Schema):

```ts
// NodeSpec
linebreakReplacement?: boolean

// Schema constructor enforces:
if (type.spec.linebreakReplacement) {
  if (this.linebreakReplacement) throw new RangeError("Multiple linebreak nodes defined")
  if (!type.isInline || !type.isLeaf) throw new RangeError("Linebreak replacement nodes must be inline leaf nodes")
  this.linebreakReplacement = type
}
```

Constraints:

1. **At most one** node type per schema may set `linebreakReplacement: true`.
2. The marked type **must be inline** and **must be a leaf**. (Typically
   `hard_break`.)
3. `Schema.linebreakReplacement` (the field on the schema instance) is
   auto-derived to point at that type, or `null` if none.

How it's used downstream:

- **`prosemirror-transform.setBlockType`** consults
  `schema.linebreakReplacement` when the destination block type has
  `whitespace: "pre"` (e.g. `code_block`), translating literal `<br>`
  inline leaf nodes into `\n` characters in the resulting text — and
  vice versa when leaving `pre` whitespace. This is what makes
  "convert paragraph to code block (and back)" round-trip cleanly.
- **`prosemirror-view`'s clipboard pipeline** uses the same node when
  serializing a paste-friendly representation.
- The model itself does not branch on it directly; it just holds the
  pointer.

### 14.9 `topNode` and `topNodeType`

`SchemaSpec.topNode` (default `"doc"`) names the document root type.
The constructor (`schema.ts:629`) resolves it:

```ts
this.topNodeType = this.nodes[this.spec.topNode || "doc"]
```

If `topNode` references an unknown type, `NodeType.compile` throws
(`schema.ts:241-242`):

```ts
if (!result[topType]) throw new RangeError("Schema is missing its top node type ('" + topType + "')")
```

`prosemirror-state.EditorState.create({schema})` calls
`schema.topNodeType.createAndFill()` to build the initial doc when no
`doc` is supplied. So:

- For a schema with `doc: {content: "block+"}`, the initial doc has one
  auto-generated child (typically a paragraph).
- For a schema with `doc: {content: "block*"}`, the initial doc is
  empty.

Custom `topNode` (e.g. `topNode: "page"` for a page-aware schema) is
fully supported as long as the type is registered in `nodes`.

### 14.10 NodeSpec flags driving editor behavior

Beyond the headline `content` / `marks` / `group`, `NodeSpec` carries
many flags that drive transform and view behaviors. Cited from
`prosemirror-model/src/schema.ts:371-491`:

| Flag | Default | Used by | Effect |
|---|---|---|---|
| `code` | `false` | commands, `whitespace` default | Marks block as containing code; `whitespace` defaults to `"pre"`. |
| `atom` | `false` | view, transforms | Treat as a single editable unit; selection lands on it as `NodeSelection`, not inside. Atoms with content render the content but disallow direct caret entry. |
| `isolating` | `false` | `Slice.maxOpen`, transforms (`liftTarget`, `findWrapping`) | Editing operations don't cross this boundary. Used for table cells, list items in some configurations. |
| `definingForContent` | `false` | clipboard paste | When pasting *content from* this node, preserve it as a wrapping (e.g. paste from inside a heading should keep the heading). |
| `definingAsContext` | `false` | clipboard paste | When pasting *into* this node, prefer to keep it as the surrounding context (paste into a list item should stay inside the list item). |
| `defining` | `false` | shortcut | Sets both above. |
| `selectable` | `true` | view selection | Whether the node may be selected as a `NodeSelection`. |
| `draggable` | `false` | view drag/drop | Whether the node can be dragged by its handle. |
| `whitespace` | `"normal"` (or `"pre"` if `code: true`) | DOMParser | `"pre"` preserves whitespace literally; `"normal"` collapses runs. |
| `leafText` | none | `Node.textContent`, `textBetween` | `(node) => string` for what a leaf contributes to text-extraction. |
| `linebreakReplacement` | `false` | `setBlockType`, clipboard | See §14.8. |
| `allowGapCursor` | undef | `prosemirror-gapcursor` | Allow gap-cursor insertion between this and siblings. |
| `tableRole` | undef | `prosemirror-tables` | `"table"`/`"row"`/`"cell"`/`"header_cell"` — drives table command dispatch. |
| `inline` | `false` | type bookkeeping | Marks this type as inline (text is implicitly inline). |
| `attrs` | `{}` | model | Per-attribute spec; required attrs (no `default`) must be supplied at construction. |
| `parseDOM` | `[]` | DOMParser | Parse rules. |
| `toDOM` | none | DOMSerializer | Serialization spec returning `DOMOutputSpec`. |

A schema author tuning editor behavior typically sets `defining`,
`isolating`, and `atom` to control paste/lift/wrap; `selectable` and
`draggable` for view interaction; `whitespace`/`linebreakReplacement`
for content-with-whitespace correctness.

### 14.11 `parseDOM` / `toDOM` — DOM round-trip overview

A full treatment lives in `11-dom-parser.md` and `12-dom-serializer.md`,
but the schema-side surface deserves at least a complete sketch here.

`parseDOM` is an array of `ParseRule` (`from_dom.ts`). The two main
shapes:

```ts
{tag: "p", getAttrs?: …}                          // TagParseRule
{style: "font-weight=bold", clearMark?: …}        // StyleParseRule
```

Plus generic rules with `node`/`mark`/`getContent` for non-standard
shapes. Each rule may declare:

- `priority` (default 50) — higher wins ties.
- `context` — a CSS-ish parent path selector (`"blockquote/"` means
  "this rule only applies inside a `blockquote`").
- `getAttrs(domNode) => Attrs | false` — extract attrs, or return
  `false` to *reject* this rule and try the next match.
- `consuming: false` — let other rules also see this DOM node.

`toDOM` returns a `DOMOutputSpec`:

```ts
type DOMOutputSpec =
  | string                                 // text node
  | DOMNode                                // existing DOM node
  | [string, ...children]                  // ['p', 'hello']
  | [string, attrs, ...children]           // ['p', {class:'x'}, 'hello']
  | [string, attrs, 0]                     // ['p', {class:'x'}, 0]  — content hole
  | [string, 0]                            // ['p', 0]
```

The integer `0` marks the "content hole" — where the node's children
should be rendered. A `toDOM` returning `["pre", ["code", 0]]` renders
`<pre><code>{children}</code></pre>`.

For full coverage of `ParseOptions`, `context`, ambiguous-style
handling, and the parse algorithm itself, see `11-dom-parser.md`.

### 14.12 `findWrapping` — BFS over wrappings

§6.7 covered the API. The algorithm is BFS over the *type graph*: from
the current `ContentMatch` state, find any chain of node types that,
when wrapped around `target`, lands inside an accepting state.

Concrete trace for "wrap a `paragraph` so it fits inside a position
expecting a `bullet_list`":

```
Active = [{match: <doc-content match>, type: null, via: null}]

Iteration 1: pop {match: doc, type: null}
  match.matchType(paragraph)? — depends on schema (often yes for doc)
  if yes → return [] (no wrappers needed, paragraph fits directly)
  if no → enqueue all reachable types whose contentMatch could lead to paragraph
    e.g. bullet_list whose content is "list_item+" — enqueue
    {match: <bullet_list-content match>, type: bullet_list, via: <self>}

Iteration 2: pop {match: bullet_list, type: bullet_list, via: ...}
  match.matchType(paragraph)? — bullet_list contains list_item, not paragraph
  if no → enqueue list_item
    {match: <list_item-content>, type: list_item, via: <prev>}

Iteration 3: pop {match: list_item, type: list_item, via: ...}
  match.matchType(paragraph)? — list_item content is "paragraph block*", yes!
  → walk via chain: list_item → bullet_list
  → return [bullet_list, list_item] (outer first)
```

Result: wrap the paragraph in `[bullet_list, list_item]` (outer to
inner) to fit. `prosemirror-transform.findWrapping` (`structure.ts`)
calls this and then materializes the wrappers into actual nodes via
`createAndFill`.

The BFS visits each type at most once (`seen` map), and per-state
results are cached in `wrapCache`. So repeated calls during a single
transform (e.g. probing many positions for a wrap command) are cheap.

The `(!current.type || next.validEnd)` guard (line 908) ensures we only
enter a non-root candidate type if its outer state can validly *end*
where we left it — i.e. the partial match we're abandoning is in an
accepting state. This prevents the algorithm from suggesting wrappers
that would themselves leave the surrounding position invalid.

### 14.13 Failing parse — example

Suppose the schema declares `paragraph` with `parseDOM: [{tag: "p"}]`
plus a custom rule:

```ts
parseDOM: [
  {tag: "p"},                                    // priority 50 (default)
  {tag: "p.note", priority: 60,                  // higher priority wins
   getAttrs: dom => dom.getAttribute("data-id")
                     ? {id: dom.getAttribute("data-id")} : false}
]
```

Parsing `<p class="note" data-id="42">…</p>`:

1. Both rules tag-match. `priority: 60` wins.
2. `getAttrs(dom)` returns `{id: "42"}` — attrs assigned.
3. Children are parsed (recursive descent).

Parsing `<p class="note">…</p>` (no `data-id`):

1. `priority: 60` rule tag-matches.
2. `getAttrs(dom)` returns `false` → **rule rejected**.
3. Parser falls through to the next matching rule (`tag: "p"` at
   priority 50). That rule has no `getAttrs`, so attrs are `null`
   (defaults applied via `computeAttrs`).
4. Children parsed normally.

`getAttrs` returning `false` is the canonical "this rule doesn't
actually apply" signal. Returning `null` or an attrs object means
*matched* (with `null` meaning "use defaults").

`context: "blockquote/"` is a parent-path selector: the rule only
applies if the parse stack has a `blockquote` ancestor. Use it to
declare "treat `<p>` differently inside `<blockquote>`" without altering
the global `<p>` rule.

For the full grammar of `context`, ambiguous-style handling
(`StyleParseRule` ordering when multiple `style:` rules match the same
inline DOM), and the `parseSlice` entry point, see `11-dom-parser.md`.

### 14.14 `Schema.linebreakReplacement` getter

§14.8 covered the constructor logic. The instance field

```ts
linebreakReplacement: NodeType | null = null
```

(`schema.ts:593`) is auto-derived during construction. It is *not* a
getter; it's a plain field set once and never mutated.

To add `linebreakReplacement` support to an existing schema (extending
the spec via `OrderedMap.update`), you build a *new* `Schema` — there's
no in-place mutation API. See §14.15.

### 14.15 Extending an existing schema — the spec-merge pattern

The canonical example is `prosemirror-schema-list`, which adds list
nodes to any base schema:

```ts
import {Schema} from "prosemirror-model"
import {schema as baseSchema} from "prosemirror-schema-basic"
import {addListNodes} from "prosemirror-schema-list"

const mySchema = new Schema({
  nodes: addListNodes(baseSchema.spec.nodes, "paragraph block*", "block"),
  marks: baseSchema.spec.marks
})
```

`addListNodes(map, listContent, listGroup)` (from
`prosemirror-schema-list/src/schema-list.ts`) does:

```ts
function addListNodes(nodes, itemContent, listGroup) {
  return nodes.append({
    ordered_list: { content: "list_item+", group: listGroup, /* … */ },
    bullet_list:  { content: "list_item+", group: listGroup, /* … */ },
    list_item:    { content: itemContent, defining: true, /* … */ }
  })
}
```

Key idioms:

1. **Start from `baseSchema.spec.nodes`** (an `OrderedMap`).
2. **`OrderedMap.append({…})`** to add new node specs at the end (or
   `prepend` for the start, or `update(name, spec)` to replace).
3. **Pass the merged map to `new Schema({nodes: …, marks: …})`** — the
   constructor compiles fresh `NodeType`/`MarkType` instances; you
   cannot reuse types across schemas.
4. **Update content expressions of existing nodes** if the new types
   need to be reachable. E.g. adding `bullet_list` to a schema whose
   `doc.content` is `"paragraph+"` won't make lists usable; you need
   `doc.content: "block+"` (or `"(paragraph | bullet_list)+"`) and your
   list types in the `block` group.

A common mistake: trying to mutate `baseSchema` in place. Every
`Schema` is frozen-by-convention; extension is *spec-merge then
re-construct*, never mutation.

For mark extension, the same `OrderedMap` pattern applies to
`spec.marks`. New marks at the end of the order get *higher* `rank` —
i.e. they sort *later* in `addToSet`'s output, meaning they render
*innermost* in the DOM serialization.
