# Design implications for Plim

## Executive summary

ProseMirror's architecture is strong because it separates immutable document state from browser DOM, represents changes explicitly, and treats contenteditable as an unreliable but necessary input device. A better-DX editor should keep those fundamentals while improving the extension model, type safety, action pipeline, debugging, and browser abstraction.

The opportunity for Plim is not to discard ProseMirror's hard-won browser lessons. It is to make the same classes of power easier to use:

- typed schema/extensions instead of stringly specs;
- typed transactions/actions/events instead of arbitrary metadata;
- stable structural IDs where useful, not only integer positions;
- explicit extension ordering/dependencies;
- clearer browser/input state machines;
- better observability for why an edit/render/plugin behaved a certain way.

## What to preserve

### 1. Pure document model independent from DOM

ProseMirror's core document values are DOM-independent. This enables tests, server processing, collaboration, history, import/export, and rendering adapters.

Plim should keep:

- immutable content values;
- schema/extension-declared validity;
- JSON or structured serialization;
- DOM parser/serializer as adapters, not source of truth.

### 2. Explicit change objects

ProseMirror's steps/maps are the foundation for:

- selection mapping;
- decoration mapping;
- undo/redo;
- collaboration/rebasing;
- plugin state updates;
- debugging.

Plim should keep an explicit operation/transaction trail. Even if Plim uses a different operation format, every state change should expose:

- before/after document identity/version;
- changed ranges or changed node IDs;
- invertibility when possible;
- mapping for selections/anchors/decorations;
- semantic action metadata.

### 3. Browser-native input where necessary

ProseMirror succeeds because it lets the browser handle:

- caret movement;
- bidi text;
- IME composition;
- spellcheck/autocorrect;
- mobile keyboard behavior;
- native selection gestures.

Plim should not try to fully emulate text input unless it intentionally chooses a non-contenteditable architecture with a much larger browser-input burden.

### 4. Incremental rendering

Persistent values plus a descriptor tree allow ProseMirror to preserve DOM nodes and avoid rewriting selection/composition. Plim should keep:

- a state-to-DOM reconciler;
- a DOM-to-model position bridge;
- composition protection;
- minimal selection writes.

### 5. View-only decorations

Separating annotations/overlays from document content is correct. Search results, comments, cursors, selections, placeholders, drop indicators, and menus should not pollute document state unless they are durable content.

## What to improve

### 1. Extension definition and type safety

ProseMirror schemas are powerful but stringly typed:

- node names are strings;
- group names are strings;
- content expressions are strings;
- mark names are strings;
- transaction metadata keys are strings/plugins;
- parse/render rules are loosely typed.

Plim can offer typed extension builders:

```ts
const paragraph = defineBlock({
  name: 'paragraph',
  content: content.inline.zeroOrMore(),
  marks: marks.allow('bold', 'italic', 'link'),
  attrs: attrs.object({align: attrs.enum(['left', 'center', 'right']).default('left')}),
  render: blockRenderer(...)
});
```

Goals:

- infer node attrs from extension definitions;
- infer allowed commands/actions by selection context;
- validate content expressions at definition time;
- detect extension name/group conflicts early;
- expose generated runtime schema for debugging.

### 2. Positions plus stable identities

ProseMirror's integer positions are powerful but fragile for app developers. Plim should consider a hybrid:

- integer/text offsets for fine-grained text editing and mapping;
- stable block/node IDs for application-level operations, comments, cross-references, persistence, and UI state;
- resolved anchors that can map by operation history and fall back to ID/path/offset.

Potential anchor shape:

```ts
type Anchor =
  | {kind: 'text', nodeId: NodeId, offset: number, bias?: -1 | 1}
  | {kind: 'node-before', nodeId: NodeId}
  | {kind: 'node-after', nodeId: NodeId}
  | {kind: 'absolute', pos: number, bias?: -1 | 1};
```

The important lesson from ProseMirror: any anchor abstraction must still support deterministic mapping through edits.

### 3. Typed transaction metadata and action causes

ProseMirror metadata is flexible but hard to discover. Plim should standardize event/action causality:

```ts
type TransactionCause =
  | {kind: 'keyboard', key: string, shortcut?: string}
  | {kind: 'text-input', inputType?: string, text: string}
  | {kind: 'composition', id: number, phase: 'update' | 'commit'}
  | {kind: 'paste', plainText: boolean}
  | {kind: 'drop', moved: boolean}
  | {kind: 'command', commandId: string}
  | {kind: 'remote', clientId: string};
```

Benefits:

- history grouping can be cause-aware;
- analytics/debugging can inspect why a transaction happened;
- extensions can handle causes without string-key conventions;
- devtools can show a readable event timeline.

### 4. Explicit action pipeline

ProseMirror has commands, input rules, keymaps, DOM handlers, filters, appenders, and plugin state. Plim can unify these as an ordered action pipeline:

