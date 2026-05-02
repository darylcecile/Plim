# ProseMirror research coverage matrix

## Scope reviewed

This matrix maps the research packet back to the original goal: understand ProseMirror in enough detail to design a new editor with better developer experience and extensibility, while respecting browser constraints.

The packet is source-backed against the pinned snapshots in `00-source-index.md`.

## Coverage by goal

| Research goal | Coverage | Primary documents |
| --- | --- | --- |
| Understand overall architecture | Complete | `01-architecture-overview.md`, `00-source-index.md` |
| Understand data model in full detail | Complete for model/schema primitives plus mark, slice, and ContentMatch edge cases | `02-data-model-and-schema.md`, `08-transform-replacement-and-collaboration-deep-dive.md`, `10-edge-case-gap-closure.md` |
| Understand how input is processed | Complete for keyboard, pointer, composition, DOM mutations, clipboard, drag/drop, selection, and filler-node cleanup | `04-input-processing-and-browser-constraints.md`, `07-browser-input-rendering-deep-dive.md`, `10-edge-case-gap-closure.md` |
| Understand rendering | Complete for EditorView, ViewDesc, node views, decorations, selection sync, composition protection, and node-view lifecycle edge cases | `05-rendering-and-view.md`, `07-browser-input-rendering-deep-dive.md`, `10-edge-case-gap-closure.md` |
| Understand component interactions | Complete across model, transform, state, plugins, view, history, collab, and rebase/history edge cases | `01-architecture-overview.md`, `03-transactions-state-and-plugins.md`, `08-transform-replacement-and-collaboration-deep-dive.md`, `10-edge-case-gap-closure.md` |
| Understand browser constraints | Complete for contenteditable, selection, IME, mutation observation, coordinate mapping, clipboard HTML, and browser-inserted DOM artifacts | `04-input-processing-and-browser-constraints.md`, `07-browser-input-rendering-deep-dive.md`, `10-edge-case-gap-closure.md` |
| Extract implications for a better-DX editor | Complete as recommendations, open questions, subsystem proposals, and explicit edge-case design requirements | `06-design-implications-for-plim.md`, `08-transform-replacement-and-collaboration-deep-dive.md`, `10-edge-case-gap-closure.md` |

## Source reproducibility

The packet now includes:

- exact package/repository snapshots and package versions in `00-source-index.md`;
- a clone/checkout script for every cited source package;
- local line references tied to those snapshots;
- permalink examples in `07-browser-input-rendering-deep-dive.md`;
- collab source coverage added for rebasing and operation design;
- `10-edge-case-gap-closure.md` covering QA-requested details around rebase failures, mirror maps, fitting fallbacks, mark exclusions, ContentMatch compilation, composition IDs, multi-range selection, filler `<br>` cleanup, coordinate quirks, node views, and history/collab interactions.

Known caveat: ProseMirror packages are separately versioned and may advance independently. Claims marked by local line references should be treated as claims about the pinned snapshots, not moving `master` branches.

## Key findings for Plim design

| Area | Finding | Plim implication |
| --- | --- | --- |
| Document model | Immutable, schema-constrained tree with flat inline marks and integer token positions | Preserve DOM-independent immutable state; improve DX with typed schema builders and friendlier anchors |
| Positions | Single integer coordinate space maps efficiently through steps but is unintuitive | Provide higher-level anchors/IDs without losing deterministic offset mapping |
| Slices | Open-depth slices model partial content for paste, drag/drop, and selection replacement | Keep a first-class partial-content abstraction |
| Transforms | Every edit becomes steps plus maps; replacement fitting is schema-aware | Keep explicit operation objects and separate exact edits from user-intent fitting |
| State | EditorState is a persistent reducer output; plugins contribute ordered state fields and hooks | Preserve reducer model; make extension order/dependencies visible |
| Plugins | Props, filters, appenders, metadata, and views form a flexible but distributed extension system | Unify extension/action pipeline and add tracing |
| Input | ProseMirror is not `beforeinput`-first; it often lets the browser mutate DOM and reparses a narrowed range | Keep mutation/selection reconciliation fallback even if Plim uses modern input events |
| IME | Composition is a state machine involving deferred flushes, metadata, and render protection | Treat composition as a first-class browser subsystem |
| Rendering | ViewDesc is a custom mutable DOM-description tree, not generic VDOM | Keep a descriptor bridge for DOM-to-model mapping and incremental rendering |
| Node views | Custom views are powerful but sharp around events, mutations, selection, and contentDOM | Define clearer component modes and typed lifecycle contracts |
| Decorations | View-only annotations are persistent and mapped through transactions | Keep overlays out of document state but make mapping and lifecycle easier |
| History/collab | Inversion, maps, mirror mappings, and bookmarks allow undo/rebase without snapshots | Design operation, history, and collaboration primitives together |

## Remaining open questions

These are product/design choices for Plim, not gaps in the ProseMirror research:

1. Whether Plim should use ProseMirror-like integer positions internally, path+offset anchors, CRDT-native IDs, or a hybrid.
2. Whether Plim should be contenteditable-based, hidden-textarea/canvas-based, or support multiple view adapters.
3. How much schema constraint should be static/type-level versus runtime.
4. Whether extension ordering should be purely declarative dependencies or a phased pipeline with priorities.
5. How collaboration should work: central-authority rebasing, CRDT, OT, or adapter interface.

## QA conclusion

The packet now covers the requested ProseMirror research areas with source-backed detail sufficient to inform a new editor architecture, including the edge cases raised during QA. The most important follow-up for Plim is not more ProseMirror reading, but translating these findings into Plim-specific architecture decisions and browser regression requirements.
