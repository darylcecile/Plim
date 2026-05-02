import {
  defaultBlockData as modelDefaultBlockData,
  isAllowedUrl,
  normalizeRichText,
  richTextFromPlainText,
  type BlockDataByType,
  type BlockType,
  type DataSourceId,
  type DatabaseId,
  type FileRef,
  type IconRef,
  type JsonObject,
  type NotionColor,
  type PageId,
  type RichText,
  type URLString,
  type UserId
} from '@plim/model';

export type CompatibilityOnlyBlockType = 'link_to_page' | 'button';
export type CatalogBlockType = BlockType | CompatibilityOnlyBlockType;

export type BlockCategory =
  | 'basic'
  | 'heading'
  | 'list'
  | 'page'
  | 'layout'
  | 'table'
  | 'media'
  | 'embed'
  | 'database'
  | 'advanced'
  | 'compatibility';

export type RichTextFieldName = 'richText' | 'title' | 'caption' | 'cells' | 'label' | 'confirmation.message';
export type PlainTextFieldName = 'expression' | 'url';

export interface MarkdownShortcut {
  readonly trigger: string;
  readonly description: string;
  readonly timing: 'line_start_space' | 'line_start_exact' | 'paste_or_import';
}

export interface KeyboardBehavior {
  readonly enter?: string;
  readonly shiftEnter?: string;
  readonly modEnter?: string;
  readonly tab?: string;
  readonly backspace?: string;
  readonly shortcuts?: readonly string[];
}

export interface AccessibilityMetadata {
  readonly label: string;
  readonly role?: string;
  readonly description?: string;
}

export interface BlockFlags {
  readonly textual?: boolean;
  readonly void?: boolean;
  readonly media?: boolean;
  readonly layout?: boolean;
  readonly database?: boolean;
  readonly generated?: boolean;
  readonly container?: boolean;
  readonly page?: boolean;
  readonly structural?: boolean;
  readonly compatibilityOnly?: boolean;
}

export type ChildRule =
  | { readonly kind: 'none' }
  | { readonly kind: 'preserve' }
  | { readonly kind: 'any'; readonly except?: readonly CatalogBlockType[] }
  | { readonly kind: 'only'; readonly types: readonly CatalogBlockType[]; readonly min?: number; readonly max?: number }
  | {
      readonly kind: 'conditional';
      readonly description: string;
      readonly when: (data: CatalogBlockData<CatalogBlockType> | undefined) => boolean;
      readonly then: ChildRule;
      readonly otherwise: ChildRule;
    };

export interface ChildConstraints {
  readonly allowed: ChildRule;
  readonly validParents?: readonly CatalogBlockType[];
  readonly description: string;
}

export interface SerializationExample {
  readonly format: 'notion-api' | 'plim-model' | 'compatibility';
  readonly value: JsonObject;
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface BlockValidationIssue {
  readonly severity: ValidationSeverity;
  readonly code:
    | 'invalid_child'
    | 'invalid_parent'
    | 'invalid_children_count'
    | 'invalid_reference'
    | 'invalid_url'
    | 'invalid_file'
    | 'invalid_table'
    | 'invalid_value'
    | 'unsupported_model_type';
  readonly message: string;
  readonly path?: string;
}

export interface NormalizeContext {
  readonly tableColumnCount?: number;
}

export interface ValidateContext {
  readonly parentType?: CatalogBlockType;
  readonly childTypes?: readonly CatalogBlockType[];
  readonly tableColumnCount?: number;
}

export type LinkToPageTarget =
  | { readonly kind: 'page'; readonly pageId: PageId }
  | { readonly kind: 'database'; readonly databaseId: DatabaseId }
  | { readonly kind: 'data_source'; readonly dataSourceId: DataSourceId };

export interface LinkToPageBlockData {
  readonly target: LinkToPageTarget | null;
  readonly cachedTitle?: string;
  readonly icon?: IconRef | null;
}

export type ButtonAction =
  | { readonly type: 'insert_blocks'; readonly position: 'above' | 'below' | 'top' | 'bottom'; readonly blocks: readonly JsonObject[] }
  | { readonly type: 'add_page_to_data_source'; readonly dataSourceId: DataSourceId; readonly properties?: JsonObject; readonly templateId?: string }
  | { readonly type: 'edit_pages'; readonly target: { readonly dataSourceId: DataSourceId; readonly filter?: JsonObject }; readonly properties: JsonObject }
  | { readonly type: 'open_page'; readonly pageId: PageId }
  | { readonly type: 'open_url'; readonly url: URLString }
  | { readonly type: 'notify'; readonly recipients: readonly { readonly type: 'user'; readonly id: UserId }[]; readonly message: RichText }
  | { readonly type: 'webhook'; readonly urlRef: string; readonly payload?: JsonObject }
  | { readonly type: 'custom'; readonly actionId: string; readonly config: JsonObject };

export interface ButtonBlockData {
  readonly label: RichText;
  readonly icon?: IconRef | null;
  readonly actions: readonly ButtonAction[];
  readonly confirmation?: { readonly title?: string; readonly message?: RichText };
  readonly variables?: readonly { readonly id: string; readonly name: string; readonly expression?: string }[];
}

export interface CompatibilityBlockDataByType {
  readonly link_to_page: LinkToPageBlockData;
  readonly button: ButtonBlockData;
}

export type CatalogBlockData<T extends CatalogBlockType> = T extends BlockType
  ? BlockDataByType[T]
  : T extends keyof CompatibilityBlockDataByType
    ? CompatibilityBlockDataByType[T]
    : never;

export interface SlashCommandDefinition<T extends CatalogBlockType = CatalogBlockType> {
  readonly type: T;
  readonly label: string;
  readonly category: BlockCategory;
  readonly aliases: readonly string[];
  readonly markdownShortcuts: readonly MarkdownShortcut[];
  readonly accessibilityLabel: string;
  readonly modelBacked: boolean;
}

export interface BlockDefinition<T extends CatalogBlockType = CatalogBlockType> {
  readonly type: T;
  readonly label: string;
  readonly category: BlockCategory;
  readonly description: string;
  readonly modelBacked: boolean;
  readonly childConstraints: ChildConstraints;
  readonly richTextFields: readonly RichTextFieldName[];
  readonly plainTextFields?: readonly PlainTextFieldName[];
  readonly flags: BlockFlags;
  readonly slashAliases: readonly string[];
  readonly markdownShortcuts: readonly MarkdownShortcut[];
  readonly keyboard: KeyboardBehavior;
  readonly accessibility: AccessibilityMetadata;
  readonly createDefaultData: () => CatalogBlockData<T>;
  readonly normalize: (data: CatalogBlockData<T>, context?: NormalizeContext) => CatalogBlockData<T>;
  readonly validate: (data: CatalogBlockData<T>, context?: ValidateContext) => readonly BlockValidationIssue[];
  readonly serializationExamples?: readonly SerializationExample[];
}

export type AnyBlockDefinition = {
  readonly [T in CatalogBlockType]: BlockDefinition<T>;
}[CatalogBlockType];

const NONE: ChildRule = { kind: 'none' };
const PRESERVE_ONLY: ChildRule = { kind: 'preserve' };
const STRUCTURAL_CHILDREN = ['column', 'table_row'] as const satisfies readonly CatalogBlockType[];
const ANY_CONTENT: ChildRule = { kind: 'any', except: STRUCTURAL_CHILDREN };
const ANY_CONTENT_EXCEPT_COLUMN_AND_ROW: ChildRule = { kind: 'any', except: ['column', 'table_row'] };
const COLUMN_CHILDREN: ChildRule = { kind: 'only', types: ['column'], min: 2 };
const TABLE_ROW_CHILDREN: ChildRule = { kind: 'only', types: ['table_row'], min: 1 };
const COLUMN_PARENT = ['column_list'] as const satisfies readonly CatalogBlockType[];
const TABLE_ROW_PARENT = ['table'] as const satisfies readonly CatalogBlockType[];

const MODEL_BLOCK_TYPES = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'toggle_heading_1',
  'toggle_heading_2',
  'toggle_heading_3',
  'quote',
  'callout',
  'code',
  'equation',
  'divider',
  'table_of_contents',
  'breadcrumb',
  'page',
  'child_page',
  'child_database',
  'database_view',
  'column_list',
  'column',
  'table',
  'table_row',
  'template',
  'synced_block',
  'image',
  'video',
  'audio',
  'file',
  'pdf',
  'bookmark',
  'embed',
  'link_preview',
  'unsupported'
] as const satisfies readonly BlockType[];