```text
Trigger
  -> guards
  -> intent/action
  -> transaction builder
  -> validators/normalizers
  -> commit
  -> effects
```

This maps well to the existing Plim requirements in `research/plim-architecture/requirements.md`, where actions have triggers, validation rules, cancellation triggers, and `perform` handlers.

Recommended Plim concepts:

- `Trigger`: keyboard, text, clipboard, pointer, composition, API call.
- `Guard`: typed predicate over editor state/selection/context.
- `Action`: named behavior with priority and ownership.
- `TransactionBuilder`: typed model mutations.
- `Normalizer`: explicit post-transaction invariant fixer.
- `Effect`: view/app side effect after commit.

This would make ProseMirror's implicit plugin ordering easier to inspect.

### 5. Extension ordering and dependencies

ProseMirror relies heavily on plugin order. Plim should make extension relationships explicit:

```ts
defineExtension({
  id: 'lists',
  after: ['blocks'],
  before: ['markdown-input-rules'],
  provides: ['block:listItem', 'action:indent'],
  requires: ['selection:block-range']
});
```

Runtime should expose:

- final extension order;
- conflicts;
- which extension handled an event;
- which extension appended/normalized a transaction;
- why a command/action was not applicable.

### 6. Browser input adapter as its own subsystem

ProseMirror's browser workarounds are hard-won. Plim should isolate similar behavior in a dedicated package/module:

```text
browser-input
  - keydown/beforeinput/input/composition state machine
  - selection reader/writer
  - mutation observer
  - clipboard/drop parser
  - browser quirks table
  - regression tests
```

The model/action core should not know about Safari composition bugs or bogus `<br>` cleanup.

### 7. Better custom component contracts

ProseMirror node views are powerful but sharp. Plim should define clearer custom component modes:

| Mode | Meaning |
| --- | --- |
| Managed content | Plim owns children inside a declared content mount |
| Opaque atom | Component owns its DOM; editor treats it as one unit |
| Hybrid widget | Component has internal UI plus editable child regions |
| Portal overlay | UI is outside document flow but anchored to content |

Each mode should have typed lifecycle hooks:

- `render`;
- `update`;
- `destroy`;
- `handleEvent`;
- `handleMutation`;
- `selectionBridge`;
- `getContentMount`.

Avoid making every advanced extension author learn low-level mutation observer rules.

### 8. Devtools and tracing

ProseMirror is powerful but opaque when something goes wrong. Plim should build tracing from the start:

- transaction log with causes, steps, maps, selection before/after;
- extension handler trace;
- schema validation trace;
- render trace showing reused/redrawn nodes;
- DOM reconciliation trace for input;
- composition timeline;
- decoration mapping trace;
- history grouping trace.

This is especially important for a "better DX and extensibility" goal.

## Suggested Plim architecture

```text
@plim/model
  Immutable document values, marks, attrs, schema runtime, JSON

@plim/ops
  Operations/transactions, maps, anchors, inversion, normalization

@plim/state
  EditorState, selection, extension state fields, reducer pipeline

@plim/extensions
  Typed extension builder, dependency graph, action registry

@plim/browser
  Contenteditable adapter, events, selection, mutation parsing, clipboard/drop

@plim/view
  Renderer/reconciler, descriptor tree, decorations, component adapters

@plim/devtools
  Transaction/action/render/input tracing
```

## Open design questions

1. **Document shape:** Should Plim model everything as a ProseMirror-like tree, a Notion-like block graph, or a hybrid tree of stable-ID blocks with inline text models?
2. **Operation model:** Should operations be ProseMirror-like positional steps, ID-addressed operations, CRDT-native operations, or a layered abstraction over multiple backends?
3. **Schema extensibility:** Should extension content constraints be fully static, runtime dynamic, or context-sensitive?
4. **Rendering target:** Should DOM be the only first-class view target, or should native/canvas/server renderers be supported?
5. **Collaboration:** Should the core operation format be designed for CRDT/OT from the start?
6. **Node identity:** Are node IDs mandatory for all block nodes, optional attrs, or external indexes?
7. **Input architecture:** Should Plim rely on contenteditable + mutation reconciliation like ProseMirror, or use a beforeinput-first architecture with DOM fallback?

## Concrete recommendations

1. Start with a ProseMirror-inspired immutable model and transaction system, but design a typed API over it.
2. Use stable IDs for block-level nodes by default; keep mappable offsets for inline editing.
3. Make extension definitions declarative and type-inferred.
4. Build an explicit action pipeline that unifies keymaps, input rules, commands, and validations.
5. Treat browser input as a separate adapter with a documented state machine and regression suite.
6. Keep custom views powerful but classify them into safer modes.
7. Build devtools/tracing as part of the core architecture, not as an afterthought.
8. Preserve ProseMirror's proven narrow DOM reparse strategy for contenteditable changes unless Plim commits to a different input architecture with equal browser coverage.

