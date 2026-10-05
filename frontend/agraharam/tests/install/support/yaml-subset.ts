/**
 * A strict reader for the YAML subset the install examples use: block mappings, block sequences (including a
 * mapping that starts on the `- ` line), plain, single- and double-quoted scalars, booleans, integers, `[]`/`{}`
 * and full-line or trailing comments. Anything else (tabs, anchors, flow collections with content, block scalars,
 * multi-document streams) throws, so an example can never be silently misread. Plain `on`/`off`/`yes`/`no` throw
 * too: YAML 1.1 parsers read them as booleans, so the examples must quote them.
 */

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

export class YamlSubsetError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'YamlSubsetError';
  }
}

const AMBIGUOUS_BOOLEANS = new Set(['on', 'off', 'yes', 'no', 'y', 'n', 'On', 'Off', 'Yes', 'No', 'ON', 'OFF']);

export function parseYamlSubset(source: string): unknown {
  const lines = toLines(source);
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, (lines[0] as Line).indent);
  if (next !== lines.length) throw new YamlSubsetError('unexpected content', lines[next]?.number);
  return value;
}

function toLines(source: string): Line[] {
  const lines: Line[] = [];
  source.split('\n').forEach((raw, index) => {
    if (raw.includes('\t')) throw new YamlSubsetError('tabs are not allowed', index + 1);
    const text = stripComment(raw).trimEnd();
    if (text.trim() === '') return;
    if (text.trim() === '---' || text.trim() === '...') throw new YamlSubsetError('documents markers', index + 1);
    lines.push({ indent: text.length - text.trimStart().length, text: text.trimStart(), number: index + 1 });
  });
  return lines;
}

/** Removes a comment: `#` at the start or after whitespace, outside quotes. */
function stripComment(raw: string): string {
  let quote: string | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(raw[index - 1] as string))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function isSequenceItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function parseBlock(lines: readonly Line[], start: number, indent: number): [unknown, number] {
  const first = lines[start] as Line;
  return isSequenceItem(first.text) ? parseSequence(lines, start, indent) : parseMapping(lines, start, indent);
}

function parseSequence(lines: readonly Line[], start: number, indent: number): [unknown[], number] {
  const items: unknown[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent !== indent || !isSequenceItem(line.text)) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trimStart();
    if (rest === '') {
      const child = lines[index + 1];
      if (!child || child.indent <= indent) throw new YamlSubsetError('empty sequence item', line.number);
      const [value, next] = parseBlock(lines, index + 1, child.indent);
      items.push(value);
      index = next;
    } else if (splitKey(rest) !== undefined) {
      // A mapping that starts on the "- " line continues at the column of its first key.
      const column = indent + (line.text.length - rest.length);
      const inline: Line = { indent: column, text: rest, number: line.number };
      const [value, next] = parseMapping([...lines.slice(0, index), inline, ...lines.slice(index + 1)], index, column);
      items.push(value);
      index = next;
    } else {
      items.push(parseScalar(rest, line.number));
      index += 1;
    }
  }
  return [items, index];
}

function parseMapping(lines: readonly Line[], start: number, indent: number): [Record<string, unknown>, number] {
  const mapping: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlSubsetError('unexpected indentation', line.number);
    if (isSequenceItem(line.text)) break;
    const pair = splitKey(line.text);
    if (!pair) throw new YamlSubsetError('expected "key: value"', line.number);
    const [key, rawValue] = pair;
    if (Object.hasOwn(mapping, key)) throw new YamlSubsetError(`duplicate key "${key}"`, line.number);
    if (rawValue !== '') {
      mapping[key] = parseScalar(rawValue, line.number);
      index += 1;
      continue;
    }
    const child = lines[index + 1];
    if (child && (child.indent > indent || (child.indent === indent && isSequenceItem(child.text)))) {
      const [value, next] = parseBlock(lines, index + 1, child.indent);
      mapping[key] = value;
      index = next;
    } else {
      mapping[key] = null;
      index += 1;
    }
  }
  return [mapping, index];
}

/** Splits `key: value` (plain keys only); undefined when the text is not a mapping entry. */
function splitKey(text: string): [string, string] | undefined {
  const match = /^([A-Za-z_][\w-]*):(?:\s+(.*)|)$/.exec(text);
  return match ? [match[1] as string, (match[2] ?? '').trim()] : undefined;
}

function parseScalar(text: string, line: number): unknown {
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlSubsetError('unterminated quote', line);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"')) return JSON.parse(text) as unknown;
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (/^[[{&*!|>%@`]/.test(text)) throw new YamlSubsetError(`unsupported YAML syntax "${text}"`, line);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (AMBIGUOUS_BOOLEANS.has(text)) throw new YamlSubsetError(`quote "${text}": YAML 1.1 reads it as a boolean`, line);
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/:\s/.test(text)) throw new YamlSubsetError('a plain scalar may not contain ": "', line);
  return text;
}
