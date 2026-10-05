/**
 * The build's Lit css minifier (vite-lit-css.ts, §11.3): it removes only whitespace and comments CSS ignores, keeps
 * strings, interpolations and the spaces beside them, keeps every line break, and touches nothing outside css
 * templates.
 */
import { describe, expect, it } from 'vitest';
import { minifyCssTemplates, minifyCssText } from '../../vite-lit-css.ts';

describe('minifyCssText', () => {
  it('drops comments and indentation, and spaces beside braces, semicolons, commas and after colons', () => {
    expect(minifyCssText('\n  /* why */\n  .a, .b {\n    color: red;\n    margin: 0 auto;\n  }\n')).toBe(
      '\n\n.a,.b{\ncolor:red;\nmargin:0 auto;\n}\n',
    );
  });

  it('keeps every line break, so line numbers never move', () => {
    const text = '\n  .a {\n    /* two\n       lines */\n    color: red;\n  }\n';
    expect(minifyCssText(text).split('\n')).toHaveLength(text.split('\n').length);
  });

  it('keeps a descendant space, a space before a colon and spaces in range queries', () => {
    expect(minifyCssText('.a .b :hover {}')).toBe('.a .b :hover{}');
    expect(minifyCssText('@container panel (width < 300px) {}')).toBe('@container panel (width < 300px){}');
  });

  it('copies quoted strings exactly, comment-like text and punctuation included', () => {
    expect(minifyCssText(`grid-template-areas: 'a  b' "c ,  d";\n  content: '/* no */';`)).toBe(
      `grid-template-areas:'a  b' "c ,  d";\ncontent:'/* no */';`,
    );
  });

  it('leaves an empty comment where a dropped comment was the only separator between two tokens', () => {
    expect(minifyCssText('margin: 0/* x */auto;')).toBe('margin:0/**/auto;');
    expect(minifyCssText('.a/* x */.b {}')).toBe('.a/**/.b{}');
    expect(minifyCssText('margin: 0 /* x */auto;')).toBe('margin:0 auto;');
    expect(minifyCssText('margin: 0/* x */ auto;')).toBe('margin:0 auto;');
    expect(minifyCssText('color: red;/* x */margin: 0;')).toBe('color:red;margin:0;');
    expect(minifyCssText('solid/* x */')).toBe('solid/**/');
  });

  it('copies an unquoted url() body exactly, comment-like text and spaces included', () => {
    expect(minifyCssText('background: url(data:image/svg+xml;utf8,a/*b*/c) no-repeat;')).toBe(
      'background:url(data:image/svg+xml;utf8,a/*b*/c) no-repeat;',
    );
    expect(minifyCssText('mask: URL( a/*.svg ) ;')).toBe('mask:URL( a/*.svg );');
    expect(minifyCssText("src: url('a /* b */.woff2');")).toBe("src:url('a /* b */.woff2');");
    expect(minifyCssText('--icon: myurl(a /* b */ c);')).toBe('--icon:myurl(a c);');
  });

  it('leaves a run holding an empty custom property untouched, so --x: ; never becomes --x:;', () => {
    for (const text of ['  --x: ;\n  color: red;', '.a { --x:  }', '--x: /* none */;', '--x:\t;']) {
      expect(minifyCssText(text)).toBe(text);
    }
    expect(minifyCssText('--x: 0;  color: red;')).toBe('--x:0;color:red;');
  });

  it('keeps one space at an edge where an interpolation may sit, unless punctuation makes it pointless', () => {
    expect(minifyCssText('  border: 1px solid ')).toBe(' border:1px solid ');
    expect(minifyCssText(' 12px;')).toBe(' 12px;');
    expect(minifyCssText('font: ')).toBe('font:');
    expect(minifyCssText(' {')).toBe('{');
  });
});

describe('minifyCssTemplates', () => {
  it('rewrites only css-tagged templates, around their interpolations, and nothing else', () => {
    const code = [
      'const a = css`',
      '  .x {',
      '    border: 1px solid ${color};',
      '    inset: ${unsafeCSS(`${gap}px`)} 0;',
      '  }',
      '`;',
      '// a comment mentioning css` and a stray backtick `',
      'const b = html`<p class="x">  keep  </p>`;',
      "const c = 'css`';",
    ].join('\n');
    expect(minifyCssTemplates(code)).toBe(
      [
        'const a = css`',
        '.x{',
        'border:1px solid ${color};',
        'inset:${unsafeCSS(`${gap}px`)} 0;',
        '}',
        '`;',
        '// a comment mentioning css` and a stray backtick `',
        'const b = html`<p class="x">  keep  </p>`;',
        "const c = 'css`';",
      ].join('\n'),
    );
  });

  it('leaves a module without css templates untouched', () => {
    const code = 'export const x = `  a  `;\n';
    expect(minifyCssTemplates(code)).toBe(code);
  });
});
