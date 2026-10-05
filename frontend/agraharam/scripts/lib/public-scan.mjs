/**
 * Pure building blocks of the public-repo leak checks (§11.1), shared by `check-public.mjs`, `postbuild.mjs` and
 * the Vitest suites. No file system, git or process access lives here: callers pass parsed documents and file
 * contents in, and get forbidden sets and hits back.
 *
 * Two checks are built from these pieces:
 * - the forbidden set: every real entity ID found in the private `.dashboard-local/**\/*.json` files (keys and
 *   values, recursively), prose substrings with a known entity domain, bare compound object IDs and private
 *   denylist literals, minus the reviewed exemptions; public files must contain none of them;
 * - the public-literal check: every entity-ID-shaped literal in src (production code included), tests, e2e and
 *   install files, and in the built bundle, must be a fictional `*.demo_*` ID, a reviewed exemption or a §7.1
 *   catalog identifier (the caller passes `CATALOG_LITERALS` from `catalog-literals.mjs`, so this module needs no
 *   TypeScript beyond `entity-id.ts`). It needs no private files, so it also protects a machine without
 *   `.dashboard-local/`, including CI (§17.7).
 *
 * Hits carry a position and a rule, never the matched text: printing the value would leak it into terminals,
 * CI logs and transcripts.
 */
import { isValidEntityId } from '../../src/config/entity-id.ts';

/**
 * Core's entity platforms plus the helper and integration-owned entity domains (§16.10). Shared by rule 2 of the
 * forbidden set (prose substrings) and by the public-literal check, so both agree on what "looks like an entity ID".
 * Over-inclusion only makes the checks stricter.
 */
export const KNOWN_ENTITY_DOMAINS = Object.freeze(
  new Set([
    // Core entity platforms (homeassistant.const.Platform).
    'ai_task',
    'air_quality',
    'alarm_control_panel',
    'assist_satellite',
    'binary_sensor',
    'button',
    'calendar',
    'camera',
    'climate',
    'conversation',
    'cover',
    'date',
    'datetime',
    'device_tracker',
    'event',
    'fan',
    'geo_location',
    'humidifier',
    'image',
    'image_processing',
    'infrared',
    'lawn_mower',
    'light',
    'lock',
    'media_player',
    'notify',
    'number',
    'remote',
    'scene',
    'select',
    'sensor',
    'siren',
    'stt',
    'switch',
    'text',
    'time',
    'todo',
    'tts',
    'update',
    'vacuum',
    'valve',
    'wake_word',
    'water_heater',
    'weather',
    // Helpers and integrations that own their entity domain.
    'alert',
    'automation',
    'counter',
    'group',
    'input_boolean',
    'input_button',
    'input_datetime',
    'input_number',
    'input_select',
    'input_text',
    'person',
    'plant',
    'proximity',
    'schedule',
    'script',
    'sun',
    'tag',
    'timer',
    'zone',
  ]),
);

/**
 * Object parts that make a `domain.object` token a file name rather than an entity ID (`camera.ts`, `time.ts`,
 * `calendar.ts` are real source files). Applied only to prose and literal substrings; a whole private JSON string
 * value is still collected whatever its suffix.
 */
export const FILE_EXTENSIONS = Object.freeze(
  new Set([
    'cjs',
    'css',
    'csv',
    'gif',
    'htm',
    'html',
    'jpeg',
    'jpg',
    'js',
    'json',
    'jsx',
    'log',
    'map',
    'md',
    'mjs',
    'mts',
    'otf',
    'pem',
    'png',
    'py',
    'scss',
    'sh',
    'svg',
    'toml',
    'ts',
    'tsx',
    'ttf',
    'txt',
    'webp',
    'woff',
    'woff2',
    'xml',
    'yaml',
    'yml',
  ]),
);

/** Rule 3: bare object IDs shorter than this are matched only in full `domain.object` form. */
export const MIN_BARE_OBJECT_ID_LENGTH = 8;

/** Fictional fixture IDs use this object-ID prefix (§10.1). */
export const DEMO_OBJECT_PREFIX = 'demo_';

