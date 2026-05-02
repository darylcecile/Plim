# ProseMirror data model and schema

## Executive summary

ProseMirror's data model is an immutable, schema-constrained tree with a flat inline representation and a flat integer position space. Its critical design move is separating **semantic content values** from **browser DOM nodes**:

- A document is a `Node`.
- Children are stored in a `Fragment`.
- Inline styling and annotations are stored as `Mark` arrays on inline nodes, not as nested inline nodes.
- Partial document content is represented as a `Slice` with open depths.
- All document addresses are integer positions into a token stream.
- A `Schema` compiles node/mark specs into runtime `NodeType`, `MarkType`, and `ContentMatch` objects.
- DOM parsing and rendering are schema-driven but not the source of truth.

This model is compact and mathematically useful, but it has developer-experience tradeoffs: it lacks stable node identity by default, positions are hard to reason about, and schema constraints are expressed in strings rather than a typed builder.

## Node

`Node` is the main content value. The source comment states that a ProseMirror document is a `Node` tree and that nodes are persistent data structures that should not be mutated (`prosemirror-model/src/node.ts`, local lines 10-21).

Conceptually:

```ts
Node = {
  type: NodeType
  attrs: Attrs
  content: Fragment
  marks: readonly Mark[]
  text?: string // only for text nodes
}
```

Important properties:

- `type` points to a schema-scoped `NodeType`.
- `attrs` is a plain object shaped by the node type's attribute spec.
- `content` is always a `Fragment`, even for empty/leaf nodes.
- `marks` is a sorted mark set. Text and inline nodes use this for inline formatting/annotations.
- `text` exists on `TextNode` instances.
- `nodeSize` drives integer positions:
  - text nodes: text length;
  - other leaf nodes: `1`;
  - non-leaf nodes: `2 + content.size`, accounting for opening and closing tokens (`node.ts`, local lines 49-54).

### Node invariants

Confirmed in docs and source:

- Nodes are immutable by convention and may be structurally shared.
- Nodes do not have parent pointers.
- Text nodes cannot have attributes (`schema.ts`, local lines 241-244).
- Empty text nodes are rejected by the `TextNode` constructor with `RangeError("Empty text nodes are not allowed")`; text node size is exactly text length (`node.ts`, local lines 353-397).
- Adjacent text nodes with identical markup are merged by `Fragment` construction and append paths (`fragment.ts`, local lines 71-83 and 225-237).
- Empty text nodes are not part of the canonical model; the guide states they are disallowed (`website/markdown/guide/doc.md`, local lines 81-84).
- A node can be structurally invalid if created through low-level constructors; checked creation and transforms enforce schema constraints (`website/markdown/guide/schema.md`, local lines 101-112).

### Node validation helpers

`Node` exposes schema-aware checks used by commands and transforms:

- `contentMatchAt(index)` walks the node type's content-expression automaton through existing content up to a child index (`node.ts`, local lines 264-269).
- `canReplace(from, to, replacement, start, end)` checks whether replacing child indexes with a replacement fragment yields a valid end state and whether inserted child marks are allowed (`node.ts`, local lines 271-282).
- `canReplaceWith(from, to, type, marks?)` checks whether a child range can be replaced by a single node type and mark set (`node.ts`, local lines 284-291).
- `canAppend(other)` verifies append compatibility, using content replacement for non-empty content and content-expression compatibility for empty nodes (`node.ts`, local lines 293-300).
- `check()` recursively validates content, attrs, mark attrs, mark ordering, and mark exclusivity (`node.ts`, local lines 302-316).

### Why no parent pointers?

The guide explains nodes as values, like numbers: they can appear in multiple structures, can be shared by old and new document versions, and do not know where they are currently used (`website/markdown/guide/doc.md`, local lines 111-130). This enables:

- persistent structural sharing;
- cheap comparison by subtree reference/equality;
- safe history and collaboration algorithms;
- incremental view updates by comparing old/new document values.

The cost is that ancestor context must be computed from a root document and a position (`ResolvedPos`), not from a node object itself.

## Fragment

`Fragment` is the persistent child sequence for a node (`prosemirror-model/src/fragment.ts`, local lines 5-13). It wraps an array of child nodes plus the aggregate `size`.

Important operations:

