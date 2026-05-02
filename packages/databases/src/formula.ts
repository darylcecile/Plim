import { plainTextFromRichText } from '@plim/model';
import type {
  ComputedValue,
  DataSourceRecord,
  DateMention,
  PageId,
  PagePropertyValue,
  PropertyId
} from '@plim/model';
import type {
  ClientDatabaseState,
  CompiledFormula,
  FormulaAstNode,
  FormulaBinaryOperator,
  FormulaCompileOptions,
  FormulaDependency,
  FormulaDiagnostic,
  FormulaError,
  FormulaEvaluationContext,
  FormulaEvaluationInput,
  FormulaEvaluationResult,
  FormulaValue,
  FormulaValueType
} from './types.js';

const AST_VERSION = 1 as const;
const SUPPORTED_FUNCTIONS = new Set([
  'if',
  'ifs',
  'and',
  'or',
  'not',
  'empty',
  'format',
  'tonumber',
  'parsedate',
  'concat',
  'length',
  'substring',
  'contains',
  'startswith',
  'endswith',
  'lower',
  'upper',
  'replace',
  'replaceall',
  'test',
  'abs',
  'round',
  'ceil',
  'floor',
  'sqrt',
  'min',
  'max',
  'sum',
  'now',
  'today',
  'dateadd',
  'datesubtract',
  'datebetween',
  'formatdate',
  'timestamp',
  'fromtimestamp',
  'start',
  'end',
  'first',
  'last',
  'at',
  'flat',
  'unique',
  'join',
  'sort',
  'reverse',
  'prop'
]);

export const formulaNull = (): FormulaValue => ({ type: 'null' });
export const formulaBoolean = (value: boolean): FormulaValue => ({ type: 'boolean', value });
export const formulaNumber = (value: number): FormulaValue => Number.isFinite(value)
  ? { type: 'number', value }
  : formulaError('type_error', 'Formula number is not finite');
export const formulaString = (value: string): FormulaValue => ({ type: 'string', value });
export const formulaError = (code: FormulaError['code'], message: string, range?: { start: number; end: number }): FormulaValue => ({
  type: 'error',
  error: range ? { code, message, range } : { code, message }
});

export function defaultFormulaContext(now: string = new Date(0).toISOString()): FormulaEvaluationContext {
  return {
    now,
    timeZone: 'UTC',
    locale: 'en-US',
    maxDepth: 15
  };
}

export function compileFormula(expression: string, options: FormulaCompileOptions): CompiledFormula {
  const diagnostics: FormulaDiagnostic[] = [];
  let ast: FormulaAstNode;
  try {
    const parser = new FormulaParser(tokenize(expression));
    ast = parser.parse();
  } catch (error) {
    const message = error instanceof FormulaParseError ? error.message : 'Could not parse formula';
    const range = error instanceof FormulaParseError ? { start: error.start, end: error.end } : undefined;
    diagnostics.push({ severity: 'error', code: 'parse_error', message, ...(range ? { range } : {}) });
    ast = { kind: 'literal', value: formulaError('parse_error', message, range) };
  }

  const resolved = resolveProperties(ast, options.dataSource, diagnostics);
  const dependencies = extractFormulaDependencies(resolved, options.dataSource.id);
  const volatile = formulaIsVolatile(resolved);
  const returnType = inferFormulaReturnType(resolved);
  return {
    astVersion: AST_VERSION,
    ast: resolved,
    dependencies,
    returnType,
    volatile,
    diagnostics
  };
}

export function extractFormulaDependencies(ast: FormulaAstNode, dataSourceId: DataSourceRecord['id']): FormulaDependency[] {
  const seen = new Set<string>();
  const dependencies: FormulaDependency[] = [];
  visitFormulaAst(ast, node => {
    if (node.kind !== 'prop' || node.propertyId === undefined) return;
    const key = String(node.propertyId);
    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ dataSourceId, propertyId: node.propertyId });
    }
  });
  return dependencies;
}

export function formulaIsVolatile(ast: FormulaAstNode): boolean {
  let volatile = false;
  visitFormulaAst(ast, node => {
    if (node.kind === 'call') {
      const name = normalizeFunctionName(node.name);
      if (name === 'now' || name === 'today') volatile = true;
    }
  });
  return volatile;
}

export function inferFormulaReturnType(ast: FormulaAstNode): FormulaValueType | 'unknown' {
  if (ast.kind === 'literal') return ast.value.type;
  if (ast.kind === 'constant') {
    if (ast.name === 'null') return 'null';
    return 'boolean';
  }
  if (ast.kind === 'list') return 'list';
  if (ast.kind === 'unary') return ast.op === 'not' ? 'boolean' : 'number';
  if (ast.kind === 'binary') {
    if (['==', '!=', '<', '<=', '>', '>=', 'and', 'or'].includes(ast.op)) return 'boolean';
    return ast.op === '+' ? 'unknown' : 'number';
  }
  if (ast.kind === 'call') {
    const name = normalizeFunctionName(ast.name);
    if (['if', 'ifs', 'first', 'last', 'at', 'prop'].includes(name)) return 'unknown';
    if (['and', 'or', 'not', 'empty', 'contains', 'startswith', 'endswith', 'test'].includes(name)) return 'boolean';
    if (['format', 'concat', 'substring', 'lower', 'upper', 'replace', 'replaceall', 'formatdate', 'join'].includes(name)) return 'string';
    if (['tonumber', 'length', 'abs', 'round', 'ceil', 'floor', 'sqrt', 'min', 'max', 'sum', 'datebetween', 'timestamp'].includes(name)) return 'number';
    if (['now', 'today', 'parsedate', 'dateadd', 'datesubtract', 'fromtimestamp', 'start', 'end'].includes(name)) return 'date';
    if (['flat', 'unique', 'sort', 'reverse'].includes(name)) return 'list';
  }
  return 'unknown';
}