type MissingModelBlockType = Exclude<BlockType, (typeof MODEL_BLOCK_TYPES)[number]>;
const modelCatalogIsExhaustive: MissingModelBlockType extends never ? true : never = true;
void modelCatalogIsExhaustive;

const CATALOG_BLOCK_TYPES = [...MODEL_BLOCK_TYPES, 'link_to_page', 'button'] as const satisfies readonly CatalogBlockType[];

const emptyRichText = (): RichText => [];
const placeholderExternalUrl = 'https://example.invalid/' as URLString;
const placeholderFileUrl = 'https://example.invalid/plim-file-placeholder' as URLString;
const placeholderFile = (): FileRef => ({ type: 'external', url: placeholderFileUrl });
const emojiIcon = (emoji: string): IconRef => ({ type: 'emoji', emoji });
const markdown = (trigger: string, description: string, timing: MarkdownShortcut['timing'] = 'line_start_space'): MarkdownShortcut => ({ trigger, description, timing });

function defineBlock<T extends CatalogBlockType>(definition: BlockDefinition<T>): BlockDefinition<T> {
  return definition;
}

function issue(code: BlockValidationIssue['code'], message: string, severity: ValidationSeverity = 'error', path?: string): BlockValidationIssue {
  return { severity, code, message, ...(path ? { path } : {}) };
}

function withDefaultColor<T extends { color?: NotionColor }>(data: T): T & { color: NotionColor } {
  return { ...data, color: data.color ?? 'default' };
}

function normalizeRichTextData<T extends { richText: RichText }>(data: T): T {
  return { ...data, richText: normalizeRichText(data.richText ?? []) };
}

function normalizeCaptionData<T extends { caption?: RichText }>(data: T): T {
  return data.caption ? { ...data, caption: normalizeRichText(data.caption) } : data;
}

function normalizeColorRichText<T extends { richText: RichText; color?: NotionColor }>(data: T): T & { color: NotionColor } {
  return withDefaultColor(normalizeRichTextData(data));
}

function richTextBlockDefault<T extends 'paragraph' | 'heading_1' | 'heading_2' | 'heading_3' | 'bulleted_list_item' | 'quote'>(type: T): BlockDataByType[T] {
  return withDefaultColor(modelDefaultBlockData(type)) as BlockDataByType[T];
}

function validateUrl(value: string | undefined, path: string): readonly BlockValidationIssue[] {
  return value && !isAllowedUrl(value) ? [issue('invalid_url', `Unsafe or invalid URL: ${value}`, 'error', path)] : [];
}

function validateFileRef(file: FileRef, path: string): readonly BlockValidationIssue[] {
  if (file.type === 'external') return validateUrl(file.url, `${path}.url`);
  if (file.type === 'data_url' && !file.dataUrl.startsWith('data:')) return [issue('invalid_file', 'Data URL file references must start with data:', 'error', `${path}.dataUrl`)];
  return [];
}

function validateCommonChildren(type: CatalogBlockType, data: CatalogBlockData<CatalogBlockType>, context?: ValidateContext): readonly BlockValidationIssue[] {
  const childTypes = context?.childTypes;
  if (!childTypes) return [];
  const issues: BlockValidationIssue[] = [];
  const definition = getBlockDefinition(type);
  if (!definition) return [issue('unsupported_model_type', `Unknown block type ${type}`)];
  if (definition.childConstraints.allowed.kind === 'only') {
    const minimum = definition.childConstraints.allowed.min;
    if (minimum !== undefined && childTypes.length < minimum) {
      issues.push(issue('invalid_children_count', `${definition.label} requires at least ${minimum} child block(s).`, 'error', 'children'));
    }
  }
  for (const childType of childTypes) {
    if (!canNestBlock(type, childType, { parentData: data })) {
      issues.push(issue('invalid_child', `${childType} cannot be nested under ${type}.`, 'error', 'children'));
    }
  }
  return issues;
}

function validateNoChildren(type: CatalogBlockType, context?: ValidateContext): readonly BlockValidationIssue[] {
  return context?.childTypes && context.childTypes.length > 0
    ? [issue('invalid_child', `${type} cannot contain child blocks.`, 'error', 'children')]
    : [];
}

function validateReferences<T extends CatalogBlockType>(type: T, data: CatalogBlockData<T>): readonly BlockValidationIssue[] {
  switch (type) {
    case 'child_page':
      return (data as BlockDataByType['child_page']).pageId ? [] : [issue('invalid_reference', 'Child page block needs a pageId before it can be rendered as a real page link.', 'warning', 'data.pageId')];
    case 'child_database':
      return (data as BlockDataByType['child_database']).databaseId ? [] : [issue('invalid_reference', 'Child database block needs a databaseId before it can render a database.', 'warning', 'data.databaseId')];
    case 'database_view': {
      const view = data as BlockDataByType['database_view'];
      const issues: BlockValidationIssue[] = [];
      if (!view.databaseId) issues.push(issue('invalid_reference', 'Database view needs a databaseId.', 'warning', 'data.databaseId'));
      if (!view.dataSourceId) issues.push(issue('invalid_reference', 'Database view needs a dataSourceId.', 'warning', 'data.dataSourceId'));
      if (!view.viewId) issues.push(issue('invalid_reference', 'Database view needs a viewId.', 'warning', 'data.viewId'));
      return issues;
    }
    default:
      return [];
  }
}

function defaultValidate<T extends CatalogBlockType>(type: T, data: CatalogBlockData<T>, context?: ValidateContext): readonly BlockValidationIssue[] {
  return [...validateCommonChildren(type, data as CatalogBlockData<CatalogBlockType>, context), ...validateReferences(type, data)];
}

function defaultNoChildValidate<T extends CatalogBlockType>(type: T, data: CatalogBlockData<T>, context?: ValidateContext): readonly BlockValidationIssue[] {
  return [...validateNoChildren(type, context), ...validateReferences(type, data)];
}