- `nodesBetween` / `descendants`: recursive traversal over a position range (`fragment.ts`, local lines 26-50).
- `append`: concatenates fragments and merges adjacent text nodes with the same markup (`fragment.ts`, local lines 71-83).
- `cut`: extracts a position range, recursively cutting child content when needed (`fragment.ts`, local lines 85-104).
- `replaceChild`, `addToStart`, `addToEnd`: persistent updates returning new fragments (`fragment.ts`, local lines 113-134).
- `findIndex(pos)`: maps a relative position to child index and offset (`fragment.ts`, local lines 190-205).
- `findDiffStart` / `findDiffEnd`: used by DOM-change reconciliation to find changed content (`fragment.ts`, local lines 176-188).
- `fromArray`: canonicalizes arrays by joining adjacent text nodes with the same marks (`fragment.ts`, local lines 225-237).

`Fragment` is where ProseMirror gets much of its canonical representation. If two logically identical inline sequences can normalize to the same text-node/mark segmentation, comparison and diffing become easier.

## Mark

`Mark` is a value attached to inline nodes, such as bold, italic, code, or link. It stores a `MarkType` and attributes (`prosemirror-model/src/mark.ts`, local lines 4-17).

Marks are not nested tree nodes. A text node that is bold and italic has both marks in a sorted mark array. The official document guide explicitly contrasts this with HTML's nested inline DOM (`website/markdown/guide/doc.md`, local lines 27-84).

Important mark behavior:

- `Mark.addToSet` inserts a mark in schema rank order and enforces mark exclusions (`mark.ts`, local lines 19-45).
- If the same mark is already present, the original set is returned.
- If the new mark excludes existing marks, it removes them.
- If an existing mark excludes the new mark, the set is left unchanged.
- `Mark.sameSet` checks canonical mark-set equality (`mark.ts`, local lines 90-97).
- `Mark.setFrom` canonicalizes null/single/array inputs and sorts by mark type rank (`mark.ts`, local lines 99-110).

### MarkType

`MarkType` is allocated once per schema and owns attribute defaults, rank, and exclusion configuration (`prosemirror-model/src/schema.ts`, local lines 277-347).

The rank is determined by mark order in the schema, which controls canonical mark ordering and parse precedence (`schema.ts`, local lines 315-319; official guide `schema.md`, local lines 360-363).

## Slice

`Slice` represents content cut out of a larger document. It stores:

- `content: Fragment`;
- `openStart: number`;
- `openEnd: number`.

The open depths indicate how deeply the slice is cut through nodes on its left and right edges (`prosemirror-model/src/replace.ts`, local lines 21-42).

Example intuition:

```text
doc(paragraph("hello"))
slice "ell" inside paragraph:
  content roughly paragraph("ell")
  openStart = 1
  openEnd = 1
```

Open slices are essential for paste, drag/drop, and selection replacement. They let ProseMirror carry enough context to insert partial content into compatible places without pretending that every clipboard fragment is a complete document subtree.

Important behavior:

- `Slice.size` is content size minus open depths (`replace.ts`, local lines 44-47).
- `Slice.maxOpen` computes the maximum open depths by walking first/last children until leaf or isolating boundaries (`replace.ts`, local lines 88-95).
- Replacement validates open depths and content fit, throwing `ReplaceError` on invalid replacements (`replace.ts`, local lines 122-143).

## Integer positions

ProseMirror uses one flat integer coordinate system across the whole document. This is not a character offset and not a DOM path. It is a token stream:

- Text contributes one unit per character.
- Leaf non-text nodes contribute one unit.
- Non-leaf nodes contribute an opening token, their content, and a closing token.

Source-confirmed via `Node.nodeSize` (`node.ts`, local lines 49-54) and explained in the official document guide (`website/markdown/guide/doc.md`, local lines 243+).

### Why integer positions?

They make transforms, selections, decorations, and history easier to map. A single `StepMap` can say "from position X, old size A became new size B" and map every downstream selection/decor/step position through that change.

### Cost

Positions are compact but unintuitive:

- position `0` is inside the top document before its first child, not "before the doc";
- a paragraph's text often starts at position `1`;
- boundaries around nodes consume positions;
- positions become stale after transactions unless mapped;
- developers often need `ResolvedPos` to do useful work.

## ResolvedPos

`ResolvedPos` is the context-rich version of a flat position. It stores:

- `pos`: original integer position;
- `path`: triples of `[node, index, start]` for each depth;
- `parentOffset`: offset into the parent;
- derived `depth`.

The constructor and path representation are in `prosemirror-model/src/resolvedpos.ts`, local lines 12-28. `resolve` walks down the document by repeatedly using `Fragment.findIndex` (`resolvedpos.ts`, local lines 217-232).