export function evaluateFormula(input: FormulaEvaluationInput, compiled?: CompiledFormula): FormulaEvaluationResult {
  const dataSource = input.state.dataSources[input.dataSourceId];
  if (dataSource === undefined) {
    return evaluationFailure('unsupported', `Missing data source ${String(input.dataSourceId)}`);
  }
  const property = dataSource.properties[input.propertyId];
  if (property === undefined || property.config.type !== 'formula') {
    return evaluationFailure('unsupported', `Property ${String(input.propertyId)} is not a formula`);
  }
  const formula = compiled ?? compileFormula(property.config.expression, { dataSource });
  return evaluateCompiledFormula(input, formula, new Set<string>(), 0);
}

export function evaluateCompiledFormula(
  input: FormulaEvaluationInput,
  formula: CompiledFormula,
  visited: Set<string> = new Set<string>(),
  depth = 0
): FormulaEvaluationResult {
  const diagnostics = [...formula.diagnostics];
  const dependencies = [...formula.dependencies];
  const key = `${String(input.dataSourceId)}:${String(input.pageId)}:${String(input.propertyId)}`;
  if (visited.has(key)) {
    const message = 'Formula dependency cycle detected';
    const value = formulaError('cycle', message);
    diagnostics.push({ severity: 'error', code: 'cycle', message });
    return { value, dependencies, volatile: formula.volatile, diagnostics };
  }
  if (depth > input.context.maxDepth) {
    const message = 'Formula dependency depth limit exceeded';
    const value = formulaError('depth_limit', message);
    diagnostics.push({ severity: 'error', code: 'depth_limit', message });
    return { value, dependencies, volatile: formula.volatile, diagnostics };
  }

  const nextVisited = new Set(visited);
  nextVisited.add(key);
  const env: FormulaEvalEnv = {
    state: input.state,
    dataSourceId: input.dataSourceId,
    pageId: input.pageId,
    propertyId: input.propertyId,
    context: input.context,
    diagnostics,
    dependencies,
    volatile: formula.volatile,
    visited: nextVisited,
    depth,
    variables: {}
  };
  const value = evaluateAst(formula.ast, env);
  return {
    value,
    dependencies: dedupeDependencies(dependencies),
    volatile: env.volatile,
    diagnostics
  };
}

export function formulaValueFromProperty(
  value: PagePropertyValue | undefined,
  state: ClientDatabaseState,
  dataSourceId: DataSourceRecord['id'],
  pageId: DataSourceRecord['entries'][PageId]['pageId'],
  context: FormulaEvaluationContext,
  visited: Set<string> = new Set<string>(),
  depth = 0
): FormulaValue {
  if (value === undefined) return formulaNull();
  switch (value.type) {
    case 'title':
      return formulaString(plainTextFromRichText(value.title));
    case 'rich_text':
      return formulaString(plainTextFromRichText(value.richText));
    case 'number':
      return value.number === null ? formulaNull() : formulaNumber(value.number);
    case 'select':
      return value.select === null ? formulaNull() : formulaString(value.select.name);
    case 'multi_select':
      return { type: 'list', items: value.multiSelect.map(option => formulaString(option.name)) };
    case 'status':
      return value.status === null ? formulaNull() : formulaString(value.status.name);
    case 'date':
      return value.date === null ? formulaNull() : { type: 'date', value: value.date };
    case 'formula':
      return computedToFormulaValue(value.formula);
    case 'relation':
      return { type: 'list', items: value.relation.map(reference => ({ type: 'page', pageId: reference.pageId, ...(reference.dataSourceId ? { dataSourceId: reference.dataSourceId } : {}) })) };
    case 'rollup':
      return computedToFormulaValue(value.rollup);
    case 'people':
      return { type: 'list', items: value.people.map(userId => ({ type: 'person', userId })) };
    case 'files':
      return { type: 'list', items: value.files.map(file => ({ type: 'file', file })) };
    case 'checkbox':
      return formulaBoolean(value.checkbox);
    case 'url':
      return value.url === null ? formulaNull() : formulaString(value.url);
    case 'email':
      return value.email === null ? formulaNull() : formulaString(value.email);
    case 'phone_number':
      return value.phoneNumber === null ? formulaNull() : formulaString(value.phoneNumber);
    case 'created_time':
      return { type: 'date', value: { start: value.createdTime } };
    case 'created_by':
      return { type: 'person', userId: value.createdBy };
    case 'last_edited_time':
      return { type: 'date', value: { start: value.lastEditedTime } };
    case 'last_edited_by':
      return { type: 'person', userId: value.lastEditedBy };
    case 'unique_id':
      return formulaNumber(value.uniqueId.number);
    case 'unsupported':
      return formulaError('unsupported', 'Unsupported property value');
  }
}

export function computedToFormulaValue(value: ComputedValue): FormulaValue {
  switch (value.type) {
    case 'number':
      return value.number === null ? formulaNull() : formulaNumber(value.number);
    case 'string':
      return value.string === null ? formulaNull() : formulaString(value.string);
    case 'boolean':
      return value.boolean === null ? formulaNull() : formulaBoolean(value.boolean);
    case 'date':
      return value.date === null ? formulaNull() : { type: 'date', value: value.date };
    case 'array':
      return { type: 'list', items: value.array.map(computedToFormulaValue) };
    case 'unsupported':
      return formulaError('unsupported', 'Unsupported computed value');
  }
}

export function formulaValueToComputedValue(value: FormulaValue): ComputedValue {
  switch (value.type) {
    case 'null':
      return { type: 'string', string: null };
    case 'boolean':
      return { type: 'boolean', boolean: value.value };
    case 'number':
      return { type: 'number', number: value.value };
    case 'string':
      return { type: 'string', string: value.value };
    case 'date':
      return { type: 'date', date: value.value };
    case 'list':
      return { type: 'array', array: value.items.map(formulaValueToComputedValue) };
    case 'person':
      return { type: 'string', string: String(value.userId) };
    case 'page':
      return { type: 'string', string: String(value.pageId) };
    case 'file':
      return { type: 'string', string: fileDisplay(value.file) };
    case 'error':
      return { type: 'unsupported', raw: { code: value.error.code, message: value.error.message } };
  }
}

