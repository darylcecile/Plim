export function foldForSearch(value: string): string {
  const normalized = typeof value.normalize === 'function' ? value.normalize('NFKD') : value;
  return normalized
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[\s_\-./]+/gu, ' ')
    .trim();
}

export function compactToken(value: string): string {
  return foldForSearch(value).replace(/\s+/gu, '');
}

export function tokenizeSearch(value: string): readonly string[] {
  const folded = foldForSearch(value);
  return folded.length === 0 ? [] : folded.split(/\s+/u);
}

export function fuzzyScore(candidate: string, query: string): number {
  const source = compactToken(candidate);
  const needle = compactToken(query);
  if (needle.length === 0) return 0;
  if (source === needle) return 120;
  if (source.startsWith(needle)) return 95 - Math.min(needle.length, 20) / 20;
  const index = source.indexOf(needle);
  if (index >= 0) return 75 - Math.min(index, 25);

  let score = 0;
  let sourceIndex = 0;
  let streak = 0;
  for (const char of needle) {
    const found = source.indexOf(char, sourceIndex);
    if (found < 0) return Number.NEGATIVE_INFINITY;
    streak = found === sourceIndex ? streak + 1 : 0;
    score += 8 + streak * 2 - Math.min(found - sourceIndex, 8);
    sourceIndex = found + 1;
  }
  return Math.max(1, score);
}

export function wordBoundaryScore(candidate: string, query: string): number {
  const sourceTokens = tokenizeSearch(candidate);
  const queryTokens = tokenizeSearch(query);
  if (queryTokens.length === 0) return 0;
  let total = 0;
  for (const queryToken of queryTokens) {
    const best = sourceTokens.reduce((current, token) => Math.max(current, fuzzyScore(token, queryToken)), Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(best)) return Number.NEGATIVE_INFINITY;
    total += best;
  }
  return total / queryTokens.length;
}

export function isProbablyUrl(value: string): boolean {
  const trimmed = value.trim();
  if (/^https?:\/\/[\w.-]+(?:[:/?#][^\s]*)?$/iu.test(trimmed)) return true;
  return /^[\w-]+(?:\.[\w-]+)+(?:[:/?#][^\s]*)?$/iu.test(trimmed);
}

export function ensureUrl(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function splitParagraphs(text: string): readonly string[] {
  const normalized = text.replace(/\r\n?/gu, '\n');
  return normalized.split(/\n{2,}/u).map(part => part.replace(/^\n+|\n+$/gu, '')).filter(part => part.length > 0);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