`Node.resolve(pos)` calls `ResolvedPos.resolveCached`, which keeps a WeakMap keyed by document node. Each document has a tiny ring cache of 12 resolved positions (`resolvedpos.ts`, local lines 236-257). This is a micro-optimization for the many repeated position resolutions done by selections, commands, rendering, and DOM reconciliation.

Useful APIs:

- `node(depth)`: ancestor node at depth.
- `index(depth)`: child index at depth.
- `start(depth)` / `end(depth)`: absolute content boundaries for an ancestor.
- `before(depth)` / `after(depth)`: absolute positions before/after an ancestor node.
- `textOffset`: offset within a text node, or zero between nodes.
- `nodeBefore` / `nodeAfter`: adjacent node slices.
- `marks()` / `marksAcross()`: active marks with inclusive-mark handling.
- `sharedDepth(pos)`: deepest ancestor shared with another position.
- `blockRange(other, pred?)`: compute a block-level `NodeRange`.

Source ranges: `resolvedpos.ts`, local lines 37-191.

### NodeRange

`NodeRange` represents a range in a shared ancestor at a given depth. Transform helpers use it for block operations such as wrapping, lifting, and joining. It is defined in `resolvedpos.ts`, local lines 261+.

## Schema

`Schema` compiles static specs into runtime type objects and parser/serializer caches. Every document is associated with a schema.

### SchemaSpec

A schema spec has:

- `nodes`: map or ordered map of node specs;
- `marks`: optional map or ordered map of mark specs;
- `topNode`: optional top node name, defaulting to `doc`.

The source defines this around `prosemirror-model/src/schema.ts`, local lines 349-369. The official guide emphasizes that every schema needs a top node and a `text` node (`website/markdown/guide/schema.md`, local lines 36-44).

### Schema construction

The `Schema` constructor (`schema.ts`, local lines 595-640):

1. Converts node and mark specs into `OrderedMap`s, preserving declaration order.
2. Compiles `NodeType` and `MarkType` objects.
3. Rejects names that are both node and mark types.
4. Parses each node type's content expression into `ContentMatch`, caching identical expression strings in `contentExprCache`.
5. Computes `inlineContent` from the content match.
6. Registers at most one `linebreakReplacement` inline leaf node.
7. Computes each node type's `markSet`:
   - `null` means all marks allowed;
   - `[]` means no marks allowed;
   - an array means an explicit allow-list.
8. Computes each mark type's exclusion set:
   - omitted `excludes` defaults to self-exclusion;
   - `excludes: ""` means exclude nothing;
   - otherwise names/groups are resolved with `gatherMarks`.
9. Binds JSON deserializers and stores `topNodeType`.
10. Initializes `schema.cached`, which parser/serializer modules use for per-schema caches such as `domParser` and `domSerializer`.

### NodeType

`NodeType` is a schema-scoped type tag for nodes (`schema.ts`, local lines 56-87). It stores:

- `name`;
- `schema`;
- original `spec`;
- groups;
- attribute descriptors/default attrs;
- `contentMatch`;
- mark set;
- flags such as `isBlock`, `isText`, `isInline`, `isTextblock`, `isLeaf`, `isAtom`.

Important constructors/checkers:

- `create`: creates a node and defaults attrs, but does not check content (`schema.ts`, local lines 146-155).
- `createChecked`: checks content against schema (`schema.ts`, local lines 157-164).
- `createAndFill`: inserts required filler content when possible (`schema.ts`, local lines 166-184).
- `validContent` / `checkContent`: validate fragments and allowed marks (`schema.ts`, local lines 186-201).
- `allowsMarkType`, `allowsMarks`, `allowedMarks`: enforce mark constraints (`schema.ts`, local lines 209-233).

### MarkType

`MarkType` is a schema-scoped type tag for marks (`schema.ts`, local lines 277-347). It stores:

- `name`;
- `rank`;
- `schema`;
- original `spec`;
- attrs/default instance;
- excluded mark types.

Mark order matters. It determines canonical mark-set order and parse precedence.

If all mark attrs have defaults, `MarkType` pre-creates a cached `instance`; `markType.create(null)` can return that shared mark value (`schema.ts`, local lines 300-312). This mirrors the model's broader structural-sharing strategy.

By default, a mark excludes itself, preventing multiple instances of the same mark type on one text node. A mark spec can set `excludes: ""` to allow multiple differently attributed instances, or can name other marks/groups to enforce mutual exclusion (`schema.ts`, local lines 622-625).

## Content expressions and ContentMatch

Node specs use content expressions such as:

```text
block+
paragraph text*
(paragraph | blockquote)+
heading paragraph+
```