function evaluationFailure(code: FormulaError['code'], message: string): FormulaEvaluationResult {
  const value = formulaError(code, message);
  return {
    value,
    dependencies: [],
    volatile: false,
    diagnostics: [{ severity: 'error', code, message }]
  };
}

function resolveProperties(ast: FormulaAstNode, dataSource: DataSourceRecord, diagnostics: FormulaDiagnostic[]): FormulaAstNode {
  if (ast.kind === 'call' && normalizeFunctionName(ast.name) === 'prop') {
    const arg = ast.args[0];
    if (arg?.kind !== 'literal' || arg.value.type !== 'string') {
      diagnostics.push({ severity: 'error', code: 'type_error', message: 'prop() requires a string property name or id' });
      return { kind: 'prop', nameSnapshot: '' };
    }
    const name = arg.value.value;
    const property = findPropertyByNameOrId(dataSource, name);
    if (property === undefined) {
      diagnostics.push({ severity: 'error', code: 'unknown_property', message: `Unknown property "${name}"` });
      return { kind: 'prop', nameSnapshot: name };
    }
    return { kind: 'prop', propertyId: property.id, nameSnapshot: property.name };
  }

  switch (ast.kind) {
    case 'literal':
    case 'constant':
    case 'prop':
    case 'variable':
      return ast;
    case 'unary':
      return { ...ast, argument: resolveProperties(ast.argument, dataSource, diagnostics) };
    case 'binary':
      return {
        ...ast,
        left: resolveProperties(ast.left, dataSource, diagnostics),
        right: resolveProperties(ast.right, dataSource, diagnostics)
      };
    case 'call':
      if (!SUPPORTED_FUNCTIONS.has(normalizeFunctionName(ast.name))) {
        diagnostics.push({ severity: 'warning', code: 'unknown_function', message: `Unknown function "${ast.name}"` });
      }
      return { ...ast, args: ast.args.map(arg => resolveProperties(arg, dataSource, diagnostics)) };
    case 'member':
      return { ...ast, object: resolveProperties(ast.object, dataSource, diagnostics) };
    case 'list':
      return { ...ast, items: ast.items.map(item => resolveProperties(item, dataSource, diagnostics)) };
    case 'lambda':
      return { ...ast, body: resolveProperties(ast.body, dataSource, diagnostics) };
  }
}

function findPropertyByNameOrId(dataSource: DataSourceRecord, nameOrId: string) {
  const direct = dataSource.properties[nameOrId as PropertyId];
  if (direct !== undefined) return direct;
  const normalized = normalizeText(nameOrId);
  return Object.values(dataSource.properties).find(property => normalizeText(property.name) === normalized);
}

function evaluateAst(ast: FormulaAstNode, env: FormulaEvalEnv): FormulaValue {
  switch (ast.kind) {
    case 'literal':
      return ast.value;
    case 'constant':
      if (ast.name === 'true') return formulaBoolean(true);
      if (ast.name === 'false') return formulaBoolean(false);
      return formulaNull();
    case 'prop':
      return evaluateProperty(ast, env);
    case 'variable':
      return env.variables[ast.name] ?? formulaError('unknown_property', `Unknown variable "${ast.name}"`);
    case 'unary': {
      const value = evaluateAst(ast.argument, env);
      if (value.type === 'error') return value;
      if (ast.op === 'not') return formulaBoolean(!truthy(value));
      const number = numberValue(value);
      return number.type === 'error' ? number : formulaNumber(-number.value);
    }
    case 'binary':
      return evaluateBinary(ast.op, ast.left, ast.right, env);
    case 'call':
      return evaluateCall(ast.name, ast.args, env);
    case 'member': {
      const object = evaluateAst(ast.object, env);
      if (object.type === 'error') return object;
      return readMember(object, ast.property);
    }
    case 'list': {
      const items: FormulaValue[] = [];
      for (const item of ast.items) {
        const value = evaluateAst(item, env);
        if (value.type === 'error') return value;
        items.push(value);
      }
      return { type: 'list', items };
    }
    case 'lambda':
      return formulaError('unsupported', 'Lambda formulas are not supported by this evaluator subset');
  }
}

function evaluateProperty(ast: Extract<FormulaAstNode, { kind: 'prop' }>, env: FormulaEvalEnv): FormulaValue {
  if (ast.propertyId === undefined) return formulaError('unknown_property', `Unknown property "${ast.nameSnapshot}"`);
  env.dependencies.push({ dataSourceId: env.dataSourceId, pageId: env.pageId, propertyId: ast.propertyId });
  const dataSource = env.state.dataSources[env.dataSourceId];
  const page = env.state.pages[env.pageId];
  const property = dataSource?.properties[ast.propertyId];
  if (dataSource === undefined || page === undefined || property === undefined) {
    return formulaError('unknown_property', `Unknown property "${ast.nameSnapshot}"`);
  }
  if (property.config.type === 'formula') {
    const compiled = compileFormula(property.config.expression, { dataSource });
    const result = evaluateCompiledFormula({
      state: env.state,
      dataSourceId: env.dataSourceId,
      pageId: env.pageId,
      propertyId: ast.propertyId,
      context: env.context
    }, compiled, env.visited, env.depth + 1);
    env.dependencies.push(...result.dependencies);
    env.diagnostics.push(...result.diagnostics);
    env.volatile = env.volatile || result.volatile;
    return result.value;
  }
  return formulaValueFromProperty(page.properties[ast.propertyId], env.state, env.dataSourceId, env.pageId, env.context, env.visited, env.depth);
}

