# @plim/editor

The **view layer** for the [Plim](https://github.com/darylcecile/plim) block editor. It mounts a Plim document into a `contenteditable`, and owns the floating selection toolbar, the block-handle gutter, paste/clipboard handling, drag-and-drop, and the keyboard pipeline. It ships its own stylesheet and is framework-agnostic — React is optional (see [`@plim/react`](https://github.com/darylcecile/plim/tree/main/packages/react)).

## Install

```sh
pnpm add @plim/editor @plim/core
```

Import the bundled stylesheet once at your app's entry point:

```ts
import '@plim/editor/styles.css';
```

## Quickstart

`deriveEditor` mounts a `PlimDriver` into a DOM container and returns an `AgnosticEditor` — an `EditorHandle` plus `mount()`, `destroy()`, and a live `view`.

```ts
import { PlimDriver, paragraphBlock, headingBlock, boldMark, italicMark } from '@plim/core';
import { deriveEditor, attachContainer } from '@plim/editor';
import { contentFromMarkdown } from '@plim/markdown';
import '@plim/editor/styles.css';

const plim = new PlimDriver({
  registeredMarks: [boldMark, italicMark],
  registeredBlocks: [paragraphBlock, headingBlock],
});

const editor = deriveEditor(plim, {
  containerAdapter: attachContainer(() => document.querySelector('#editor')),
  initialContent: contentFromMarkdown('# Hello'),
  autoFocus: true,
});

editor.mount();
// …later
editor.destroy();
```

## `DeriveEditorOptions`

```ts
type DeriveEditorOptions = {
  containerAdapter: ContainerAdapter;   // where to mount; use attachContainer(getter)
  initialContent?: DocumentNode;        // e.g. from contentFromMarkdown(...)
  readonly?: boolean;                   // mount non-editable
  autoFocus?: boolean;
  renderReactBlock?: (host, payload, descriptor) => void; // bridge for toComponent blocks
};
```

`attachContainer(() => HTMLElement | null)` adapts any element lookup into the `ContainerAdapter` the editor expects.

## Hosting components inside custom blocks

`@plim/editor` does not depend on React, but it exposes a `renderReactBlock` bridge so a host can mount a component tree into the element the editor creates for a block's `toComponent`. `@plim/react`'s `<PlimEditor>` wires this up for you; if you are integrating another framework, provide your own `renderReactBlock` that mounts/updates into the supplied `host` element.

## Paste & clipboard

The package handles paste end-to-end and exposes the primitives if you need them directly: `pasteHtml`, `pasteMarkdown`, `pastePlainText`, `pastePlimNative`, `pasteUrlOnSelection`, plus `looksLikeMarkdown` / `looksLikeUrl` detectors and `writeClipboardMarkdown`. Plim's own clipboard payloads are tagged with `PLIM_CLIPBOARD_MIME` / `PLIM_CLIPBOARD_VERSION` so copy/paste between Plim editors is lossless.

## Toolbar & view internals

`mountView` and `mountToolbar` are the lower-level mounts that `deriveEditor` composes (`View` / `ViewOptions`, `ToolbarMount` / `ToolbarMountOptions`). Most apps use `deriveEditor` and never touch these directly.

## Where to go next

- **React bindings** — [`@plim/react`](https://github.com/darylcecile/plim/tree/main/packages/react) (`<PlimEditor>`, `useEditorHandle`, slash & mention menus).
- **Document model & APIs** — [`@plim/core`](https://github.com/darylcecile/plim/tree/main/packages/core).
- **Full API contract** — [`REQUIREMENTS.md`](https://github.com/darylcecile/plim/blob/main/REQUIREMENTS.md).
- **Reference app** — [`examples/notion-clone`](https://github.com/darylcecile/plim/tree/main/examples/notion-clone).

## License

See the [LICENSE](./LICENSE) file in this package.
