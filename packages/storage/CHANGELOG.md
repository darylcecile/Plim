# @plim/storage

## 0.4.0

### Minor Changes

- 9b3a12c: Add `PlimInputBox`, a stripped-down single-block editor for chat/comment-style composers.

  `PlimInputBox` is a mini `PlimEditor`: a single block only (Enter never splits), with no
  `+` add button and no drag handle, plus a configurable placeholder. It still supports the
  non-multi-block extensions — mojis, markdown input rules, slash commands, mentions and
  inline formatting — while skipping multi-block concerns (the collab hub, ledger and
  transport are simply not wired up). Enter submits, Shift+Enter inserts a soft newline, and
  Cmd/Ctrl+Enter always submits; the input clears on submit by default. Multi-paragraph
  pastes collapse to soft newlines so the input stays single-block.

  Pop-up menus (slash, mention) now anchor to the whole input box in single-block mode, so
  they flip cleanly above the composer instead of covering the text being typed.

### Patch Changes

- Updated dependencies [9b3a12c]
  - @plim/core@0.4.0
  - @plim/transports@0.4.0

## 0.3.0

### Minor Changes

- Align all `@plim` package versions with a minor bump so every published package
  stays in lockstep at the same version, including the new `@plim/mojis` package.
- 94b47dd: Add three optional, non-breaking add-on packages:

  - **`@plim/html`** — a headless, SSR-safe serializer that renders a Plim document model to an HTML string (`serializeToHTML`) with overridable per-block / per-mark renderers and escaped-by-default output. No DOM, so it runs in Node, edge runtimes, email, and SEO pipelines.
  - **`@plim/storage`** — durable persistence primitives: pluggable `StorageAdapter`s (memory, `localStorage`, IndexedDB, and a `@plim/transports` server-document adapter) composed with debounced snapshot autosave (`createAutosave`).
  - **`@plim/test-utils`** — runner-agnostic testing helpers (fluent document/mark builders, a headless `createTestEditor` backed by the real driver, `applyTx`, and inspectors/assertions) for unit-testing custom blocks, marks, and extensions without a browser.

  These are additive primitives; no existing API changes. All `@plim/*` packages are bumped together to keep the suite on a single synchronized version.

### Patch Changes

- Updated dependencies
- Updated dependencies [30ad81e]
- Updated dependencies [94b47dd]
  - @plim/transports@0.3.0
  - @plim/core@0.3.0