function evaluateBinary(op: FormulaBinaryOperator, leftNode: FormulaAstNode, rightNode: FormulaAstNode, env: FormulaEvalEnv): FormulaValue {
  if (op === 'and') {
    const left = evaluateAst(leftNode, env);
    if (left.type === 'error') return left;
    return truthy(left) ? formulaBoolean(truthy(evaluateAst(rightNode, env))) : formulaBoolean(false);
  }
  if (op === 'or') {
    const left = evaluateAst(leftNode, env);
    if (left.type === 'error') return left;
    return truthy(left) ? formulaBoolean(true) : formulaBoolean(truthy(evaluateAst(rightNode, env)));
  }

  const left = evaluateAst(leftNode, env);
  if (left.type === 'error') return left;
  const right = evaluateAst(rightNode, env);
  if (right.type === 'error') return right;

  switch (op) {
    case '+':
      if (left.type === 'string' || right.type === 'string') return formulaString(displayString(left, env.context) + displayString(right, env.context));
      return binaryNumbers(left, right, (a, b) => a + b);
    case '-':
      return binaryNumbers(left, right, (a, b) => a - b);
    case '*':
      return binaryNumbers(left, right, (a, b) => a * b);
    case '/': {
      const divisor = numberValue(right);
      if (divisor.type === 'error') return divisor;
      if (divisor.value === 0) return formulaError('division_by_zero', 'Division by zero');
      const dividend = numberValue(left);
      return dividend.type === 'error' ? dividend : formulaNumber(dividend.value / divisor.value);
    }
    case '%': {
      const divisor = numberValue(right);
      if (divisor.type === 'error') return divisor;
      if (divisor.value === 0) return formulaError('division_by_zero', 'Modulo by zero');
      const dividend = numberValue(left);
      return dividend.type === 'error' ? dividend : formulaNumber(dividend.value % divisor.value);
    }
    case '==':
      return formulaBoolean(compareIdentity(left, right) === 0);
    case '!=':
      return formulaBoolean(compareIdentity(left, right) !== 0);
    case '<':
      return formulaBoolean(compareOrder(left, right) < 0);
    case '<=':
      return formulaBoolean(compareOrder(left, right) <= 0);
    case '>':
      return formulaBoolean(compareOrder(left, right) > 0);
    case '>=':
      return formulaBoolean(compareOrder(left, right) >= 0);
  }
}

function evaluateCall(name: string, args: FormulaAstNode[], env: FormulaEvalEnv): FormulaValue {
  const normalized = normalizeFunctionName(name);
  switch (normalized) {
    case 'if': {
      const condition = evaluateAst(args[0] ?? literalNull(), env);
      if (condition.type === 'error') return condition;
      return truthy(condition)
        ? evaluateAst(args[1] ?? literalNull(), env)
        : evaluateAst(args[2] ?? literalNull(), env);
    }
    case 'ifs':
      for (let index = 0; index < args.length - 1; index += 2) {
        const condition = evaluateAst(args[index] ?? literalNull(), env);
        if (condition.type === 'error') return condition;
        if (truthy(condition)) return evaluateAst(args[index + 1] ?? literalNull(), env);
      }
      return args.length % 2 === 1 ? evaluateAst(args[args.length - 1] ?? literalNull(), env) : formulaNull();
    case 'and':
      for (const arg of args) {
        const value = evaluateAst(arg, env);
        if (value.type === 'error') return value;
        if (!truthy(value)) return formulaBoolean(false);
      }
      return formulaBoolean(true);
    case 'or':
      for (const arg of args) {
        const value = evaluateAst(arg, env);
        if (value.type === 'error') return value;
        if (truthy(value)) return formulaBoolean(true);
      }
      return formulaBoolean(false);
    default:
      return evaluateEagerCall(normalized, args.map(arg => evaluateAst(arg, env)), env);
  }
}

function evaluateEagerCall(name: string, values: FormulaValue[], env: FormulaEvalEnv): FormulaValue {
  const error = values.find(value => value.type === 'error');
  if (error !== undefined) return error;
  switch (name) {
    case 'not':
      return formulaBoolean(!truthy(values[0] ?? formulaNull()));
    case 'empty':
      return formulaBoolean(isFormulaEmpty(values[0] ?? formulaNull()));
    case 'format':
      return formulaString(displayString(values[0] ?? formulaNull(), env.context));
    case 'tonumber':
      return toNumberFunction(values[0] ?? formulaNull());
    case 'parsedate':
      return parseDateFunction(values[0] ?? formulaNull());
    case 'concat':
      return formulaString(values.map(value => displayString(value, env.context)).join(''));
    case 'length':
      return formulaNumber(lengthFunction(values[0] ?? formulaNull()));
    case 'substring':
      return substringFunction(values);
    case 'contains':
      return formulaBoolean(displayString(values[0] ?? formulaNull(), env.context).includes(displayString(values[1] ?? formulaNull(), env.context)));
    case 'startswith':
      return formulaBoolean(displayString(values[0] ?? formulaNull(), env.context).startsWith(displayString(values[1] ?? formulaNull(), env.context)));
    case 'endswith':
      return formulaBoolean(displayString(values[0] ?? formulaNull(), env.context).endsWith(displayString(values[1] ?? formulaNull(), env.context)));
    case 'lower':
      return formulaString(displayString(values[0] ?? formulaNull(), env.context).toLocaleLowerCase(env.context.locale));
    case 'upper':
      return formulaString(displayString(values[0] ?? formulaNull(), env.context).toLocaleUpperCase(env.context.locale));
    case 'replace':
      return replaceFunction(values, false, env.context);
    case 'replaceall':
      return replaceFunction(values, true, env.context);
    case 'test':
      return regexFunction(values, env.context);
    case 'abs':
      return numberUnary(values[0] ?? formulaNull(), Math.abs);
    case 'round':
      return numberUnary(values[0] ?? formulaNull(), Math.round);
    case 'ceil':
      return numberUnary(values[0] ?? formulaNull(), Math.ceil);
    case 'floor':
      return numberUnary(values[0] ?? formulaNull(), Math.floor);
    case 'sqrt':
      return numberUnary(values[0] ?? formulaNull(), Math.sqrt);
    case 'min':
      return aggregateNumber(values, numbers => Math.min(...numbers));
    case 'max':
      return aggregateNumber(values, numbers => Math.max(...numbers));
    case 'sum':
      return aggregateNumber(values, numbers => numbers.reduce((total, value) => total + value, 0));
    case 'now':
      env.volatile = true;
      return { type: 'date', value: { start: env.context.now, includeTime: true, timeZone: env.context.timeZone } };
    case 'today':
      env.volatile = true;
      return { type: 'date', value: { start: env.context.now.slice(0, 10), timeZone: env.context.timeZone } };
    case 'dateadd':
      return dateAddFunction(values, 1);
    case 'datesubtract':
      return dateAddFunction(values, -1);
    case 'datebetween':
      return dateBetweenFunction(values);
    case 'formatdate':
      return formulaString(displayString(values[0] ?? formulaNull(), env.context));
    case 'timestamp':
      return timestampFunction(values[0] ?? formulaNull());
    case 'fromtimestamp':
      return fromTimestampFunction(values[0] ?? formulaNull());
    case 'start':
      return dateBoundaryFunction(values[0] ?? formulaNull(), 'start');
    case 'end':
      return dateBoundaryFunction(values[0] ?? formulaNull(), 'end');
    case 'first':
      return listAt(values[0] ?? formulaNull(), 0);
    case 'last':
      return listAt(values[0] ?? formulaNull(), -1);
    case 'at':
      return atFunction(values);
    case 'flat':
      return flatFunction(values[0] ?? formulaNull());
    case 'unique':
      return uniqueFunction(values[0] ?? formulaNull());
    case 'join':
      return joinFunction(values, env.context);
    case 'sort':
      return sortListFunction(values[0] ?? formulaNull(), env.context);
    case 'reverse':
      return reverseFunction(values[0] ?? formulaNull());
    case 'prop':
      return formulaError('evaluation_error', 'prop() was not resolved during compilation');
    default:
      return formulaError('unknown_function', `Unknown function "${name}"`);
  }
}

