import type { BlockRecord, BlockType, DocumentState, Operation, ValidationIssue } from '@plim/model';
import { EditorError } from './errors.js';
import type { BlockSchema, Command, DocumentNormalizer, DocumentValidator, Renderer } from './types.js';

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private order = 0;
  private readonly registrationOrder = new Map<string, number>();

  register<TArgs = unknown>(command: Command<TArgs>): () => void {
    if (!command.id.trim()) throw new EditorError('command_failed', 'Command id is required');
    if (this.commands.has(command.id)) throw new EditorError('command_failed', `Command ${command.id} is already registered`);
    this.commands.set(command.id, command as Command);
    this.registrationOrder.set(command.id, this.order);
    this.order += 1;
    return () => {
      this.commands.delete(command.id);
      this.registrationOrder.delete(command.id);
    };
  }

  get<TArgs = unknown>(id: string): Command<TArgs> | undefined {
    return this.commands.get(id) as Command<TArgs> | undefined;
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  list(): Command[] {
    return [...this.commands.values()].sort((left, right) => {
      const priority = (right.priority ?? 0) - (left.priority ?? 0);
      if (priority !== 0) return priority;
      return (this.registrationOrder.get(left.id) ?? 0) - (this.registrationOrder.get(right.id) ?? 0);
    });
  }
}

export class SchemaRegistry {
  private readonly schemas = new Map<BlockType | string, BlockSchema>();

  register<TBlock extends BlockRecord = BlockRecord>(schema: BlockSchema<TBlock>): () => void {
    if (!String(schema.type).trim()) throw new EditorError('validation_failed', 'Schema type is required');
    const stored = schema as unknown as BlockSchema;
    this.schemas.set(schema.type, stored);
    return () => {
      if (this.schemas.get(schema.type) === stored) this.schemas.delete(schema.type);
    };
  }

  get(type: BlockType | string): BlockSchema | undefined {
    return this.schemas.get(type);
  }

  list(): BlockSchema[] {
    return [...this.schemas.values()];
  }

  validate(state: DocumentState): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const block of Object.values(state.blocks)) {
      const schema = this.schemas.get(block.type);
      if (!schema?.validate) continue;
      issues.push(...schema.validate(block, state));
    }
    return issues;
  }

  normalizers(): DocumentNormalizer[] {
    return this.list()
      .filter(schema => typeof schema.normalize === 'function')
      .map(schema => (state: DocumentState): readonly Operation[] => schema.normalize?.(state) ?? []);
  }
}

export class RendererRegistry {
  private readonly renderers = new Map<string, Renderer>();
  private readonly byType = new Map<BlockType | string, string>();

  register<TBlock extends BlockRecord = BlockRecord>(renderer: Renderer<TBlock>): () => void {
    if (!renderer.id.trim()) throw new EditorError('renderer_failed', 'Renderer id is required');
    this.renderers.set(renderer.id, renderer as Renderer);
    if (renderer.blockType) this.byType.set(renderer.blockType, renderer.id);
    return () => {
      if (this.renderers.get(renderer.id) === renderer) this.renderers.delete(renderer.id);
      if (renderer.blockType && this.byType.get(renderer.blockType) === renderer.id) this.byType.delete(renderer.blockType);
    };
  }

  get(id: string): Renderer | undefined {
    return this.renderers.get(id);
  }

  forBlock(type: BlockType | string): Renderer | undefined {
    const id = this.byType.get(type);
    return id ? this.renderers.get(id) : undefined;
  }

  list(): Renderer[] {
    return [...this.renderers.values()];
  }
}

export class ValidationRegistry {
  private readonly validators: DocumentValidator[] = [];
  private readonly normalizers: DocumentNormalizer[] = [];

  registerValidator(validator: DocumentValidator): () => void {
    this.validators.push(validator);
    return () => {
      const index = this.validators.indexOf(validator);
      if (index >= 0) this.validators.splice(index, 1);
    };
  }

  registerNormalizer(normalizer: DocumentNormalizer): () => void {
    this.normalizers.push(normalizer);
    return () => {
      const index = this.normalizers.indexOf(normalizer);
      if (index >= 0) this.normalizers.splice(index, 1);
    };
  }

  listValidators(): DocumentValidator[] {
    return [...this.validators];
  }

  listNormalizers(): DocumentNormalizer[] {
    return [...this.normalizers];
  }
}
