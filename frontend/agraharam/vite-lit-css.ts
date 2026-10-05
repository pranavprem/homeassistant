/**
 * Build-only Vite plugin (§11.3): minifies the static text of Lit `css` tagged templates in src/, which no minifier
 * touches because it is template-literal content. Comments go and whitespace collapses; quoted strings, unquoted
 * `url(…)` bodies, every `${…}` interpolation and the space beside one are kept exactly, and every line break is
 * kept, so line numbers (and the source map, which this transform passes through unchanged) stay right. Rendering
 * is unchanged: only whitespace and comments that CSS ignores are removed, and a comment that was the only thing
 * between two tokens leaves an empty comment so the tokens never fuse. A run holding a custom property with an empty
 * value (`--x: ;`) is left untouched, because `--x:;` is invalid in browsers that follow the older spec.
 */
import ts from 'typescript';
import type { Plugin } from 'vite';

const SOURCE_FILE = /\/src\/.*\.ts$/;
/** Whitespace beside these never matters in CSS (`:` only after it: a space before one is a descendant combinator). */
const NO_SPACE_AROUND = new Set(['{', '}', ';', ',']);
const NO_SPACE_AFTER = new Set([...NO_SPACE_AROUND, ':']);
/** Left where a dropped comment was the only thing between two tokens that would otherwise fuse into one. */
const TOKEN_SEPARATOR = '/**/';
/** An unquoted `url(` (any case) not preceded by a name character: its body is one token, comments included. */
const URL_OPEN = /url\(/iy;
const NAME_CHAR = /[\w-]/;
/** A custom property whose value is only whitespace and comments: minifying could leave the invalid `--x:;`. */
const EMPTY_CUSTOM_PROPERTY = /--[\w-]+\s*:(?:\s|\/\*[\s\S]*?\*\/)*[;}]/;

export function litCssMinify(): Plugin {
  return {
    name: 'agraharam-lit-css-minify',
    apply: 'build',
    transform(code, id) {
      if (!SOURCE_FILE.test(id) || !code.includes('css`')) return null;
      const minified = minifyCssTemplates(code);
      // `map: null` keeps the incoming source map: no line moves, only text inside templates gets shorter.
      return minified === code ? null : { code: minified, map: null };
    },
  };
}

/**
 * Rewrites the static text of every `css\`…\`` tagged template in `code`; everything else is copied unchanged. The
 * templates are found by parsing, so a backtick in a comment, string or regular expression can never be mistaken for
 * one.
 */
export function minifyCssTemplates(code: string): string {
  const source = ts.createSourceFile('module.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: { readonly start: number; readonly end: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'css') {
      for (const literal of templateLiterals(node.template)) {
        // A literal's text sits between its delimiters: '`' or '}' before it, '${' or '`' after it.
        const closesWithInterpolation =
          literal.kind !== ts.SyntaxKind.TemplateTail && !ts.isNoSubstitutionTemplateLiteral(literal);
        edits.push({ start: literal.getStart(source) + 1, end: literal.end - (closesWithInterpolation ? 2 : 1) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = code;
  for (const { start, end } of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + minifyCssText(out.slice(start, end)) + out.slice(end);
  }
  return out;
}

function templateLiterals(template: ts.TemplateLiteral): ts.Node[] {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return [template];
  return [template.head, ...template.templateSpans.map((span) => span.literal)];
}

/** The index of the quote that closes the CSS string opened at `open` (the end of `text` if none does). */
function stringEnd(text: string, open: number): number {
  const quote = text.charAt(open);
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === '\\') at += 1;
    else if (char === quote) return at;
  }
  return text.length - 1;
}

/** The index just past the `)` that closes an unquoted url( body starting at `open` (the end of `text` if none). */
function urlEnd(text: string, open: number): number {
  const close = text.indexOf(')', open);
  return close === -1 ? text.length : close + 1;
}

/** Whether an unquoted `url(` starts at `at` (a quoted one is a function with a string, handled as a string). */
function isUnquotedUrl(text: string, at: number): boolean {
  URL_OPEN.lastIndex = at;
  if (!URL_OPEN.test(text) || (at > 0 && NAME_CHAR.test(text.charAt(at - 1)))) return false;
  const first = text
    .slice(at + 4)
    .trimStart()
    .charAt(0);
  return first !== "'" && first !== '"';
}

/**
 * What a dropped comment leaves: its line breaks, else nothing when whitespace or punctuation on either side already
 * separates the tokens, else an empty comment. Not a space: between `.a` and `.b` a space would turn a compound
 * selector into a descendant one. An edge of the run counts as unknown, because an interpolation may sit there.
 */
function commentReplacement(comment: string, before: string, next: string): string {
  const breaks = lineBreaks(comment);
  if (breaks !== '') return breaks;
  const previous = before.charAt(before.length - 1);
  const separated = (char: string) => char !== '' && (/\s/.test(char) || NO_SPACE_AFTER.has(char));
  return separated(previous) || separated(next) ? '' : TOKEN_SEPARATOR;
}

/**
 * One static run of CSS text. Comments are dropped (their line breaks kept), whitespace runs become one space or
 * their line breaks, and spaces beside `{ } ; ,` (and after `:`) go. The run's own edges keep a single space when
 * they had one, because an interpolation may sit right beside them (`solid ${color}`). A run with an empty custom
 * property value is returned unchanged.
 */
export function minifyCssText(text: string): string {
  if (EMPTY_CUSTOM_PROPERTY.test(text)) return text;
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === "'" || char === '"') {
      const end = stringEnd(text, at);
      out += text.slice(at, end + 1);
      at = end;
    } else if ((char === 'u' || char === 'U') && isUnquotedUrl(text, at)) {
      const end = urlEnd(text, at);
      out += text.slice(at, end);
      at = end - 1;
    } else if (char === '/' && text.charAt(at + 1) === '*') {
      const close = text.indexOf('*/', at + 2);
      const end = close === -1 ? text.length : close + 2;
      out += commentReplacement(text.slice(at, end), out, text.charAt(end));
      at = end - 1;
    } else if (/\s/.test(char)) {
      let end = at;
      while (end + 1 < text.length && /\s/.test(text.charAt(end + 1))) end += 1;
      out += collapsedSpace(text.slice(at, end + 1), out, text.charAt(end + 1), end + 1 === text.length);
      at = end;
    } else {
      // A space emitted before punctuation that never needs one is taken back.
      if (NO_SPACE_AROUND.has(char) && out.endsWith(' ')) out = out.slice(0, -1);
      out += char;
    }
  }
  return out;
}

/** What a whitespace run becomes: its line breaks, else one space, else nothing beside punctuation. */
function collapsedSpace(run: string, before: string, next: string, atEnd: boolean): string {
  const breaks = lineBreaks(run);
  if (breaks !== '') return breaks;
  const previous = before.charAt(before.length - 1);
  if (before === '' || atEnd) return previous !== '' && NO_SPACE_AFTER.has(previous) ? '' : ' ';
  // A space already emitted (before a dropped comment) or a line break separates as well as a second space would.
  if (previous === ' ' || previous === '\n' || NO_SPACE_AFTER.has(previous) || NO_SPACE_AROUND.has(next)) return '';
  return ' ';
}

function lineBreaks(text: string): string {
  return text.replace(/[^\n]/g, '');
}