function literalNull(): FormulaAstNode {
  return { kind: 'literal', value: formulaNull() };
}

function binaryNumbers(left: FormulaValue, right: FormulaValue, op: (a: number, b: number) => number): FormulaValue {
  const a = numberValue(left);
  if (a.type === 'error') return a;
  const b = numberValue(right);
  if (b.type === 'error') return b;
  return formulaNumber(op(a.value, b.value));
}

function numberUnary(value: FormulaValue, op: (value: number) => number): FormulaValue {
  const number = numberValue(value);
  return number.type === 'error' ? number : formulaNumber(op(number.value));
}

type NumberOrError = Extract<FormulaValue, { type: 'number' }> | Extract<FormulaValue, { type: 'error' }>;
type ListOrError = Extract<FormulaValue, { type: 'list' }> | Extract<FormulaValue, { type: 'error' }>;

function errorValue(code: FormulaError['code'], message: string): Extract<FormulaValue, { type: 'error' }> {
  return { type: 'error', error: { code, message } };
}

function numberValue(value: FormulaValue): NumberOrError {
  if (value.type === 'number') return value;
  return errorValue('type_error', `Expected number, received ${value.type}`);
}

function listValue(value: FormulaValue): ListOrError {
  if (value.type === 'list') return value;
  return errorValue('type_error', `Expected list, received ${value.type}`);
}

function truthy(value: FormulaValue): boolean {
  switch (value.type) {
    case 'null':
      return false;
    case 'boolean':
      return value.value;
    case 'number':
      return value.value !== 0;
    case 'string':
      return value.value.length > 0;
    case 'date':
    case 'person':
    case 'page':
    case 'file':
      return true;
    case 'list':
      return value.items.length > 0;
    case 'error':
      return false;
  }
}

function isFormulaEmpty(value: FormulaValue): boolean {
  switch (value.type) {
    case 'null':
      return true;
    case 'string':
      return value.value.length === 0;
    case 'list':
      return value.items.length === 0;
    case 'number':
    case 'boolean':
    case 'date':
    case 'person':
    case 'page':
    case 'file':
    case 'error':
      return false;
  }
}

function displayString(value: FormulaValue, context: FormulaEvaluationContext): string {
  switch (value.type) {
    case 'null':
      return '';
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'number':
      return String(value.value);
    case 'string':
      return value.value;
    case 'date':
      return value.value.end ? `${value.value.start} → ${value.value.end}` : String(value.value.start);
    case 'person':
      return String(value.userId);
    case 'page':
      return String(value.pageId);
    case 'file':
      return fileDisplay(value.file);
    case 'list':
      return value.items.map(item => displayString(item, context)).join(', ');
    case 'error':
      return `#${value.error.code}`;
  }
}

function fileDisplay(file: import('@plim/model').FileRef): string {
  if (file.type === 'external') return file.name ?? file.url;
  if (file.type === 'data_url') return file.name ?? file.mimeType ?? 'file';
  return String(file.fileId);
}

function compareIdentity(left: FormulaValue, right: FormulaValue): number {
  return stableIdentity(left).localeCompare(stableIdentity(right));
}

function compareOrder(left: FormulaValue, right: FormulaValue): number {
  if (left.type === 'null' || right.type === 'null') return 0;
  if (left.type === 'number' && right.type === 'number') return left.value - right.value;
  if (left.type === 'date' && right.type === 'date') return dateMillis(left.value) - dateMillis(right.value);
  if (left.type === 'boolean' && right.type === 'boolean') return Number(left.value) - Number(right.value);
  if (left.type === 'string' && right.type === 'string') return left.value.localeCompare(right.value);
  return stableIdentity(left).localeCompare(stableIdentity(right));
}

function stableIdentity(value: FormulaValue): string {
  switch (value.type) {
    case 'null':
      return 'null';
    case 'boolean':
      return `boolean:${String(value.value)}`;
    case 'number':
      return `number:${String(value.value)}`;
    case 'string':
      return `string:${value.value}`;
    case 'date':
      return `date:${value.value.start}:${value.value.end ?? ''}`;
    case 'person':
      return `person:${String(value.userId)}`;
    case 'page':
      return `page:${String(value.pageId)}`;
    case 'file':
      return `file:${fileDisplay(value.file)}`;
    case 'list':
      return `list:[${value.items.map(stableIdentity).join('|')}]`;
    case 'error':
      return `error:${value.error.code}:${value.error.message}`;
  }
}