function headingAllowedChildren(data: CatalogBlockData<CatalogBlockType> | undefined): boolean {
  return Boolean((data as BlockDataByType['heading_1'] | undefined)?.isToggleable);
}

function syncedBlockCanOwnChildren(data: CatalogBlockData<CatalogBlockType> | undefined): boolean {
  return ((data as BlockDataByType['synced_block'] | undefined)?.syncedFrom ?? null) === null;
}

type NumberingStyle = NonNullable<BlockDataByType['numbered_list_item']['numbering']>;

function normalizeNumbering(value: BlockDataByType['numbered_list_item']['numbering'] | undefined): NumberingStyle {
  return value === 'lower_alpha' || value === 'lower_roman' || value === 'decimal' ? value : 'decimal';
}

function normalizeColumnCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizeCells(cells: RichText[], columnCount: number | undefined): RichText[] {
  const normalized = cells.map(cell => normalizeRichText(cell));
  if (columnCount === undefined) return normalized;
  if (normalized.length === columnCount) return normalized;
  if (normalized.length > columnCount) return normalized.slice(0, columnCount);
  return [...normalized, ...Array.from({ length: columnCount - normalized.length }, emptyRichText)];
}

function defaultSerialization(type: CatalogBlockType): readonly SerializationExample[] {
  return [{ format: 'plim-model', value: { type, data: {} } }];
}

const textKeyboard: KeyboardBehavior = {
  enter: 'Split the block at the caret into a following paragraph or same-type block where Notion behavior expects it.',
  shiftEnter: 'Insert a soft line break inside the rich-text field.',
  tab: 'Indent or nest the current block under the previous compatible block.',
  backspace: 'At the start of an empty block, merge with the previous compatible block or delete while preserving children.'
};

const containerKeyboard: KeyboardBehavior = {
  ...textKeyboard,
  modEnter: 'Toggle checked/collapsed/open state when the block type defines one.'
};