/**
 * Type-and-class or class-chain selectors in the card's Lit `css` templates (and so in the bundle's string literals)
 * that look like entity IDs: `button.tile`, `button.body`, `.text.short` and `.time.now`. They are allowed by exact
 * value only, never by context: `button`, `text` and `time` are real entity domains, so a rule such as "followed by
 * a `{`" would also let a real ID through in YAML, a comment or a test name. A new selector of this shape fails the
 * check until it is added here (or renamed). This list does not touch the private forbidden set, which still
 * catches these values if a household ever uses them.
 */
export const CSS_SELECTOR_LITERALS = new Set(['button.body', 'button.tile', 'text.short', 'time.now']);

/** Package-relative directories whose entity-ID-shaped literals must be fictional (§11.1, all of src since §17.7). */
export const PUBLIC_LITERAL_SCOPES = Object.freeze(['src/', 'tests/', 'e2e/', 'install/']);

/** Extensions lexed as JavaScript/TypeScript: only their string literals and comments are literals. */
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);

/** A file with a NUL byte in its first block is scanned as latin1 text, so IDs in binary metadata are still found. */
const BINARY_SNIFF_BYTES = 8000;

/** Maximal runs of identifier characters and dots; entity IDs are adjacent dot-separated pairs inside a run. */
const DOTTED_RUN_RE = /[A-Za-z0-9_.]+/g;

/**
 * @typedef {{ readonly entityIds: ReadonlySet<string>, readonly objectIds: ReadonlySet<string>,
 *             readonly serviceNames: ReadonlySet<string> }} Exemptions
 * @typedef {{ readonly entityIds: ReadonlySet<string>, readonly objectIds: ReadonlySet<string>,
 *             readonly denylist: RegExp | null, readonly denylistSize: number }} ForbiddenSet
 * @typedef {{ readonly line: number, readonly column: number, readonly rule: string }} Hit
 * @typedef {{ readonly path: string, readonly line: number, readonly column: number, readonly rule: string }} FileHit
 */

/** Thrown when an exemptions document does not have the reviewed shape. */
export class ExemptionsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ExemptionsError';
  }
}

/**
 * Validates and freezes the parsed `public-exemptions.json`.
 * @param {unknown} data
 * @returns {Exemptions}
 */
export function parseExemptions(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ExemptionsError('public-exemptions.json must be an object with entity_ids, object_ids, service_names.');
  }
  const record = /** @type {Record<string, unknown>} */ (data);
  const allowed = ['entity_ids', 'object_ids', 'service_names'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ExemptionsError(`public-exemptions.json: unknown key "${key}".`);
  }
  /** @param {string} key */
  const stringSet = (key) => {
    const value = record[key] ?? [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new ExemptionsError(`public-exemptions.json: ${key} must be an array of non-empty strings.`);
    }
    return Object.freeze(new Set(value));
  };
  return Object.freeze({
    entityIds: stringSet('entity_ids'),
    objectIds: stringSet('object_ids'),
    serviceNames: stringSet('service_names'),
  });
}

/**
 * Builds the forbidden set from parsed private documents (§11.1 rules 1 to 5).
 * @param {{ documents: readonly unknown[], denylist?: readonly string[] }} privateFiles
 * @param {Exemptions} exemptions
 * @returns {ForbiddenSet}
 */
export function buildForbiddenSet(privateFiles, exemptions) {
  /** @type {Set<string>} */
  const collected = new Set();
  for (const document of privateFiles.documents) collectEntityIds(document, collected);

  /** @type {Set<string>} */
  const entityIds = new Set();
  /** @type {Set<string>} */
  const objectIds = new Set();
  for (const id of collected) {
    const object = id.slice(id.indexOf('.') + 1);
    // Rule 5 before rule 3: a service-registry string such as light.turn_off must forbid neither itself nor
    // turn_off, or every catalog service would become unusable in public code.
    if (exemptions.serviceNames.has(object)) continue;
    if (!exemptions.entityIds.has(id)) entityIds.add(id);
    if (isCompoundObjectId(object) && !exemptions.objectIds.has(object)) objectIds.add(object);
  }
  const literals = [...new Set((privateFiles.denylist ?? []).map((line) => line.trim()).filter(Boolean))];
  return Object.freeze({
    entityIds: Object.freeze(entityIds),
    objectIds: Object.freeze(objectIds),
    denylist: literals.length > 0 ? denylistPattern(literals) : null,
    denylistSize: literals.length,
  });
}