function toNumberFunction(value: FormulaValue): FormulaValue {
  if (value.type === 'number') return value;
  if (value.type === 'null') return formulaNumber(0);
  if (value.type === 'boolean') return formulaNumber(value.value ? 1 : 0);
  if (value.type === 'string') {
    const parsed = Number(value.value.trim());
    return Number.isFinite(parsed) ? formulaNumber(parsed) : formulaNull();
  }
  if (value.type === 'date') return formulaNumber(dateMillis(value.value));
  return formulaError('type_error', `Cannot convert ${value.type} to number`);
}

function parseDateFunction(value: FormulaValue): FormulaValue {
  if (value.type === 'date') return value;
  const source = value.type === 'string' ? value.value : '';
  const parsed = Date.parse(source);
  return Number.isNaN(parsed) ? formulaNull() : { type: 'date', value: { start: new Date(parsed).toISOString() } };
}

function lengthFunction(value: FormulaValue): number {
  if (value.type === 'list') return value.items.length;
  if (value.type === 'string') return value.value.length;
  return displayString(value, defaultFormulaContext()).length;
}

function substringFunction(values: FormulaValue[]): FormulaValue {
  const text = displayString(values[0] ?? formulaNull(), defaultFormulaContext());
  const start = numberValue(values[1] ?? formulaNumber(0));
  if (start.type === 'error') return start;
  const end = values[2] === undefined ? undefined : numberValue(values[2]);
  if (end?.type === 'error') return end;
  return formulaString(text.slice(Math.trunc(start.value), end === undefined ? undefined : Math.trunc(end.value)));
}

function replaceFunction(values: FormulaValue[], all: boolean, context: FormulaEvaluationContext): FormulaValue {
  const text = displayString(values[0] ?? formulaNull(), context);
  const pattern = displayString(values[1] ?? formulaNull(), context);
  const replacement = displayString(values[2] ?? formulaNull(), context);
  if (pattern.length === 0) return formulaString(text);
  return formulaString(all ? text.split(pattern).join(replacement) : text.replace(pattern, replacement));
}

function regexFunction(values: FormulaValue[], context: FormulaEvaluationContext): FormulaValue {
  try {
    return formulaBoolean(new RegExp(displayString(values[1] ?? formulaNull(), context)).test(displayString(values[0] ?? formulaNull(), context)));
  } catch {
    return formulaError('evaluation_error', 'Invalid regular expression');
  }
}

function aggregateNumber(values: FormulaValue[], op: (numbers: number[]) => number): FormulaValue {
  const numbers = flattenFormulaValues(values).flatMap(value => value.type === 'number' ? [value.value] : []);
  return numbers.length === 0 ? formulaNull() : formulaNumber(op(numbers));
}

function flattenFormulaValues(values: FormulaValue[]): FormulaValue[] {
  const flattened: FormulaValue[] = [];
  for (const value of values) {
    if (value.type === 'list') flattened.push(...flattenFormulaValues(value.items));
    else flattened.push(value);
  }
  return flattened;
}

function dateAddFunction(values: FormulaValue[], direction: 1 | -1): FormulaValue {
  const date = values[0] ?? formulaNull();
  const amount = numberValue(values[1] ?? formulaNumber(0));
  const unit = values[2]?.type === 'string' ? values[2].value : 'days';
  if (date.type !== 'date') return formulaError('type_error', 'dateAdd requires a date');
  if (amount.type === 'error') return amount;
  const base = new Date(date.value.start);
  const delta = Math.trunc(amount.value) * direction;
  switch (unit.toLocaleLowerCase()) {
    case 'minute':
    case 'minutes':
      base.setUTCMinutes(base.getUTCMinutes() + delta);
      break;
    case 'hour':
    case 'hours':
      base.setUTCHours(base.getUTCHours() + delta);
      break;
    case 'week':
    case 'weeks':
      base.setUTCDate(base.getUTCDate() + delta * 7);
      break;
    case 'month':
    case 'months':
      base.setUTCMonth(base.getUTCMonth() + delta);
      break;
    case 'year':
    case 'years':
      base.setUTCFullYear(base.getUTCFullYear() + delta);
      break;
    default:
      base.setUTCDate(base.getUTCDate() + delta);
  }
  return { type: 'date', value: { ...date.value, start: base.toISOString() } };
}

function dateBetweenFunction(values: FormulaValue[]): FormulaValue {
  const end = values[0] ?? formulaNull();
  const start = values[1] ?? formulaNull();
  const unit = values[2]?.type === 'string' ? values[2].value.toLocaleLowerCase() : 'days';
  if (end.type !== 'date' || start.type !== 'date') return formulaError('type_error', 'dateBetween requires two dates');
  const millis = dateMillis(end.value) - dateMillis(start.value);
  const divisor = unit.startsWith('minute') ? 60_000
    : unit.startsWith('hour') ? 3_600_000
      : unit.startsWith('week') ? 604_800_000
        : unit.startsWith('month') ? 2_592_000_000
          : unit.startsWith('year') ? 31_536_000_000
            : 86_400_000;
  return formulaNumber(Math.trunc(millis / divisor));
}

function timestampFunction(value: FormulaValue): FormulaValue {
  return value.type === 'date' ? formulaNumber(dateMillis(value.value)) : formulaError('type_error', 'timestamp requires a date');
}

function fromTimestampFunction(value: FormulaValue): FormulaValue {
  const number = numberValue(value);
  return number.type === 'error' ? number : { type: 'date', value: { start: new Date(number.value).toISOString() } };
}

function dateBoundaryFunction(value: FormulaValue, boundary: 'start' | 'end'): FormulaValue {
  if (value.type !== 'date') return formulaError('type_error', `${boundary} requires a date`);
  const date = boundary === 'start' ? value.value.start : (value.value.end ?? value.value.start);
  return { type: 'date', value: { ...value.value, start: date } };
}