const blockDefinitions = [
  defineBlock({
    type: 'paragraph',
    label: 'Text',
    category: 'basic',
    description: 'General prose, empty insertion point, and default editable block.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain arbitrary content blocks except structural column and table row children.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: ['text', 'plain', 'paragraph'],
    markdownShortcuts: [],
    keyboard: { ...textKeyboard, shortcuts: ['mod+alt+0', 'ctrl+shift+0'] },
    accessibility: { label: 'Text block', role: 'textbox', description: 'Editable paragraph text.' },
    createDefaultData: () => richTextBlockDefault('paragraph'),
    normalize: data => normalizeColorRichText(data),
    validate: (data, context) => defaultValidate('paragraph', data, context),
    serializationExamples: [{ format: 'notion-api', value: { object: 'block', type: 'paragraph', paragraph: { rich_text: [], color: 'default' } } }]
  }),
  defineBlock({
    type: 'heading_1',
    label: 'Heading 1',
    category: 'heading',
    description: 'Top-level heading used for page structure and generated outlines.',
    modelBacked: true,
    childConstraints: {
      allowed: { kind: 'conditional', description: 'Only toggleable headings may contain children.', when: headingAllowedChildren, then: ANY_CONTENT, otherwise: NONE },
      description: 'Non-toggle headings cannot contain children; toggleable headings use toggle child rules.'
    },
    richTextFields: ['richText'],
    flags: { textual: true },
    slashAliases: ['h1', '#', 'heading 1'],
    markdownShortcuts: [markdown('# ', 'Turn the block into a Heading 1.')],
    keyboard: { ...textKeyboard, modEnter: 'Expand or collapse when isToggleable is true.', shortcuts: ['mod+alt+1', 'ctrl+shift+1'] },
    accessibility: { label: 'Heading 1', role: 'heading', description: 'Expose heading level 1 semantics.' },
    createDefaultData: () => ({ ...richTextBlockDefault('heading_1'), isToggleable: false }),
    normalize: data => ({ ...normalizeColorRichText(data), isToggleable: Boolean(data.isToggleable) }),
    validate: (data, context) => defaultValidate('heading_1', data, context),
    serializationExamples: defaultSerialization('heading_1')
  }),
  defineBlock({
    type: 'heading_2',
    label: 'Heading 2',
    category: 'heading',
    description: 'Second-level heading used for page structure and generated outlines.',
    modelBacked: true,
    childConstraints: {
      allowed: { kind: 'conditional', description: 'Only toggleable headings may contain children.', when: headingAllowedChildren, then: ANY_CONTENT, otherwise: NONE },
      description: 'Non-toggle headings cannot contain children; toggleable headings use toggle child rules.'
    },
    richTextFields: ['richText'],
    flags: { textual: true },
    slashAliases: ['h2', '##', 'heading 2'],
    markdownShortcuts: [markdown('## ', 'Turn the block into a Heading 2.')],
    keyboard: { ...textKeyboard, modEnter: 'Expand or collapse when isToggleable is true.', shortcuts: ['mod+alt+2', 'ctrl+shift+2'] },
    accessibility: { label: 'Heading 2', role: 'heading', description: 'Expose heading level 2 semantics.' },
    createDefaultData: () => ({ ...richTextBlockDefault('heading_2'), isToggleable: false }),
    normalize: data => ({ ...normalizeColorRichText(data), isToggleable: Boolean(data.isToggleable) }),
    validate: (data, context) => defaultValidate('heading_2', data, context),
    serializationExamples: defaultSerialization('heading_2')
  }),
  defineBlock({
    type: 'heading_3',
    label: 'Heading 3',
    category: 'heading',
    description: 'Third-level heading used for page structure and generated outlines.',
    modelBacked: true,
    childConstraints: {
      allowed: { kind: 'conditional', description: 'Only toggleable headings may contain children.', when: headingAllowedChildren, then: ANY_CONTENT, otherwise: NONE },
      description: 'Non-toggle headings cannot contain children; toggleable headings use toggle child rules.'
    },
    richTextFields: ['richText'],
    flags: { textual: true },
    slashAliases: ['h3', '###', 'heading 3'],
    markdownShortcuts: [markdown('### ', 'Turn the block into a Heading 3.')],
    keyboard: { ...textKeyboard, modEnter: 'Expand or collapse when isToggleable is true.', shortcuts: ['mod+alt+3', 'ctrl+shift+3'] },
    accessibility: { label: 'Heading 3', role: 'heading', description: 'Expose heading level 3 semantics.' },
    createDefaultData: () => ({ ...richTextBlockDefault('heading_3'), isToggleable: false }),
    normalize: data => ({ ...normalizeColorRichText(data), isToggleable: Boolean(data.isToggleable) }),
    validate: (data, context) => defaultValidate('heading_3', data, context),
    serializationExamples: defaultSerialization('heading_3')
  }),
  defineBlock({
    type: 'bulleted_list_item',
    label: 'Bulleted list',
    category: 'list',
    description: 'Unordered list item with optional nested content.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain arbitrary valid content except structural column and table row children.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: ['bullet', 'bulleted list', 'ul'],
    markdownShortcuts: [markdown('* ', 'Turn into a bulleted list item.'), markdown('- ', 'Turn into a bulleted list item.'), markdown('+ ', 'Turn into a bulleted list item.')],
    keyboard: { ...containerKeyboard, shortcuts: ['mod+alt+5', 'ctrl+shift+5'] },
    accessibility: { label: 'Bulleted list item', role: 'listitem', description: 'Render contiguous siblings as an unordered list.' },
    createDefaultData: () => richTextBlockDefault('bulleted_list_item'),
    normalize: data => normalizeColorRichText(data),
    validate: (data, context) => defaultValidate('bulleted_list_item', data, context),
    serializationExamples: defaultSerialization('bulleted_list_item')
  }),
  defineBlock({
    type: 'numbered_list_item',
    label: 'Numbered list',
    category: 'list',
    description: 'Ordered list item with optional nested content and numbering style.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain arbitrary valid content except structural column and table row children.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: ['num', 'number', 'numbered list', 'ol'],
    markdownShortcuts: [markdown('1. ', 'Turn into a decimal numbered item.'), markdown('a. ', 'Turn into a lettered numbered item.'), markdown('i. ', 'Turn into a roman numbered item.')],
    keyboard: { ...containerKeyboard, shortcuts: ['mod+alt+6', 'ctrl+shift+6'] },
    accessibility: { label: 'Numbered list item', role: 'listitem', description: 'Render contiguous siblings as an ordered list.' },
    createDefaultData: () => withDefaultColor(modelDefaultBlockData('numbered_list_item')),
    normalize: data => ({ ...normalizeColorRichText(data), numbering: normalizeNumbering(data.numbering) }),
    validate: (data, context) => defaultValidate('numbered_list_item', data, context),
    serializationExamples: defaultSerialization('numbered_list_item')
  }),
  defineBlock({
    type: 'to_do',
    label: 'To-do list',
    category: 'list',
    description: 'Checklist task with checked state and optional nested content.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain arbitrary valid content except structural column and table row children.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: ['todo', 'to-do', 'checkbox', 'checklist'],
    markdownShortcuts: [markdown('[] ', 'Turn into an unchecked to-do item.')],
    keyboard: { ...containerKeyboard, modEnter: 'Check or uncheck the to-do item.', shortcuts: ['mod+alt+4', 'ctrl+shift+4'] },
    accessibility: { label: 'To-do list item', role: 'checkbox', description: 'Expose checked state and a label derived from rich text.' },
    createDefaultData: () => withDefaultColor(modelDefaultBlockData('to_do')),
    normalize: data => ({ ...normalizeColorRichText(data), checked: Boolean(data.checked) }),
    validate: (data, context) => defaultValidate('to_do', data, context),
    serializationExamples: defaultSerialization('to_do')
  }),
  defineBlock({
    type: 'toggle',
    label: 'Toggle list',
    category: 'list',
    description: 'Collapsible disclosure block that hides or shows child blocks.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain arbitrary valid content except structural column and table row children.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: ['toggle', 'toggle list', 'disclosure'],
    markdownShortcuts: [markdown('> ', 'Turn into a toggle list item.')],
    keyboard: { ...containerKeyboard, modEnter: 'Expand or collapse the toggle.', shortcuts: ['mod+alt+7', 'ctrl+shift+7', 'mod+alt+t'] },
    accessibility: { label: 'Toggle list item', role: 'button', description: 'Expose disclosure state with aria-expanded.' },
    createDefaultData: () => withDefaultColor(modelDefaultBlockData('toggle')),
    normalize: data => ({ ...normalizeColorRichText(data), collapsed: Boolean(data.collapsed) }),
    validate: (data, context) => defaultValidate('toggle', data, context),
    serializationExamples: defaultSerialization('toggle')
  }),
  ...(['toggle_heading_1', 'toggle_heading_2', 'toggle_heading_3'] as const).map((type, index) => defineBlock({
    type,
    label: `Toggle Heading ${index + 1}`,
    category: 'heading',
    description: `Heading ${index + 1} with built-in disclosure behavior and child content.`,
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain arbitrary valid content except structural column and table row children.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: [`toggle h${index + 1}`, `toggle heading ${index + 1}`, `h${index + 1} toggle`],
    markdownShortcuts: [],
    keyboard: { ...containerKeyboard, modEnter: 'Expand or collapse the toggle heading.' },
    accessibility: { label: `Toggle heading ${index + 1}`, role: 'heading', description: 'Expose heading semantics and aria-expanded disclosure state.' },
    createDefaultData: () => withDefaultColor(modelDefaultBlockData(type)),
    normalize: data => ({ ...normalizeColorRichText(data), collapsed: Boolean(data.collapsed) }),
    validate: (data, context) => defaultValidate(type, data, context),
    serializationExamples: defaultSerialization(type)
  })),
  defineBlock({
    type: 'quote',
    label: 'Quote',
    category: 'basic',
    description: 'Visually set-off quoted or emphasized content with optional nested blocks.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain arbitrary valid content except structural column and table row children.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: ['quote'],
    markdownShortcuts: [markdown('" ', 'Turn into a quote block.')],
    keyboard: textKeyboard,
    accessibility: { label: 'Quote block', role: 'blockquote', description: 'Use blockquote semantics in read-only output.' },
    createDefaultData: () => richTextBlockDefault('quote'),
    normalize: data => normalizeColorRichText(data),
    validate: (data, context) => defaultValidate('quote', data, context),
    serializationExamples: defaultSerialization('quote')
  }),
  defineBlock({
    type: 'callout',
    label: 'Callout',
    category: 'basic',
    description: 'Highlighted note with icon, color, rich text, and optional nested blocks.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain arbitrary valid content except structural column and table row children.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: ['callout', 'note'],
    markdownShortcuts: [],
    keyboard: textKeyboard,
    accessibility: { label: 'Callout block', role: 'note', description: 'Icon meaning must be decorative or have text alternative.' },
    createDefaultData: () => ({ ...modelDefaultBlockData('callout'), icon: emojiIcon('💡'), color: 'default' }),
    normalize: data => ({ ...normalizeColorRichText(data), ...(data.icon ? { icon: data.icon } : {}) }),
    validate: (data, context) => defaultValidate('callout', data, context),
    serializationExamples: defaultSerialization('callout')
  }),
  defineBlock({
    type: 'divider',
    label: 'Divider',
    category: 'basic',
    description: 'Selectable horizontal separator with no text or child content.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Divider blocks are void and cannot contain children.' },
    richTextFields: [],
    flags: { void: true },
    slashAliases: ['div', 'divider', 'hr'],
    markdownShortcuts: [markdown('---', 'Create a divider block.', 'line_start_exact')],
    keyboard: { enter: 'Create a paragraph before or after the selected divider.', backspace: 'Delete the selected divider.' },
    accessibility: { label: 'Divider', role: 'separator', description: 'Expose separator or horizontal rule semantics.' },
    createDefaultData: () => modelDefaultBlockData('divider'),
    normalize: data => data,
    validate: (_data, context) => validateNoChildren('divider', context),
    serializationExamples: [{ format: 'notion-api', value: { object: 'block', type: 'divider', divider: {} } }]
  }),
  defineBlock({
    type: 'page',
    label: 'Page',
    category: 'page',
    description: 'Canonical page/root block with title rich text and page body children.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'A page may contain regular content blocks except structural-only column and table row children.' },
    richTextFields: ['title'],
    flags: { textual: true, container: true, page: true },
    slashAliases: ['page block'],
    markdownShortcuts: [],
    keyboard: { enter: 'Open or edit the page title depending on focus.', shortcuts: ['mod+alt+9', 'ctrl+shift+9'] },
    accessibility: { label: 'Page', role: 'document', description: 'Expose the page title and editable document body.' },
    createDefaultData: () => modelDefaultBlockData('page'),
    normalize: data => ({ ...data, title: normalizeRichText(data.title ?? richTextFromPlainText('Untitled')) }),
    validate: (data, context) => defaultValidate('page', data, context),
    serializationExamples: defaultSerialization('page')
  }),
  defineBlock({
    type: 'child_page',
    label: 'Child page',
    category: 'page',
    description: 'Creates or displays a nested page link that owns its page body elsewhere in the document model.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Page body blocks belong to the referenced page/root, not directly to child_page.' },
    richTextFields: [],
    flags: { page: true, void: true },
    slashAliases: ['page', 'subpage', 'child page'],
    markdownShortcuts: [],
    keyboard: { enter: 'Open the child page when selected.', modEnter: 'Open the child page.' },
    accessibility: { label: 'Child page link', role: 'link', description: 'Expose target page title and icon text alternative.' },
    createDefaultData: () => modelDefaultBlockData('child_page'),
    normalize: data => data,
    validate: (data, context) => defaultNoChildValidate('child_page', data, context),
    serializationExamples: defaultSerialization('child_page')
  }),
  defineBlock({
    type: 'link_to_page',
    label: 'Link to page',
    category: 'page',
    description: 'Compatibility-only page/database reference block that does not reparent the target.',
    modelBacked: false,
    childConstraints: { allowed: NONE, description: 'Link-to-page blocks cannot contain children.' },
    richTextFields: [],
    flags: { page: true, void: true, compatibilityOnly: true },
    slashAliases: ['link', 'link to page', 'page link'],
    markdownShortcuts: [],
    keyboard: { enter: 'Open the target picker or target page when selected.' },
    accessibility: { label: 'Link to page', role: 'link', description: 'Expose target type and title.' },
    createDefaultData: () => ({ target: null }),
    normalize: data => data,
    validate: (data, context) => [
      ...validateNoChildren('link_to_page', context),
      ...(data.target ? [] : [issue('invalid_reference', 'Link-to-page needs a target page, database, or data source.', 'warning', 'data.target')])
    ],
    serializationExamples: [{ format: 'compatibility', value: { object: 'block', type: 'link_to_page', link_to_page: { target: null } } }]
  }),
  defineBlock({
    type: 'breadcrumb',
    label: 'Breadcrumb',
    category: 'advanced',
    description: 'Generated page ancestry navigation block.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Breadcrumb blocks are generated and cannot contain children.' },
    richTextFields: [],
    flags: { generated: true, void: true },
    slashAliases: ['bread', 'breadcrumb'],
    markdownShortcuts: [],
    keyboard: { enter: 'Select or open the generated breadcrumb links depending on focus.' },
    accessibility: { label: 'Breadcrumb navigation', role: 'navigation', description: 'Render as a breadcrumb list with links.' },
    createDefaultData: () => modelDefaultBlockData('breadcrumb'),
    normalize: data => data,
    validate: (_data, context) => validateNoChildren('breadcrumb', context),
    serializationExamples: defaultSerialization('breadcrumb')
  }),
  defineBlock({
    type: 'table_of_contents',
    label: 'Table of contents',
    category: 'advanced',
    description: 'Generated in-page outline derived from heading blocks.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Table of contents blocks are generated and cannot contain children.' },
    richTextFields: [],
    flags: { generated: true, void: true },
    slashAliases: ['toc', 'table of contents'],
    markdownShortcuts: [],
    keyboard: { enter: 'Select or follow generated heading links depending on focus.' },
    accessibility: { label: 'Table of contents', role: 'navigation', description: 'Each generated entry should be a link to a heading.' },
    createDefaultData: () => withDefaultColor(modelDefaultBlockData('table_of_contents')),
    normalize: data => withDefaultColor(data),
    validate: (_data, context) => validateNoChildren('table_of_contents', context),
    serializationExamples: defaultSerialization('table_of_contents')
  }),
  defineBlock({
    type: 'column_list',
    label: 'Columns',
    category: 'layout',
    description: 'Container for a horizontal group of column blocks.',
    modelBacked: true,
    childConstraints: { allowed: COLUMN_CHILDREN, description: 'Must contain only column children; creation requires at least two columns.' },
    richTextFields: [],
    flags: { layout: true, container: true },
    slashAliases: ['columns', 'column list'],
    markdownShortcuts: [],
    keyboard: { tab: 'Move blocks into or out of columns using valid keyboard alternatives.' },
    accessibility: { label: 'Column list', role: 'group', description: 'Expose each column position, such as Column 1 of 2.' },
    createDefaultData: () => modelDefaultBlockData('column_list'),
    normalize: data => data,
    validate: (data, context) => defaultValidate('column_list', data, context),
    serializationExamples: defaultSerialization('column_list')
  }),
  defineBlock({
    type: 'column',
    label: 'Column',
    category: 'layout',
    description: 'Structural child of a column list with optional width ratio.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT_EXCEPT_COLUMN_AND_ROW, validParents: COLUMN_PARENT, description: 'Columns may contain regular content, cannot directly contain columns or table rows, and must be children of column_list.' },
    richTextFields: [],
    flags: { layout: true, container: true, structural: true },
    slashAliases: [],
    markdownShortcuts: [],
    keyboard: { tab: 'Move blocks into or out of the column using layout commands.' },
    accessibility: { label: 'Column', role: 'group', description: 'Expose column ordinal and count from the containing column list.' },
    createDefaultData: () => modelDefaultBlockData('column'),
    normalize: data => {
      if (data.widthRatio === undefined) return data;
      const widthRatio = Number.isFinite(data.widthRatio) ? Math.min(1, Math.max(0.01, data.widthRatio)) : undefined;
      return widthRatio === undefined ? {} : { ...data, widthRatio };
    },
    validate: (data, context) => {
      const issues = [...defaultValidate('column', data, context)];
      if (context?.parentType && context.parentType !== 'column_list') issues.push(issue('invalid_parent', 'Column blocks must be direct children of column_list.', 'error', 'parent'));
      if (data.widthRatio !== undefined && (data.widthRatio <= 0 || data.widthRatio > 1)) issues.push(issue('invalid_value', 'Column widthRatio must be greater than 0 and at most 1.', 'error', 'data.widthRatio'));
      return issues;
    },
    serializationExamples: defaultSerialization('column')
  }),
  defineBlock({
    type: 'table',
    label: 'Simple table',
    category: 'table',
    description: 'Non-database grid whose rows contain rich-text cells.',
    modelBacked: true,
    childConstraints: { allowed: TABLE_ROW_CHILDREN, description: 'Must contain only table_row children; creation requires at least one row.' },
    richTextFields: [],
    flags: { layout: true, container: true },
    slashAliases: ['table', 'simple table'],
    markdownShortcuts: [],
    keyboard: { tab: 'Move between table cells.', shiftEnter: 'Insert a soft line break in a cell.', enter: 'Commit or move within the active table cell.' },
    accessibility: { label: 'Simple table', role: 'grid', description: 'Expose row and column counts with header state.' },
    createDefaultData: () => ({ hasColumnHeader: false, hasRowHeader: false, columnCount: 2 }),
    normalize: data => ({ ...data, hasColumnHeader: Boolean(data.hasColumnHeader), hasRowHeader: Boolean(data.hasRowHeader), columnCount: normalizeColumnCount(data.columnCount) }),
    validate: (data, context) => {
      const issues = [...defaultValidate('table', data, context)];
      if (!Number.isInteger(data.columnCount) || data.columnCount < 1) issues.push(issue('invalid_table', 'Table columnCount must be a positive integer.', 'error', 'data.columnCount'));
      return issues;
    },
    serializationExamples: defaultSerialization('table')
  }),
  defineBlock({
    type: 'table_row',
    label: 'Table row',
    category: 'table',
    description: 'Structural simple-table row with rich-text cells.',
    modelBacked: true,
    childConstraints: { allowed: NONE, validParents: TABLE_ROW_PARENT, description: 'Rows cannot contain block children and must be direct children of table.' },
    richTextFields: ['cells'],
    flags: { structural: true, textual: true },
    slashAliases: [],
    markdownShortcuts: [],
    keyboard: { tab: 'Move to the next table cell.', enter: 'Commit or move within table cell editing.' },
    accessibility: { label: 'Table row', role: 'row', description: 'Expose rich-text cells through the containing grid.' },
    createDefaultData: () => ({ cells: [emptyRichText(), emptyRichText()] }),
    normalize: (data, context) => ({ ...data, cells: normalizeCells(data.cells ?? [], context?.tableColumnCount) }),
    validate: (data, context) => {
      const issues = [...validateNoChildren('table_row', context)];
      if (context?.parentType && context.parentType !== 'table') issues.push(issue('invalid_parent', 'Table rows must be direct children of table.', 'error', 'parent'));
      if (context?.tableColumnCount !== undefined && data.cells.length !== context.tableColumnCount) issues.push(issue('invalid_table', `Table row has ${data.cells.length} cells but the table expects ${context.tableColumnCount}.`, 'error', 'data.cells'));
      return issues;
    },
    serializationExamples: defaultSerialization('table_row')
  }),
  defineBlock({
    type: 'code',
    label: 'Code',
    category: 'basic',
    description: 'Preformatted code block with language metadata and optional caption.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Code blocks own literal code text and cannot contain child blocks.' },
    richTextFields: ['richText', 'caption'],
    flags: { textual: true, void: true },
    slashAliases: ['code', 'code block'],
    markdownShortcuts: [markdown('```', 'Create a code block from fenced Markdown.', 'paste_or_import')],
    keyboard: { enter: 'Insert a newline inside code content.', tab: 'Insert indentation or move focus according to accessibility settings.', shortcuts: ['mod+alt+8', 'ctrl+shift+8'] },
    accessibility: { label: 'Code block', role: 'textbox', description: 'Announce language and provide a keyboard escape path.' },
    createDefaultData: () => ({ richText: emptyRichText(), language: 'plain text', caption: emptyRichText() }),
    normalize: data => ({ ...normalizeCaptionData(normalizeRichTextData(data)), language: data.language?.trim() || 'plain text' }),
    validate: (_data, context) => validateNoChildren('code', context),
    serializationExamples: defaultSerialization('code')
  }),
  defineBlock({
    type: 'equation',
    label: 'Equation',
    category: 'basic',
    description: 'Standalone TeX/KaTeX-compatible math expression.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Equation blocks cannot contain children.' },
    richTextFields: ['caption'],
    plainTextFields: ['expression'],
    flags: { textual: true, void: true },
    slashAliases: ['math', 'latex', 'equation'],
    markdownShortcuts: [],
    keyboard: { enter: 'Commit the equation editor or create a paragraph after the block.', shiftEnter: 'Insert a newline when the math editor supports it.' },
    accessibility: { label: 'Equation block', role: 'math', description: 'Expose source expression or generated MathML.' },
    createDefaultData: () => modelDefaultBlockData('equation'),
    normalize: data => normalizeCaptionData({ ...data, expression: String(data.expression ?? '') }),
    validate: (_data, context) => validateNoChildren('equation', context),
    serializationExamples: defaultSerialization('equation')
  }),
  ...(['image', 'video', 'audio', 'file', 'pdf'] as const).map(type => defineBlock({
    type,
    label: type === 'pdf' ? 'PDF' : type.charAt(0).toUpperCase() + type.slice(1),
    category: 'media',
    description: `${type === 'pdf' ? 'PDF document' : `${type.charAt(0).toUpperCase()}${type.slice(1)} media`} block with file reference and optional caption.`,
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Media and file blocks cannot contain child blocks.' },
    richTextFields: ['caption'],
    flags: { media: true, void: true },
    slashAliases: type === 'pdf' ? ['pdf'] : [type],
    markdownShortcuts: type === 'image' ? [markdown('![alt](url)', 'Import Markdown images as image blocks.', 'paste_or_import')] : [],
    keyboard: { enter: 'Select the media block or focus internal controls.', modEnter: 'Open media fullscreen or primary preview where supported.' },
    accessibility: { label: type === 'pdf' ? 'PDF block' : `${type} block`, role: 'figure', description: 'Expose media controls and captions without trapping keyboard navigation.' },
    createDefaultData: () => ({ file: placeholderFile(), caption: emptyRichText() }),
    normalize: data => normalizeCaptionData(data),
    validate: (data, context) => [...validateNoChildren(type, context), ...validateFileRef(data.file, 'data.file')],
    serializationExamples: defaultSerialization(type)
  })),
  defineBlock({
    type: 'bookmark',
    label: 'Bookmark',
    category: 'embed',
    description: 'Rich web link card with canonical URL, display metadata, and caption.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Bookmark blocks cannot contain children.' },
    richTextFields: ['caption'],
    plainTextFields: ['url'],
    flags: { void: true },
    slashAliases: ['book', 'bookmark', 'web'],
    markdownShortcuts: [markdown('https://…', 'Paste a URL and choose bookmark.', 'paste_or_import')],
    keyboard: { enter: 'Open URL editor or target URL depending on focus.' },
    accessibility: { label: 'Bookmark', role: 'link', description: 'Expose title and canonical URL.' },
    createDefaultData: () => ({ url: placeholderExternalUrl, caption: emptyRichText() }),
    normalize: data => normalizeCaptionData(data),
    validate: (data, context) => [...validateNoChildren('bookmark', context), ...validateUrl(data.url, 'data.url')],
    serializationExamples: defaultSerialization('bookmark')
  }),
  defineBlock({
    type: 'embed',
    label: 'Embed',
    category: 'embed',
    description: 'Generic external content embed represented by canonical URL and optional metadata.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Embed blocks cannot contain children.' },
    richTextFields: ['caption'],
    plainTextFields: ['url'],
    flags: { void: true },
    slashAliases: ['embed', 'tweet', 'x', 'drive', 'google drive', 'maps', 'google maps', 'figma', 'loom', 'typeform', 'codepen', 'whimsical', 'gist'],
    markdownShortcuts: [markdown('https://…', 'Paste a URL and choose embed.', 'paste_or_import')],
    keyboard: { enter: 'Open embed editor or focus embedded content depending on focus.' },
    accessibility: { label: 'Embed', role: 'region', description: 'Provide an iframe title and open-in-new fallback.' },
    createDefaultData: () => ({ url: placeholderExternalUrl, caption: emptyRichText() }),
    normalize: data => normalizeCaptionData(data),
    validate: (data, context) => [...validateNoChildren('embed', context), ...validateUrl(data.url, 'data.url')],
    serializationExamples: defaultSerialization('embed')
  }),
  defineBlock({
    type: 'link_preview',
    label: 'Link preview',
    category: 'embed',
    description: 'Live or authenticated provider preview for a canonical URL.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Link preview blocks cannot contain children.' },
    richTextFields: [],
    plainTextFields: ['url'],
    flags: { generated: true, void: true },
    slashAliases: ['link preview', 'preview'],
    markdownShortcuts: [markdown('https://…', 'Paste a supported URL and choose preview.', 'paste_or_import')],
    keyboard: { enter: 'Open preview details or URL depending on focus.' },
    accessibility: { label: 'Link preview', role: 'region', description: 'Label dynamic provider fields and status.' },
    createDefaultData: () => modelDefaultBlockData('link_preview'),
    normalize: data => data,
    validate: (data, context) => [...validateNoChildren('link_preview', context), ...validateUrl(data.url, 'data.url')],
    serializationExamples: defaultSerialization('link_preview')
  }),
  defineBlock({
    type: 'synced_block',
    label: 'Synced block',
    category: 'advanced',
    description: 'Transclusion wrapper whose source owns canonical children and whose copies render the source.',
    modelBacked: true,
    childConstraints: {
      allowed: { kind: 'conditional', description: 'Only source synced blocks can own children; copies render source children.', when: syncedBlockCanOwnChildren, then: ANY_CONTENT, otherwise: NONE },
      description: 'Original synced blocks may own content; copies should not own independent children.'
    },
    richTextFields: [],
    flags: { container: true },
    slashAliases: ['synced', 'synced block'],
    markdownShortcuts: [],
    keyboard: { enter: 'Edit the rendered synced content or select the wrapper depending on focus.' },
    accessibility: { label: 'Synced block', role: 'region', description: 'Indicate source or synced copy status.' },
    createDefaultData: () => modelDefaultBlockData('synced_block'),
    normalize: data => ({ syncedFrom: data.syncedFrom ?? null }),
    validate: (data, context) => defaultValidate('synced_block', data, context),
    serializationExamples: defaultSerialization('synced_block')
  }),
  defineBlock({
    type: 'template',
    label: 'Template',
    category: 'advanced',
    description: 'Legacy template button block that duplicates predefined child content.',
    modelBacked: true,
    childConstraints: { allowed: ANY_CONTENT, description: 'May contain template child blocks that are duplicated when invoked.' },
    richTextFields: ['richText'],
    flags: { textual: true, container: true },
    slashAliases: ['template'],
    markdownShortcuts: [],
    keyboard: { enter: 'Activate the template control when selected, or edit the label in configuration mode.' },
    accessibility: { label: 'Template button', role: 'button', description: 'Distinguish invoking the template from editing its configuration.' },
    createDefaultData: () => modelDefaultBlockData('template'),
    normalize: data => ({ ...normalizeRichTextData(data), templateChildren: [...(data.templateChildren ?? [])] }),
    validate: (data, context) => defaultValidate('template', data, context),
    serializationExamples: defaultSerialization('template')
  }),
  defineBlock({
    type: 'button',
    label: 'Button',
    category: 'advanced',
    description: 'Compatibility-only modern action block with label and host-defined action configuration.',
    modelBacked: false,
    childConstraints: { allowed: NONE, description: 'Button blocks do not render live document children; insertion templates live in action configuration.' },
    richTextFields: ['label', 'confirmation.message'],
    flags: { void: true, compatibilityOnly: true },
    slashAliases: ['button'],
    markdownShortcuts: [],
    keyboard: { enter: 'Activate the button when the button control is focused; edit label in configuration mode.', shiftEnter: 'Insert a line break in the label editor when active.' },
    accessibility: { label: 'Button block', role: 'button', description: 'Expose disabled/loading states and accessible confirmation dialogs.' },
    createDefaultData: () => ({ label: richTextFromPlainText('Button'), actions: [] }),
    normalize: data => ({
      ...data,
      label: normalizeRichText(data.label ?? richTextFromPlainText('Button')),
      actions: [...(data.actions ?? [])],
      ...(data.confirmation?.message ? { confirmation: { ...data.confirmation, message: normalizeRichText(data.confirmation.message) } } : data.confirmation ? { confirmation: data.confirmation } : {})
    }),
    validate: (data, context) => [
      ...validateNoChildren('button', context),
      ...(data.actions.length === 0 ? [issue('invalid_value', 'Button has no configured actions.', 'info', 'data.actions')] : [])
    ],
    serializationExamples: [{ format: 'compatibility', value: { object: 'block', type: 'button', button: { label: [], actions: [] } } }]
  }),
  defineBlock({
    type: 'child_database',
    label: 'Child database',
    category: 'database',
    description: 'Compatibility block for public-API child database placeholders and inline database surfaces.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Rows are pages under data sources; arbitrary block children are not accepted.' },
    richTextFields: [],
    flags: { database: true, void: true },
    slashAliases: ['database', 'inline database', 'child database'],
    markdownShortcuts: [],
    keyboard: { enter: 'Open or focus the database surface.' },
    accessibility: { label: 'Child database', role: 'region', description: 'Expose database title, layout, and row count where known.' },
    createDefaultData: () => modelDefaultBlockData('child_database'),
    normalize: data => data,
    validate: (data, context) => defaultNoChildValidate('child_database', data, context),
    serializationExamples: defaultSerialization('child_database')
  }),
  defineBlock({
    type: 'database_view',
    label: 'Database view',
    category: 'database',
    description: 'Inline or linked database/data-source view referencing first-class database resources.',
    modelBacked: true,
    childConstraints: { allowed: NONE, description: 'Rows are pages under data sources; the view block cannot accept arbitrary child blocks.' },
    richTextFields: [],
    flags: { database: true, generated: true, void: true },
    slashAliases: ['table view', 'board view', 'gallery view', 'list view', 'calendar view', 'timeline view', 'linked database', 'linked view', 'chart', 'dashboard'],
    markdownShortcuts: [],
    keyboard: { enter: 'Focus the internal database grid/list/board selection model.' },
    accessibility: { label: 'Database view', role: 'region', description: 'Expose layout-specific grid, list, board, or calendar semantics.' },
    createDefaultData: () => modelDefaultBlockData('database_view'),
    normalize: data => data,
    validate: (data, context) => defaultNoChildValidate('database_view', data, context),
    serializationExamples: defaultSerialization('database_view')
  }),
  defineBlock({
    type: 'unsupported',
    label: 'Unsupported block',
    category: 'compatibility',
    description: 'Safe placeholder for future, private, or unavailable block payloads.',
    modelBacked: true,
    childConstraints: { allowed: PRESERVE_ONLY, description: 'May preserve imported child IDs, but the editor should not allow arbitrary child editing.' },
    richTextFields: [],
    flags: { compatibilityOnly: true },
    slashAliases: [],
    markdownShortcuts: [],
    keyboard: { enter: 'Select the placeholder or open recovery actions if available.' },
    accessibility: { label: 'Unsupported content', role: 'group', description: 'Announce original type without rendering unsafe raw content.' },
    createDefaultData: () => modelDefaultBlockData('unsupported'),
    normalize: data => ({ ...data, raw: data.raw ?? {} }),
    validate: (_data, _context) => [issue('invalid_value', 'Unsupported block is preserved but not directly editable.', 'info', 'data')],
    serializationExamples: defaultSerialization('unsupported')
  })
] as const satisfies readonly AnyBlockDefinition[];