The official guide describes them as regex-like expressions over node names and groups (`website/markdown/guide/schema.md`, local lines 45-82). The source parses each string into an expression tree, builds an NFA, converts it to a DFA, and checks for dead ends (`prosemirror-model/src/content.ts`, local lines 23-30 and parser/compiler code below local line 169).

At runtime, `ContentMatch` is a DFA state:

- `validEnd`: whether the current state is a valid end for the parent node.
- `next`: outgoing edges of `{type, next}`.
- `matchType(type)`: advance by one child type.
- `matchFragment(fragment)`: advance over a child sequence.
- `fillBefore(after, toEnd?)`: synthesize filler nodes needed before a fragment.
- `findWrapping(target)`: find wrapper node types that would make a target fit.
- `defaultType`: first generatable node type from this state.

Source ranges: `prosemirror-model/src/content.ts`, local lines 6-20, 33-49, 55-98, and 100-133.

### Content-expression implications

1. Schema order matters because default filler generation picks the first valid type (`website/markdown/guide/schema.md`, local lines 83-99).
2. Required positions cannot use node types with required attrs and no defaults, because the library must be able to generate filler nodes (`schema.md`, local lines 171-181).
3. The schema language is compact but stringly typed. Mistyped names/groups fail at runtime.
4. Extensions can influence structural behavior through schema flags (`isolating`, `defining`, `atom`, `code`, `selectable`, `draggable`) without directly changing transform code.

## DOM parsing

`DOMParser` converts DOM into a ProseMirror node or open slice (`prosemirror-model/src/from_dom.ts`, local lines 179-237).

Inputs come from:

- initial HTML import;
- clipboard paste;
- drag/drop;
- live contenteditable DOM reparsing after browser input.

Schema rules:

- `parseDOM` on mark specs and node specs contributes parse rules.
- Rules are sorted by priority; default priority is 50 (`from_dom.ts`, local lines 277-314).
- Tag rules can match CSS selectors.
- Style rules can match inline CSS properties/values.
- Parse options can provide context, top node, open parsing, whitespace preservation, selected DOM positions to find, and `ruleFromNode` overrides.

In live editing, `prosemirror-view/src/domchange.ts` calls `DOMParser.parse` over a narrowed range and passes:

- `topNode`: current parent;
- `topMatch`: current content match;
- `topOpen: true`;
- `from`/`to` DOM offsets;
- whitespace mode;
- `findPositions` for DOM selection anchors;
- `ruleFromNode` so known `ViewDesc` nodes can preserve content/attrs.

Source range: `domchange.ts`, local lines 15-56.

## DOM serialization

`DOMSerializer` converts model content to DOM (`prosemirror-model/src/to_dom.ts`, local lines 25-40).

`DOMOutputSpec` supports:

- direct DOM nodes;
- `{dom, contentDOM}`;
- array specs like `["p", 0]`;
- strings for text nodes;
- `0` as the content hole (`to_dom.ts`, local lines 7-23).

Important behavior:

- `serializeFragment` keeps active mark DOM wrappers open across adjacent inline nodes where possible (`to_dom.ts`, local lines 42-74).
- `serializeNodeInner` uses schema node `toDOM`, then serializes content into the content hole (`to_dom.ts`, local lines 76-87).
- `serializeNode` wraps a serialized node in its marks from inner to outer (`to_dom.ts`, local lines 89-104).
- `fromSchema` caches a serializer built from schema `toDOM` functions (`to_dom.ts`, local lines 130-148).

## JSON serialization

Nodes, marks, fragments, and slices have JSON formats. This is good for persistence and tests, but ProseMirror's JSON is not a CRDT or operational log. Collaboration and history use steps/maps, not just document JSON snapshots.

## Key data-model tradeoffs for a new editor

### What ProseMirror gets right

- Pure content model independent from DOM.
- Flat inline marks avoid DOM's awkward nested inline tree.
- Immutable values make history, collaboration, and incremental rendering tractable.
- Schema constraints are strong enough to prevent invalid final documents.
- Open slices are a practical clipboard/selection abstraction.
- Position maps are a powerful primitive for selection/decor/history/collab.

### What is painful

- Integer positions are not self-documenting.
- There is no stable node identity unless schema authors add IDs as attrs.
- Schema content expressions are strings and not type-inferred.
- Transform errors often surface as runtime failures.
- Mark sets and schema groups are rank/order dependent.
- Low-level constructors can create invalid nodes.
- The same schema object controls model validity, DOM parse/render, editor affordances, and some transform behavior, which can make extension composition subtle.