function dateMillis(date: DateMention): number {
  const parsed = Date.parse(date.start);
  return Number.isNaN(parsed) ? Date.parse(`${date.start}T00:00:00.000Z`) : parsed;
}

function listAt(value: FormulaValue, index: number): FormulaValue {
  const list = listValue(value);
  if (list.type === 'error') return list;
  const resolved = index < 0 ? list.items.length + index : index;
  return list.items[resolved] ?? formulaNull();
}

function atFunction(values: FormulaValue[]): FormulaValue {
  const index = numberValue(values[1] ?? formulaNumber(0));
  return index.type === 'error' ? index : listAt(values[0] ?? formulaNull(), Math.trunc(index.value));
}

function flatFunction(value: FormulaValue): FormulaValue {
  const list = listValue(value);
  if (list.type === 'error') return list;
  return { type: 'list', items: flattenFormulaValues(list.items) };
}

function uniqueFunction(value: FormulaValue): FormulaValue {
  const list = listValue(value);
  if (list.type === 'error') return list;
  const seen = new Set<string>();
  const items: FormulaValue[] = [];
  for (const item of list.items) {
    const identity = stableIdentity(item);
    if (!seen.has(identity)) {
      seen.add(identity);
      items.push(item);
    }
  }
  return { type: 'list', items };
}

function joinFunction(values: FormulaValue[], context: FormulaEvaluationContext): FormulaValue {
  const list = listValue(values[0] ?? formulaNull());
  if (list.type === 'error') return list;
  const separator = values[1] === undefined ? ', ' : displayString(values[1], context);
  return formulaString(list.items.map(item => displayString(item, context)).join(separator));
}

function sortListFunction(value: FormulaValue, context: FormulaEvaluationContext): FormulaValue {
  const list = listValue(value);
  if (list.type === 'error') return list;
  return { type: 'list', items: [...list.items].sort((left, right) => displayString(left, context).localeCompare(displayString(right, context), context.locale)) };
}

function reverseFunction(value: FormulaValue): FormulaValue {
  const list = listValue(value);
  if (list.type === 'error') return list;
  return { type: 'list', items: [...list.items].reverse() };
}

function readMember(value: FormulaValue, property: string): FormulaValue {
  switch (value.type) {
    case 'date':
      if (property === 'start') return formulaString(String(value.value.start));
      if (property === 'end') return value.value.end === undefined ? formulaNull() : formulaString(String(value.value.end));
      break;
    case 'page':
      if (property === 'id') return formulaString(String(value.pageId));
      if (property === 'dataSourceId') return value.dataSourceId === undefined ? formulaNull() : formulaString(String(value.dataSourceId));
      break;
    case 'person':
      if (property === 'id') return formulaString(String(value.userId));
      break;
    case 'file':
      if (property === 'name' || property === 'url') return formulaString(fileDisplay(value.file));
      break;
    case 'list':
      if (property === 'length') return formulaNumber(value.items.length);
      break;
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
    case 'error':
      break;
  }
  return formulaNull();
}