export const BLOCK_CATALOG = blockDefinitions;
export const BLOCK_TYPES = CATALOG_BLOCK_TYPES;
export const MODEL_BACKED_BLOCK_TYPES = MODEL_BLOCK_TYPES;

const blockDefinitionMap: ReadonlyMap<CatalogBlockType, AnyBlockDefinition> = new Map(
  blockDefinitions.map(definition => [definition.type, definition])
);

function normalizeAlias(alias: string): string {
  return alias.trim().replace(/^\/+/, '').replace(/\s+/g, ' ').toLowerCase();
}

export function getBlockDefinition<T extends CatalogBlockType>(type: T): BlockDefinition<T> | undefined {
  return blockDefinitionMap.get(type) as BlockDefinition<T> | undefined;
}

export function createDefaultBlockData<T extends BlockType>(type: T): BlockDataByType[T];
export function createDefaultBlockData<T extends CompatibilityOnlyBlockType>(type: T): CompatibilityBlockDataByType[T];
export function createDefaultBlockData<T extends CatalogBlockType>(type: T): CatalogBlockData<T>;
export function createDefaultBlockData<T extends CatalogBlockType>(type: T): CatalogBlockData<T> {
  const definition = getBlockDefinition(type);
  if (!definition) throw new Error(`Unknown block type: ${type}`);
  return definition.createDefaultData();
}