/**
 * Rules 1 and 2: walks a parsed JSON value recursively. Every key and string value that is itself an entity ID is
 * collected; inside longer strings, substrings shaped like an entity ID with a known domain are collected too.
 * @param {unknown} value
 * @param {Set<string>} into
 */
function collectEntityIds(value, into) {
  if (typeof value === 'string') {
    collectFromString(value, into);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEntityIds(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      collectFromString(key, into);
      collectEntityIds(item, into);
    }
  }
}

/**
 * @param {string} text
 * @param {Set<string>} into
 */
function collectFromString(text, into) {
  // A domain that starts with a digit is never an entity platform; skipping it keeps numbers such as "1.5" out of
  // the set, where they would fire on every CSS line height.
  if (isValidEntityId(text) && /^[a-z]/.test(text)) into.add(text);
  for (const id of dottedPairs(text)) {
    if (isProseEntityId(id)) into.add(id);
  }
}

/**
 * @param {string} id
 * @returns {boolean} true for a valid entity ID with a known domain whose object is not a file extension
 */
function isProseEntityId(id) {
  if (!isValidEntityId(id)) return false;
  const dot = id.indexOf('.');
  return KNOWN_ENTITY_DOMAINS.has(id.slice(0, dot)) && !FILE_EXTENSIONS.has(id.slice(dot + 1));
}

/**
 * Rule 3: only compound object IDs (an underscore or a digit) are matched on their own; a single dictionary word
 * would fire on ordinary prose.
 * @param {string} object
 */
function isCompoundObjectId(object) {
  return object.length >= MIN_BARE_OBJECT_ID_LENGTH && /[_\d]/.test(object);
}

/**
 * Rule 4: denylist literals, case-insensitive, bounded by non-word characters; inner spaces match any whitespace
 * run so a phrase broken across lines is still found.
 * @param {readonly string[]} literals
 */
