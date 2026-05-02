import { plainTextFromRichText } from '@plim/model';
import type { BlockId, BlockRecord, PageId, RichText } from '@plim/model';
import { EditorError } from './errors.js';
import type { EditorFacade, EditorState, Renderer, RendererContext } from './types.js';

export interface RenderSurfaceOptions {
  readonly editor: EditorFacade;
  readonly getState: () => EditorState;
  readonly rendererForBlock: (block: BlockRecord) => Renderer | undefined;
  readonly onRendererError: (rendererId: string, error: EditorError, blockId?: BlockId) => void;
}

export class VanillaEditorSurface {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private readonly mountedElements = new Map<BlockId, { element: HTMLElement; renderer: Renderer; block: BlockRecord }>();

  constructor(private readonly options: RenderSurfaceOptions) {}

  mount(host: HTMLElement): void {
    if (this.host) throw new EditorError('already_mounted', 'Editor is already mounted');
    const ownerDocument = host.ownerDocument;
    const root = ownerDocument.createElement('div');
    root.setAttribute('data-plim-editor', 'true');
    root.setAttribute('role', 'document');
    root.tabIndex = 0;
    host.replaceChildren(root);
    this.host = host;
    this.root = root;
    this.render();
  }

  unmount(): void {
    for (const { element, renderer, block } of this.mountedElements.values()) {
      try {
        renderer.unmount?.(element, block);
      } catch (cause) {
        this.options.onRendererError(renderer.id, toRendererError(cause), block.id);
      }
    }
    this.mountedElements.clear();
    this.root?.replaceChildren();
    this.host?.replaceChildren();
    this.root = null;
    this.host = null;
  }

  focus(): void {
    this.root?.focus();
  }

  render(): void {
    const root = this.root;
    if (!root) return;
    for (const { element, renderer, block } of this.mountedElements.values()) {
      try {
        renderer.unmount?.(element, block);
      } catch (cause) {
        this.options.onRendererError(renderer.id, toRendererError(cause), block.id);
      }
    }
    this.mountedElements.clear();
    root.replaceChildren();
    const state = this.options.getState();
    for (const pageId of state.document.workspace.rootPageIds) {
      this.renderBlock(pageId, root);
    }
  }

  renderChildren(parentId: BlockId | PageId, host: HTMLElement): void {
    const state = this.options.getState();
    const parent = state.document.blocks[parentId as BlockId];
    for (const childId of parent?.children ?? []) {
      this.renderBlock(childId, host);
    }
  }

  private renderBlock(blockId: BlockId, host: HTMLElement): void {
    const state = this.options.getState();
    const block = state.document.blocks[blockId];
    if (!block) return;
    const renderer = this.options.rendererForBlock(block) ?? defaultRenderer;
    try {
      const element = renderer.render({
        block,
        state,
        editor: this.options.editor,
        domDocument: host.ownerDocument,
        renderChildren: (parentId, childHost) => this.renderChildren(parentId, childHost)
      } as RendererContext);
      if (!element.hasAttribute('data-plim-block-id')) element.setAttribute('data-plim-block-id', String(block.id));
      if (!element.hasAttribute('data-plim-block-type')) element.setAttribute('data-plim-block-type', block.type);
      host.append(element);
      this.mountedElements.set(block.id, { element, renderer, block });
      this.renderChildren(block.id, element);
    } catch (cause) {
      const error = toRendererError(cause);
      this.options.onRendererError(renderer.id, error, block.id);
      host.append(renderFallback(host.ownerDocument, block, error));
    }
  }
}

export const defaultRenderer: Renderer = {
  id: 'plim.default.block',
  mode: 'both',
  render(ctx) {
    const element = ctx.domDocument.createElement('section');
    element.className = 'plim-block';
    element.setAttribute('data-plim-block-id', String(ctx.block.id));
    element.setAttribute('data-plim-block-type', ctx.block.type);
    element.setAttribute('role', ctx.block.type === 'page' ? 'article' : 'group');

    const label = ctx.domDocument.createElement(ctx.block.type === 'page' ? 'h1' : 'div');
    label.className = 'plim-block-content';
    label.textContent = blockDisplayText(ctx.block);
    element.append(label);
    return element;
  }
};

export function blockDisplayText(block: BlockRecord): string {
  const data = block.data as Record<string, unknown>;
  const title = data.title;
  if (isRichText(title)) return plainTextFromRichText(title) || 'Untitled';
  const richText = data.richText;
  if (isRichText(richText)) return plainTextFromRichText(richText) || placeholderFor(block.type);
  const expression = data.expression;
  if (typeof expression === 'string') return expression || placeholderFor(block.type);
  const url = data.url;
  if (typeof url === 'string') return url;
  return placeholderFor(block.type);
}

function isRichText(value: unknown): value is RichText {
  return Array.isArray(value);
}

function placeholderFor(type: string): string {
  return type === 'divider' ? '—' : `[${type}]`;
}

function renderFallback(document: Document, block: BlockRecord, error: EditorError): HTMLElement {
  const element = document.createElement('section');
  element.className = 'plim-block plim-block-error';
  element.setAttribute('data-plim-block-id', String(block.id));
  element.setAttribute('data-plim-block-type', block.type);
  element.setAttribute('role', 'alert');
  element.textContent = `Unable to render ${block.type}: ${error.message}`;
  return element;
}

function toRendererError(cause: unknown): EditorError {
  return cause instanceof EditorError
    ? cause
    : new EditorError('renderer_failed', cause instanceof Error ? cause.message : 'Renderer failed', { cause });
}