export function canContainChildren<T extends CatalogBlockType>(type: T, data?: CatalogBlockData<T>): boolean {
  const definition = getBlockDefinition(type);
  if (!definition) return false;
  return childRuleAllowsAny(definition.childConstraints.allowed, data as CatalogBlockData<CatalogBlockType> | undefined);
}

export function canNestBlock(
  parentType: CatalogBlockType,
  childType: CatalogBlockType,
  options: { readonly parentData?: CatalogBlockData<CatalogBlockType> } = {}
): boolean {
  const parent = getBlockDefinition(parentType);
  const child = getBlockDefinition(childType);
  if (!parent || !child) return false;
  if (child.childConstraints.validParents && !child.childConstraints.validParents.includes(parentType)) return false;
  return childRuleAllows(parent.childConstraints.allowed, childType, options.parentData);
}

function childRuleAllowsAny(rule: ChildRule, data: CatalogBlockData<CatalogBlockType> | undefined): boolean {
  switch (rule.kind) {
    case 'none':
    case 'preserve':
      return false;
    case 'any':
    case 'only':
      return true;
    case 'conditional':
      return childRuleAllowsAny(rule.when(data) ? rule.then : rule.otherwise, data);
  }
}

function childRuleAllows(rule: ChildRule, childType: CatalogBlockType, data: CatalogBlockData<CatalogBlockType> | undefined): boolean {
  switch (rule.kind) {
    case 'none':
    case 'preserve':
      return false;
    case 'any':
      return !(rule.except ?? []).includes(childType);
    case 'only':
      return rule.types.includes(childType);
    case 'conditional':
      return childRuleAllows(rule.when(data) ? rule.then : rule.otherwise, childType, data);
  }
}

