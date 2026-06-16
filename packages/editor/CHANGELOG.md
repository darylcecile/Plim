# @plim/editor

## 0.1.2

### Patch Changes

- d733374: Undo and redo now flow through the normal `dispatch` path as real transactions instead of restoring a whole `EditorState` snapshot. `dispatch` records each transaction's forward ops plus their computed inverse on the history entry; undo commits the inverse ops and redo commits the original ops (both with `meta.addToHistory = false`, a `meta.history` tag, and a restored caret via `meta.nextSelection`). Because these transactions fire the editor's transaction listeners, an attached `TransactionLedger` records undo/redo and `replay()` stays faithful to the live document across them. Non-invertible transactions transparently fall back to the previous snapshot-restore behavior so undo never breaks.
- Updated dependencies [d733374]
  - @plim/core@0.1.2
  - @plim/markdown@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [8016478]
  - @plim/core@0.1.1
  - @plim/markdown@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [8b5568f]
- Updated dependencies [7e5e783]
  - @plim/core@0.1.0
  - @plim/markdown@0.1.0

## 0.0.4

### Patch Changes

- Fixed bug with handle affordances and selection replacement
- Updated dependencies
  - @plim/core@0.0.4
  - @plim/markdown@0.0.4

## 0.0.3

### Patch Changes

- 4adc206: Fix mention ActionPanel alignment
- Updated dependencies [4adc206]
  - @plim/markdown@0.0.3
  - @plim/core@0.0.3

## 0.0.2

### Patch Changes

- 2d1ec6b: Package size reduction (removed map files from distributed library)
- Updated dependencies [2d1ec6b]
  - @plim/markdown@0.0.2
  - @plim/core@0.0.2
