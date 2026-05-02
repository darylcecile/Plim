# Plim React Tailwind editor example

This example shows how to use the React package (`@plim/react`) inside a Vite app styled with Tailwind CSS. It demonstrates a host-app integration rather than the framework-neutral DOM wiring used by `examples/basic-editor`.

## Run it

From the repository root:

```sh
pnpm install
pnpm --filter @plim/example-react-tailwind-editor dev
```

Useful checks:

```sh
pnpm --filter @plim/example-react-tailwind-editor typecheck
pnpm --filter @plim/example-react-tailwind-editor build
```

## What it demonstrates

- `PlimEditorProvider`, `PlimEditor`, `usePlimEditor`, `usePlimEditorState`, and `usePlimCommand`.
- A seeded `DocumentState` created with `@plim/model`.
- Local persistence through `createLocalStoragePersistenceAdapter`.
- Toolbar commands that append paragraphs, to-dos, and quotes through the React command API.
- A live inspector that reads editor status, dirty state, selection kind, and block counts from React state.
- Tailwind styling for the default React renderer classes such as `.plim-editor`, `.plim-block`, `.plim-rich-text`, `.plim-page-title`, and `.plim-to-do`.

The React bindings provide the editor runtime, command execution, default block renderers, and persistence bridge. Tailwind is only used by the host app for layout, theming, and renderer class styling.