export function normalizeBlockByDefinition<T extends BlockType>(type: T, data?: Partial<BlockDataByType[T]>, context?: NormalizeContext): BlockDataByType[T];
export function normalizeBlockByDefinition<T extends CompatibilityOnlyBlockType>(type: T, data?: Partial<CompatibilityBlockDataByType[T]>, context?: NormalizeContext): CompatibilityBlockDataByType[T];
export function normalizeBlockByDefinition<T extends CatalogBlockType>(type: T, data?: Partial<CatalogBlockData<T>>, context?: NormalizeContext): CatalogBlockData<T>;
export function normalizeBlockByDefinition<T extends CatalogBlockType>(type: T, data: Partial<CatalogBlockData<T>> = {}, context?: NormalizeContext): CatalogBlockData<T> {
  const definition = getBlockDefinition(type);
  if (!definition) throw new Error(`Unknown block type: ${type}`);
  const merged = { ...definition.createDefaultData(), ...data } as CatalogBlockData<T>;
  return definition.normalize(merged, context);
}

export function validateBlockByDefinition<T extends BlockType>(type: T, data: BlockDataByType[T], context?: ValidateContext): readonly BlockValidationIssue[];
export function validateBlockByDefinition<T extends CompatibilityOnlyBlockType>(type: T, data: CompatibilityBlockDataByType[T], context?: ValidateContext): readonly BlockValidationIssue[];
export function validateBlockByDefinition<T extends CatalogBlockType>(type: T, data: CatalogBlockData<T>, context?: ValidateContext): readonly BlockValidationIssue[];
export function validateBlockByDefinition<T extends CatalogBlockType>(type: T, data: CatalogBlockData<T>, context?: ValidateContext): readonly BlockValidationIssue[] {
  const definition = getBlockDefinition(type);
  if (!definition) return [issue('unsupported_model_type', `Unknown block type: ${type}`)];
  return definition.validate(data, context);
}