function denylistPattern(literals) {
  const alternatives = literals
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((literal) => literal.split(/\s+/).map(escapeRegExp).join('\\s+'));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/**
 * Yields every adjacent `a.b` pair of non-empty segments inside the dotted runs of `text` (rule 2).
 * `binary_sensor.demo_x` is one pair; `states.light.demo_x` yields `states.light` and `light.demo_x`.
 * @param {string} text
 * @returns {Generator<string>}
 */
function* dottedPairs(text) {
  for (const run of text.matchAll(DOTTED_RUN_RE)) {
    const segments = run[0].split('.');
    for (let index = 0; index < segments.length - 1; index += 1) {
      const domain = segments[index];
      const object = segments[index + 1];
      if (domain && object) yield `${domain}.${object}`;
    }
  }
}

/**
 * Decodes file bytes for scanning: UTF-8 for text, latin1 for binary files so every byte maps to one character.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeForScan(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isBinary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  return buffer.toString(isBinary ? 'latin1' : 'utf8');
}

/**
 * Finds forbidden entity IDs, bare object IDs and denylist literals in one file's text. Linear in the text size:
 * the text is tokenized once and tokens are looked up in Sets, whatever the size of the forbidden set.
 * @param {string} text
 * @param {ForbiddenSet} forbidden
 * @returns {Hit[]}
 */
export function scanForForbidden(text, forbidden) {
  const locate = lineLocator(text);
  /** @type {Hit[]} */
  const hits = [];
  for (const run of text.matchAll(DOTTED_RUN_RE)) {
    const segments = run[0].toLowerCase().split('.');
    let offset = run.index ?? 0;
    /** The object segment of a full entity-ID hit is not reported a second time as a bare object ID. */
    let reportedObjectIndex = -1;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = /** @type {string} */ (segments[index]);
      const next = segments[index + 1];
      if (segment && next && forbidden.entityIds.has(`${segment}.${next}`)) {
        hits.push({ ...locate(offset), rule: 'entity-id' });
        reportedObjectIndex = index + 1;
      }
      if (segment && index !== reportedObjectIndex && forbidden.objectIds.has(segment)) {
        hits.push({ ...locate(offset), rule: 'object-id' });
      }
      offset += segment.length + 1;
    }
  }
  if (forbidden.denylist) {
    for (const match of text.matchAll(forbidden.denylist)) {
      hits.push({ ...locate(match.index ?? 0), rule: 'denylist' });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Returns a function mapping a character offset to its 1-based line and column.
 * @param {string} text
 * @returns {(offset: number) => { line: number, column: number }}
 */
export function lineLocator(text) {
  const lineStarts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (/** @type {number} */ (lineStarts[middle]) <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - /** @type {number} */ (lineStarts[low]) + 1 };
  };
}

/**
 * Formats a hit for output: position and rule only, never the matched value.
 * @param {string} label path (and optional source tag) of the scanned content
 * @param {Hit} hit
 */
export function formatHit(label, hit) {
  return `${label}:${hit.line}:${hit.column} ${hit.rule}`;
}

/**
 * @param {string} packagePath package-relative path with forward slashes
 * @returns {boolean} true when the file's entity-ID-shaped literals must be fictional
 */
export function isPublicLiteralScope(packagePath) {
  return PUBLIC_LITERAL_SCOPES.some((scope) => packagePath.startsWith(scope));
}

/**
 * The positive public-literal check (§11.1, §17.7). For script files only string literals and comments count as
 * literals (a property access such as `event.target` is code); every other file is prose or data throughout. The
 * exact CSS selectors in `CSS_SELECTOR_LITERALS` are allowed anywhere.
 * @param {{ files: readonly { path: string, text: string }[], exemptions: Exemptions,
 *           catalogLiterals: readonly string[] }} input `catalogLiterals` holds the §7.1 catalog's
 *   `domain.service` pairs and action kinds (`CATALOG_LITERALS` from catalog-literals.mjs)
 * @returns {FileHit[]}
 */
export function checkPublicLiterals({ files, exemptions, catalogLiterals }) {
  const catalog = new Set(catalogLiterals);
  /** @type {FileHit[]} */
  const hits = [];
  for (const { path, text } of files) {
    const locate = lineLocator(text);
    /** @type {LiteralRegion[]} */
    const regions = isScriptFile(path) ? literalRegions(text) : [[0, text.length, false]];
    for (const [start, end, isSelector] of regions) {
      for (const [from, to] of isSelector ? attributeSelectorRanges(text, start, end) : [[start, end]]) {
        for (const token of entityIdTokens(text, from, to)) {
          if (!isProseEntityId(token.id) || CSS_SELECTOR_LITERALS.has(token.id)) continue;
          const object = token.id.slice(token.id.indexOf('.') + 1);
          if (isFictionalObjectId(object) || exemptions.entityIds.has(token.id) || catalog.has(token.id)) continue;
          hits.push({ path, ...locate(token.offset), rule: 'public-literal' });
        }
      }
    }
  }
  return hits;
}

/**
 * The bracketed attribute selectors (`[data-entity="…"]`) of a CSS selector literal in `text[start, end)`.
 * Outside brackets a `domain.object` token is a tag and a class (`button.close`), never an entity ID; inside them
 * it is data and is still checked, so a real ID in an attribute value cannot hide in a selector.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {Generator<[number, number]>}
 */
function* attributeSelectorRanges(text, start, end) {
  let open = -1;
  for (let index = start; index < end; index += 1) {
    if (text[index] === '[' && open === -1) {
      open = index + 1;
    } else if (text[index] === ']' && open !== -1) {
      yield [open, index];
      open = -1;
    }
  }
  if (open !== -1) yield [open, end];
}

/**
 * Fictional fixture IDs (§10.1): `demo_…`, or the bare `demo` that invalid-ID tables use.
 * @param {string} object
 */
function isFictionalObjectId(object) {
  return object === 'demo' || object.startsWith(DEMO_OBJECT_PREFIX);
}

/** A character that continues a word beyond the ASCII run, so the run is not a standalone token. */
const WORD_CONTINUATION_RE = /[-\p{L}\p{N}]/u;

/**
 * Standalone entity-ID-shaped tokens of `text[start, end)`: a dotted run with exactly one inner dot (trailing
 * sentence dots ignored), not glued to a hyphen or a non-ASCII letter. `light.a.b`, `light.demo-x` and
 * `light.démo` are therefore not tokens, while `see light.demo_x.` is.
 *
 * Trade-off: skipping multi-dot runs and hyphen-glued runs keeps invalid-ID test tables, file names, CSS class
 * chains and dotted property paths (`states.light.x`) out of this positive check, which would otherwise need an
 * exemption for each. It also narrows it: a real ID written as `light.x.y` or `light.x-y` is not a token here.
 * The forbidden-set scan (`scanForForbidden`) has no such limit (it matches every adjacent dotted pair and every
 * bare compound object ID), so wherever the private files exist those spellings are still caught.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {Generator<{ id: string, offset: number }>}
 */
function* entityIdTokens(text, start, end) {
  const region = text.slice(start, end);
  for (const run of region.matchAll(DOTTED_RUN_RE)) {
    const raw = run[0];
    const leading = raw.length - raw.replace(/^\.+/, '').length;
    const id = raw.replace(/^\.+|\.+$/g, '');
    if (id.split('.').length !== 2) continue;
    const offset = start + (run.index ?? 0);
    const before = text[offset - 1] ?? '';
    const after = text[offset + raw.length] ?? '';
    if (WORD_CONTINUATION_RE.test(before) || WORD_CONTINUATION_RE.test(after)) continue;
    yield { id, offset: offset + leading };
  }
}

/** @param {string} path */
function isScriptFile(path) {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && SCRIPT_EXTENSIONS.has(path.slice(dot));
}

/** Keywords after which a `/` starts a regular expression literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

/**
 * Calls whose string arguments are CSS selectors: DOM queries, Playwright locators and the tests' shadow-piercing
 * `deepQuery` helpers. In a selector, `button.close` is a tag and a class, never an entity ID.
 */
const SELECTOR_CALLS = new Set([
  'closest',
  'deepQuery',
  'deepQueryAll',
  'locator',
  'matches',
  'querySelector',
  'querySelectorAll',
  'waitForSelector',
]);

/**
 * `[start, end, isSelector]`: a literal's [start, end) offsets, and whether it is a direct string argument of a
 * `SELECTOR_CALLS` call.
 * @typedef {[number, number, boolean]} LiteralRegion
 */

/**
 * Returns the regions of string-literal contents (including template text, excluding `${…}` expressions) and
 * comments in JavaScript/TypeScript source. A small lexer, not a parser: regular expression literals are
 * recognized by the previous significant token, which is exact for the code style used here.
 * @param {string} source
 * @returns {LiteralRegion[]}
 */
export function literalRegions(source) {
  /** @type {LiteralRegion[]} */
  const regions = [];
  /**
   * Brace depth at which each open `${` resumes its template literal, and whether that template is a selector.
   * @type {Array<{ depth: number, isSelector: boolean }>}
   */
  const templateResume = [];
  /**
   * One entry per open `(`: true when it opened the argument list of a selector call.
   * @type {boolean[]}
   */
  const parenIsSelectorCall = [];
  /** A selector call name was just read; its `(` may follow after TypeScript type arguments (`<HTMLElement>`). */
  let pendingSelectorCall = false;
  let typeArgumentDepth = 0;
  let braceDepth = 0;
  let previous = '';
  let index = 0;
  const length = source.length;
  const inSelectorArguments = () => parenIsSelectorCall.at(-1) === true;

  /** Scans template text from `start` until the closing backtick or a `${`, recording the text region. */
  const scanTemplate = (/** @type {number} */ start, /** @type {boolean} */ isSelector) => {
    let cursor = start;
    while (cursor < length) {
      const char = source[cursor];
      if (char === '\\') {
        cursor += 2;
      } else if (char === '`') {
        regions.push([start, cursor, isSelector]);
        return cursor + 1;
      } else if (char === '$' && source[cursor + 1] === '{') {
        regions.push([start, cursor, isSelector]);
        templateResume.push({ depth: braceDepth, isSelector });
        braceDepth += 1;
        return cursor + 2;
      } else {
        cursor += 1;
      }
    }
    regions.push([start, length, isSelector]);
    return length;
  };

  while (index < length) {
    const char = /** @type {string} */ (source[index]);
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? length : end;
      regions.push([index + 2, stop, false]);
      index = stop;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? length : end;
      regions.push([index + 2, stop, false]);
      index = stop + 2;
    } else if (char === "'" || char === '"') {
      let cursor = index + 1;
      while (cursor < length && source[cursor] !== char && source[cursor] !== '\n') {
        cursor += source[cursor] === '\\' ? 2 : 1;
      }
      regions.push([index + 1, Math.min(cursor, length), inSelectorArguments()]);
      index = cursor + 1;
      previous = 'literal';
      pendingSelectorCall = false;
    } else if (char === '`') {
      index = scanTemplate(index + 1, inSelectorArguments());
      previous = 'literal';
      pendingSelectorCall = false;
    } else if (char === '}' && templateResume.length > 0 && templateResume.at(-1)?.depth === braceDepth - 1) {
      const { isSelector } = /** @type {{ isSelector: boolean }} */ (templateResume.pop());
      braceDepth -= 1;
      index = scanTemplate(index + 1, isSelector);
      previous = 'literal';
    } else if (char === '/' && startsRegex(previous)) {
      index = skipRegexLiteral(source, index);
      previous = 'literal';
      pendingSelectorCall = false;
    } else if (/[A-Za-z0-9_$]/.test(char)) {
      let cursor = index + 1;
      while (cursor < length && /[A-Za-z0-9_$]/.test(/** @type {string} */ (source[cursor]))) cursor += 1;
      previous = source.slice(index, cursor);
      if (typeArgumentDepth === 0) pendingSelectorCall = SELECTOR_CALLS.has(previous);
      index = cursor;
    } else {
      if (char === '{') braceDepth += 1;
      else if (char === '}') braceDepth -= 1;
      if (char === '<' && (pendingSelectorCall || typeArgumentDepth > 0)) {
        typeArgumentDepth += 1;
      } else if (char === '>' && typeArgumentDepth > 0) {
        typeArgumentDepth -= 1;
      } else if (char === '(') {
        parenIsSelectorCall.push(pendingSelectorCall && typeArgumentDepth === 0);
        pendingSelectorCall = false;
        typeArgumentDepth = 0;
      } else if (char === ')') {
        parenIsSelectorCall.pop();
      }
      if (!/\s/.test(char) && typeArgumentDepth === 0 && char !== '>' && char !== '(') pendingSelectorCall = false;
      if (!/\s/.test(char)) previous = char;
      index += 1;
    }
  }
  return regions;
}

/**
 * @param {string} previous the previous significant token: '', a punctuator, a word, or 'literal'
 */
function startsRegex(previous) {
  if (previous === '') return true;
  if (previous === 'literal') return false;
  if (/^[A-Za-z0-9_$]/.test(previous)) return REGEX_PRECEDING_KEYWORDS.has(previous);
  return !/[)\]}]/.test(previous);
}

/**
 * @param {string} source
 * @param {number} start offset of the opening `/`
 * @returns {number} offset just past the closing `/` and flags
 */
function skipRegexLiteral(source, start) {
  let cursor = start + 1;
  let inClass = false;
  while (cursor < source.length && source[cursor] !== '\n') {
    const char = source[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) break;
    cursor += 1;
  }
  cursor += 1;
  while (cursor < source.length && /[a-z]/.test(/** @type {string} */ (source[cursor]))) cursor += 1;
  return cursor;
}
