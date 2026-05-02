import type { CommandInvocation, PageId, RichText } from './types.js';
import { ensureUrl, foldForSearch, isProbablyUrl } from './text-utils.js';

export type AutocompleteKind = 'mention' | 'page-link' | 'page-create' | 'date' | 'reminder' | 'equation' | 'link';

export interface AutocompleteSession {
  kind: AutocompleteKind;
  trigger: '@' | '[[' | '+' | '/equation' | '/math' | 'url';
  query: string;
  range: { start: number; end: number };
  priority: number;
}

export interface AutocompleteItem {
  id: string;
  kind: AutocompleteKind;
  title: string;
  subtitle?: string;
  score: number;
  command: CommandInvocation;
  richText?: RichText;
}

export interface LocalPageCandidate {
  id: PageId | string;
  title: string;
  kind?: 'page' | 'database';
}

export interface LocalPersonCandidate {
  id: string;
  name: string;
  subtitle?: string;
}

export interface AutocompleteLocalData {
  pages?: readonly LocalPageCandidate[];
  people?: readonly LocalPersonCandidate[];
  now?: Date;
}

export function detectAutocompleteTrigger(text: string, caretOffset: number, composing = false): AutocompleteSession | null {
  if (composing) return null;
  const caret = Math.max(0, Math.min(caretOffset, text.length));
  const before = text.slice(0, caret);

  const equation = before.match(/\/(equation|math)(?:\s+([^\n]*))?$/u);
  if (equation?.index !== undefined) {
    return { kind: 'equation', trigger: equation[1] === 'math' ? '/math' : '/equation', query: equation[2] ?? '', range: { start: equation.index, end: caret }, priority: 70 };
  }

  const url = findUrlAtEnd(before);
  if (url) {
    return { kind: 'link', trigger: 'url', query: url.text, range: { start: url.start, end: caret }, priority: 20 };
  }

  const pageLinkIndex = before.lastIndexOf('[[');
  if (pageLinkIndex >= 0 && !before.slice(pageLinkIndex + 2).includes(']')) {
    return { kind: 'page-link', trigger: '[[', query: before.slice(pageLinkIndex + 2), range: { start: pageLinkIndex, end: caret }, priority: 90 };
  }

  const plus = before.match(/(?:^|[\s(])\+([^\s][^\n]*)?$/u);
  if (plus?.index !== undefined) {
    const plusIndex = before.lastIndexOf('+');
    if (!/^\s*\+\s$/u.test(before.slice(Math.max(0, before.lastIndexOf('\n') + 1)))) {
      return { kind: 'page-create', trigger: '+', query: plus[1] ?? '', range: { start: plusIndex, end: caret }, priority: 80 };
    }
  }

  const atIndex = before.lastIndexOf('@');
  if (atIndex >= 0 && (atIndex === 0 || /[^\p{L}\p{N}_]/u.test(before.charAt(atIndex - 1)))) {
    const query = before.slice(atIndex + 1);
    if (!/[\n\s]{2,}/u.test(query) && !query.includes('/')) {
      const folded = foldForSearch(query);
      const kind: AutocompleteKind = folded.startsWith('remind') ? 'reminder' : dateCandidateFromQuery(folded, new Date()) ? 'date' : 'mention';
      return { kind, trigger: '@', query, range: { start: atIndex, end: caret }, priority: 100 };
    }
  }

  return null;
}

export function getLocalAutocompleteItems(session: AutocompleteSession, data: AutocompleteLocalData = {}): readonly AutocompleteItem[] {
  switch (session.kind) {
    case 'mention':
      return mentionItems(session, data);
    case 'date':
      return dateItems(session, data, false);
    case 'reminder':
      return dateItems(session, data, true);
    case 'page-link':
      return pageItems(session, data, 'link-first');
    case 'page-create':
      return pageItems(session, data, 'create-first');
    case 'equation':
      return equationItems(session);
    case 'link':
      return linkItems(session);
  }
}

function mentionItems(session: AutocompleteSession, data: AutocompleteLocalData): readonly AutocompleteItem[] {
  const query = foldForSearch(session.query);
  const people = (data.people ?? [])
    .map(person => itemScore(person.name, query, 90, {
      id: `person:${person.id}`,
      kind: 'mention' as const,
      title: person.name,
      ...(person.subtitle ? { subtitle: person.subtitle } : {}),
      command: { commandId: 'inline.insert.mention', source: 'autocomplete', args: { kind: 'user', id: person.id, replace: session.range } }
    }))
    .filter(isItem);
  const pages = (data.pages ?? [])
    .map(page => itemScore(page.title, query, 70, {
      id: `page:${page.id}`,
      kind: 'mention' as const,
      title: page.title,
      subtitle: page.kind ?? 'page',
      command: { commandId: 'inline.insert.mention', source: 'autocomplete', args: { kind: page.kind ?? 'page', id: page.id, replace: session.range } }
    }))
    .filter(isItem);
  return [...dateItems(session, data, false), ...people, ...pages].sort(sortItems);
}

function dateItems(session: AutocompleteSession, data: AutocompleteLocalData, reminder: boolean): readonly AutocompleteItem[] {
  const query = foldForSearch(session.query.replace(/^remind\s*/u, ''));
  const parsed = dateCandidateFromQuery(query, data.now ?? new Date()) ?? { isoDate: toIsoDate(data.now ?? new Date()), label: 'Today' };
  const title = reminder ? `Remind ${parsed.label}` : parsed.label;
  return [{
    id: `${reminder ? 'reminder' : 'date'}:${parsed.isoDate}`,
    kind: reminder ? 'reminder' : 'date',
    title,
    subtitle: parsed.isoDate,
    score: 130,
    command: { commandId: reminder ? 'inline.insert.reminder' : 'inline.insert.date', source: 'autocomplete', args: { date: parsed.isoDate, replace: session.range, reminder } }
  }];
}

function pageItems(session: AutocompleteSession, data: AutocompleteLocalData, order: 'link-first' | 'create-first'): readonly AutocompleteItem[] {
  const query = foldForSearch(session.query);
  const existing = (data.pages ?? [])
    .map(page => itemScore(page.title, query, order === 'link-first' ? 110 : 0, {
      id: `link:${page.id}`,
      kind: 'page-link' as const,
      title: page.title,
      subtitle: 'Link page',
      command: { commandId: 'inline.insert.page_link', source: 'autocomplete', args: { pageId: page.id, replace: session.range } }
    }))
    .filter(isItem);
  const label = session.query.trim().length > 0 ? session.query.trim() : 'Untitled';
  const create: AutocompleteItem[] = [
    { id: `create-subpage:${label}`, kind: 'page-create', title: `Add sub-page "${label}"`, subtitle: 'Create below this page', score: order === 'create-first' ? 240 : 55, command: { commandId: 'page.create_subpage', source: 'autocomplete', args: { title: label, replace: session.range } } },
    { id: `create-page:${label}`, kind: 'page-create', title: `Add new page "${label}"`, subtitle: 'Create in workspace', score: order === 'create-first' ? 235 : 50, command: { commandId: 'page.create', source: 'autocomplete', args: { title: label, replace: session.range } } }
  ];
  return order === 'link-first' ? [...existing, ...create].sort(sortItems) : [...create, ...existing].sort(sortItems);
}

function equationItems(session: AutocompleteSession): readonly AutocompleteItem[] {
  const expression = session.query.trim();
  return [
    { id: 'equation:inline', kind: 'equation', title: 'Inline equation', subtitle: expression || 'Insert TeX inline', score: 120, command: { commandId: 'inline.insert.equation', source: 'autocomplete', args: { expression, replace: session.range } } },
    { id: 'equation:block', kind: 'equation', title: 'Equation block', subtitle: expression || 'Insert TeX block', score: 100, command: { commandId: 'block.insert.equation', source: 'autocomplete', args: { expression, replace: session.range } } }
  ];
}

function linkItems(session: AutocompleteSession): readonly AutocompleteItem[] {
  const url = ensureUrl(session.query);
  return [
    { id: `link:${url}`, kind: 'link', title: 'Create link', subtitle: url, score: 100, command: { commandId: 'inline.insert.link', source: 'autocomplete', args: { url, replace: session.range } } },
    { id: `bookmark:${url}`, kind: 'link', title: 'Paste as bookmark', subtitle: url, score: 80, command: { commandId: 'embed.insert.bookmark', source: 'autocomplete', args: { url, replace: session.range } } }
  ];
}

function itemScore<T extends Omit<AutocompleteItem, 'score'>>(title: string, query: string, boost: number, item: T): AutocompleteItem | null {
  if (query.length === 0) return { ...item, score: boost };
  const folded = foldForSearch(title);
  const score = folded === query ? 130 : folded.startsWith(query) ? 105 : folded.includes(query) ? 75 : Number.NEGATIVE_INFINITY;
  return Number.isFinite(score) ? { ...item, score: score + boost } : null;
}

function isItem(value: AutocompleteItem | null): value is AutocompleteItem {
  return value !== null;
}

function sortItems(a: AutocompleteItem, b: AutocompleteItem): number {
  return b.score - a.score || a.title.localeCompare(b.title);
}

function findUrlAtEnd(before: string): { start: number; text: string } | null {
  const match = before.match(/(?:^|\s)((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:[:/?#][^\s]*)?)$/iu);
  if (!match || match.index === undefined) return null;
  const text = match[1] ?? '';
  if (!isProbablyUrl(text)) return null;
  return { start: match.index + match[0].lastIndexOf(text), text };
}

function dateCandidateFromQuery(query: string, now: Date): { isoDate: string; label: string } | null {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const folded = foldForSearch(query);
  if (folded.length === 0 || folded === 'today') return { isoDate: toIsoDate(day), label: 'Today' };
  if (folded === 'tomorrow') return { isoDate: toIsoDate(addDays(day, 1)), label: 'Tomorrow' };
  if (folded === 'yesterday') return { isoDate: toIsoDate(addDays(day, -1)), label: 'Yesterday' };
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(folded.replace(/^next\s+/u, ''));
  if (weekday >= 0) {
    const current = day.getUTCDay();
    const distance = (weekday - current + 7) % 7 || 7;
    return { isoDate: toIsoDate(addDays(day, distance)), label: `Next ${titleCase(folded.replace(/^next\s+/u, ''))}` };
  }
  const iso = folded.match(/^\d{4}-\d{2}-\d{2}$/u);
  if (iso) return { isoDate: folded, label: folded };
  return null;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