export function getSlashCommandsForBlocks(options: { readonly includeCompatibilityOnly?: boolean; readonly categories?: readonly BlockCategory[] } = {}): readonly SlashCommandDefinition[] {
  const categories = options.categories ? new Set(options.categories) : undefined;
  return blockDefinitions
    .filter(definition => definition.slashAliases.length > 0)
    .filter(definition => options.includeCompatibilityOnly === true || !definition.flags.compatibilityOnly)
    .filter(definition => !categories || categories.has(definition.category))
    .map(definition => ({
      type: definition.type,
      label: definition.label,
      category: definition.category,
      aliases: definition.slashAliases,
      markdownShortcuts: definition.markdownShortcuts,
      accessibilityLabel: definition.accessibility.label,
      modelBacked: definition.modelBacked
    }));
}

export function findBlockTypesByAlias(alias: string): readonly CatalogBlockType[] {
  const normalized = normalizeAlias(alias);
  if (normalized.length === 0) return [];
  return blockDefinitions
    .filter(definition => definition.slashAliases.some(candidate => normalizeAlias(candidate) === normalized))
    .map(definition => definition.type);
}

export function isTextualBlock(type: CatalogBlockType): boolean {
  return Boolean(getBlockDefinition(type)?.flags.textual);
}

export function isMediaBlock(type: CatalogBlockType): boolean {
  return Boolean(getBlockDefinition(type)?.flags.media);
}

export function isLayoutBlock(type: CatalogBlockType): boolean {
  return Boolean(getBlockDefinition(type)?.flags.layout);
}

export function isDatabaseBlock(type: CatalogBlockType): boolean {
  return Boolean(getBlockDefinition(type)?.flags.database);
}

export const packageMetadata = {
  name: '@plim/blocks',
  status: 'implemented',
  implementsRuntime: true,
  dependsOn: ['@plim/model'],
  catalogSize: blockDefinitions.length
} as const;