function dedupeDependencies(dependencies: FormulaDependency[]): FormulaDependency[] {
  const seen = new Set<string>();
  const deduped: FormulaDependency[] = [];
  for (const dependency of dependencies) {
    const key = `${String(dependency.dataSourceId)}:${String(dependency.pageId ?? '')}:${String(dependency.propertyId)}:${(dependency.relationTraversal ?? []).map(String).join('/')}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(dependency);
    }
  }
  return deduped;
}

function visitFormulaAst(ast: FormulaAstNode, visit: (node: FormulaAstNode) => void): void {
  visit(ast);
  switch (ast.kind) {
    case 'unary':
      visitFormulaAst(ast.argument, visit);
      break;
    case 'binary':
      visitFormulaAst(ast.left, visit);
      visitFormulaAst(ast.right, visit);
      break;
    case 'call':
      ast.args.forEach(arg => visitFormulaAst(arg, visit));
      break;
    case 'member':
      visitFormulaAst(ast.object, visit);
      break;
    case 'list':
      ast.items.forEach(item => visitFormulaAst(item, visit));
      break;
    case 'lambda':
      visitFormulaAst(ast.body, visit);
      break;
    case 'literal':
    case 'constant':
    case 'prop':
    case 'variable':
      break;
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('en-US');
}

function normalizeFunctionName(name: string): string {
  return name.replace(/_/g, '').toLocaleLowerCase('en-US');
}

interface FormulaEvalEnv {
  state: ClientDatabaseState;
  dataSourceId: DataSourceRecord['id'];
  pageId: PageId;
  propertyId: PropertyId;
  context: FormulaEvaluationContext;
  diagnostics: FormulaDiagnostic[];
  dependencies: FormulaDependency[];
  volatile: boolean;
  visited: Set<string>;
  depth: number;
  variables: Record<string, FormulaValue>;
}

type TokenKind = 'number' | 'string' | 'identifier' | 'operator' | 'left_paren' | 'right_paren' | 'comma' | 'left_bracket' | 'right_bracket' | 'dot' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

class FormulaParseError extends Error {
  readonly start: number;
  readonly end: number;

  constructor(message: string, token: Token) {
    super(message);
    this.start = token.start;
    this.end = token.end;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    const start = index;
    if (/[0-9]/u.test(char) || (char === '.' && /[0-9]/u.test(source[index + 1] ?? ''))) {
      index += 1;
      while (/[0-9_]/u.test(source[index] ?? '')) index += 1;
      if (source[index] === '.') {
        index += 1;
        while (/[0-9_]/u.test(source[index] ?? '')) index += 1;
      }
      tokens.push({ kind: 'number', value: source.slice(start, index).replace(/_/g, ''), start, end: index });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      let value = '';
      while (index < source.length && source[index] !== quote) {
        const next = source[index] ?? '';
        if (next === '\\') {
          const escaped = source[index + 1] ?? '';
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          index += 2;
        } else {
          value += next;
          index += 1;
        }
      }
      if (source[index] !== quote) throw new FormulaParseError('Unterminated string literal', { kind: 'string', value, start, end: index });
      index += 1;
      tokens.push({ kind: 'string', value, start, end: index });
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      index += 1;
      while (/[A-Za-z0-9_]/u.test(source[index] ?? '')) index += 1;
      tokens.push({ kind: 'identifier', value: source.slice(start, index), start, end: index });
      continue;
    }
    const two = source.slice(index, index + 2);
    if (['==', '!=', '<=', '>='].includes(two)) {
      tokens.push({ kind: 'operator', value: two, start, end: index + 2 });
      index += 2;
      continue;
    }
    if ('+-*/%<>'.includes(char)) {
      tokens.push({ kind: 'operator', value: char, start, end: index + 1 });
      index += 1;
      continue;
    }
    const simpleKind = char === '(' ? 'left_paren'
      : char === ')' ? 'right_paren'
        : char === ',' ? 'comma'
          : char === '[' ? 'left_bracket'
            : char === ']' ? 'right_bracket'
              : char === '.' ? 'dot'
                : undefined;
    if (simpleKind !== undefined) {
      tokens.push({ kind: simpleKind, value: char, start, end: index + 1 });
      index += 1;
      continue;
    }
    throw new FormulaParseError(`Unexpected character "${char}"`, { kind: 'operator', value: char, start, end: index + 1 });
  }
  tokens.push({ kind: 'eof', value: '', start: source.length, end: source.length });
  return tokens;
}

class FormulaParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): FormulaAstNode {
    const expression = this.parseOr();
    this.expect('eof');
    return expression;
  }

  private parseOr(): FormulaAstNode {
    let node = this.parseAnd();
    while (this.matchKeyword('or')) {
      node = { kind: 'binary', op: 'or', left: node, right: this.parseAnd() };
    }
    return node;
  }

  private parseAnd(): FormulaAstNode {
    let node = this.parseEquality();
    while (this.matchKeyword('and')) {
      node = { kind: 'binary', op: 'and', left: node, right: this.parseEquality() };
    }
    return node;
  }

  private parseEquality(): FormulaAstNode {
    let node = this.parseComparison();
    while (this.peek().kind === 'operator' && (this.peek().value === '==' || this.peek().value === '!=')) {
      const op = this.advance().value as '==' | '!=';
      node = { kind: 'binary', op, left: node, right: this.parseComparison() };
    }
    return node;
  }

  private parseComparison(): FormulaAstNode {
    let node = this.parseTerm();
    while (this.peek().kind === 'operator' && ['<', '<=', '>', '>='].includes(this.peek().value)) {
      const op = this.advance().value as '<' | '<=' | '>' | '>=';
      node = { kind: 'binary', op, left: node, right: this.parseTerm() };
    }
    return node;
  }

  private parseTerm(): FormulaAstNode {
    let node = this.parseFactor();
    while (this.peek().kind === 'operator' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.advance().value as '+' | '-';
      node = { kind: 'binary', op, left: node, right: this.parseFactor() };
    }
    return node;
  }

  private parseFactor(): FormulaAstNode {
    let node = this.parseUnary();
    while (this.peek().kind === 'operator' && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.advance().value as '*' | '/' | '%';
      node = { kind: 'binary', op, left: node, right: this.parseUnary() };
    }
    return node;
  }

  private parseUnary(): FormulaAstNode {
    if (this.matchKeyword('not')) return { kind: 'unary', op: 'not', argument: this.parseUnary() };
    if (this.peek().kind === 'operator' && this.peek().value === '-') {
      this.advance();
      return { kind: 'unary', op: 'negate', argument: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): FormulaAstNode {
    let node = this.parsePrimary();
    while (true) {
      if (this.match('left_paren')) {
        if (node.kind !== 'variable') throw new FormulaParseError('Only named functions can be called', this.previous());
        const args = this.parseArguments();
        node = { kind: 'call', name: node.name, args };
        continue;
      }
      if (this.match('dot')) {
        const property = this.expect('identifier').value;
        node = { kind: 'member', object: node, property };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): FormulaAstNode {
    const token = this.peek();
    if (this.match('number')) return { kind: 'literal', value: formulaNumber(Number(token.value)) };
    if (this.match('string')) return { kind: 'literal', value: formulaString(token.value) };
    if (this.match('identifier')) {
      const normalized = token.value.toLocaleLowerCase('en-US');
      if (normalized === 'true' || normalized === 'false' || normalized === 'null') return { kind: 'constant', name: normalized };
      return { kind: 'variable', name: token.value };
    }
    if (this.match('left_paren')) {
      const expression = this.parseOr();
      this.expect('right_paren');
      return expression;
    }
    if (this.match('left_bracket')) {
      const items: FormulaAstNode[] = [];
      if (!this.match('right_bracket')) {
        do {
          items.push(this.parseOr());
        } while (this.match('comma'));
        this.expect('right_bracket');
      }
      return { kind: 'list', items };
    }
    throw new FormulaParseError(`Unexpected token "${token.value}"`, token);
  }

  private parseArguments(): FormulaAstNode[] {
    const args: FormulaAstNode[] = [];
    if (this.match('right_paren')) return args;
    do {
      args.push(this.parseOr());
    } while (this.match('comma'));
    this.expect('right_paren');
    return args;
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind !== kind) return false;
    this.advance();
    return true;
  }

  private matchKeyword(keyword: 'and' | 'or' | 'not'): boolean {
    const token = this.peek();
    if (token.kind !== 'identifier' || token.value.toLocaleLowerCase('en-US') !== keyword) return false;
    this.advance();
    return true;
  }

  private expect(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) throw new FormulaParseError(`Expected ${kind}, received "${token.value}"`, token);
    return this.advance();
  }

  private advance(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1] ?? { kind: 'eof', value: '', start: 0, end: 0 };
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)] ?? { kind: 'eof', value: '', start: 0, end: 0 };
  }
}
