/**
 * Postbuild (§11.5, §17.2) on a temp package laid out like a fresh `vite build`: maps moved out, licenses copied
 * flat, the exact allowlist enforced, the legal banner, the privacy, browser-floor and public-literal scans, and a
 * reproducible manifest plus flat SHA256SUMS.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLE_SIZE_TARGET_BYTES } from '../../build-env.ts';
import { FontLicenseError, legalBanner } from '../../scripts/lib/font-licenses.mjs';
import { buildForbiddenSet, parseExemptions } from '../../scripts/lib/public-scan.mjs';
import { BUILT_FILES, postbuild, PostbuildError, scanBundleText, sizeLine } from '../../scripts/postbuild.mjs';
import {
  bundleText,
  CLEAN_BUNDLE,
  dataUrl,
  EMBEDDED_FONTS,
  FAKE_BUILD_INFO as BUILD,
  FAKE_FONT_FILES,
  layOutViteOutput as layOut,
  writeFile as write,
} from './support/fake-build.ts';

const VERSION = '9.9.9';
const NO_EXEMPTIONS = parseExemptions({});
/** The flat release directory: the four built files plus the manifest and checksums (§17.2). */
const RELEASE_FILES = [
  'OFL-1.1-Hanken-Grotesk.txt',
  'OFL-1.1-Newsreader.txt',
  'SHA256SUMS',
  'THIRD_PARTY_LICENSES.md',
  'agraharam.js',
  'manifest.json',
];
const SERIF_FONT_FILE = 'node_modules/@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2';
/** The embedded-font constants with these two payloads, as the minified fonts.ts writes them. */
const embeddedFonts = (...payloads: string[]) => `const ${payloads.map((p, i) => `f${i}="${p}"`).join(',')};\n`;

let packageDir: string;
let bundleDir: string;

function layOutViteOutput(bundle = CLEAN_BUNDLE, fonts = EMBEDDED_FONTS): void {
  layOut(packageDir, VERSION, bundle, fonts);
}

function run(forbidden: Parameters<typeof postbuild>[0]['forbidden'] = null) {
  return postbuild({ packageDir, version: VERSION, build: BUILD, nodeVersion: 'v24.0.0', forbidden });
}

/** Runs postbuild expecting failure and returns the issue rules. */
function failureRules(forbidden: Parameters<typeof postbuild>[0]['forbidden'] = null): string[] {
  try {
    run(forbidden);
  } catch (error) {
    expect(error).toBeInstanceOf(PostbuildError);
    return (error as PostbuildError).issues.map((issue) => `${issue.path} ${issue.rule}`);
  }
  throw new Error('postbuild unexpectedly succeeded');
}

beforeEach(() => {
  packageDir = realpathSync(mkdtempSync(join(tmpdir(), 'agr-postbuild-')));
  bundleDir = join(packageDir, 'dist/agraharam', VERSION);
});

afterEach(() => {
  rmSync(packageDir, { recursive: true, force: true });
});

describe('postbuild: the flat §17.2 directory', () => {
  it('moves source maps out, copies both OFL texts flat and writes the manifest and checksums', () => {
    layOutViteOutput();
    run();
    expect(existsSync(join(packageDir, 'dist/sourcemaps', VERSION, 'agraharam.js.map'))).toBe(true);
    expect(readdirSync(bundleDir).sort()).toEqual(RELEASE_FILES);
    expect(readFileSync(join(bundleDir, 'OFL-1.1-Newsreader.txt'), 'utf8')).toContain('Demoserif');
    expect(readFileSync(join(bundleDir, 'OFL-1.1-Hanken-Grotesk.txt'), 'utf8')).toContain('Demosans');

    const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
    expect(Object.keys(manifest)).toEqual([
      'name',
      'version',
      'git_sha',
      'git_dirty',
      'commit_time',
      'node',
      'entry',
      'files',
    ]);
    expect(manifest).toMatchObject({
      name: 'agraharam-dashboard',
      version: VERSION,
      git_sha: BUILD.gitSha,
      git_dirty: false,
      commit_time: BUILD.commitTime,
      node: 'v24.0.0',
      entry: 'agraharam.js',
    });
    expect(manifest).not.toHaveProperty('resource_url');
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([...BUILT_FILES]);
    const bundle = bundleText(packageDir);
    const entry = manifest.files.find((file: { path: string }) => file.path === 'agraharam.js');
    expect(entry).toEqual({
      path: 'agraharam.js',
      bytes: Buffer.byteLength(bundle),
      sha256: createHash('sha256').update(bundle).digest('hex'),
    });
  });

  it('writes flat SHA256SUMS for every file including the manifest, verifiable with the standard tool', () => {
    layOutViteOutput();
    run();
    const lines = readFileSync(join(bundleDir, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => line.slice(66))).toEqual(RELEASE_FILES.filter((file) => file !== 'SHA256SUMS'));
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64} {2}[^/\s]+$/);
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64} {2}\S+$/);
    const tool = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: bundleDir, encoding: 'utf8' });
    const fallback = tool.error
      ? spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: bundleDir, encoding: 'utf8' })
      : tool;
    expect(fallback.status).toBe(0);
  });

  it('is reproducible: a re-run over the same build writes identical bytes', () => {
    layOutViteOutput();
    run();
    const first = ['manifest.json', 'SHA256SUMS'].map((file) => readFileSync(join(bundleDir, file)));
    run();
    const second = ['manifest.json', 'SHA256SUMS'].map((file) => readFileSync(join(bundleDir, file)));
    expect(second[0]?.equals(first[0] as Buffer)).toBe(true);
    expect(second[1]?.equals(first[1] as Buffer)).toBe(true);
  });

  it('fails with an actionable message when the bundle is missing', () => {
    expect(() => run()).toThrow(/agraharam\.js is missing\. Run "vite build" first\./);
  });

  it.each([['../../outside'], ['9.9'], ['9.9.9/..'], ['']])(
    'refuses version %j before touching any path, so the source-map delete can never widen',
    (version) => {
      layOutViteOutput();
      // Unguarded, '../../outside' resolves both dist/agraharam/<version> and dist/sourcemaps/<version> to
      // <tmp>/outside, which holds an agraharam.js, so postbuild would then delete that directory recursively.
      const outside = join(packageDir, 'outside');
      write(join(outside, 'agraharam.js'), CLEAN_BUNDLE);
      expect(() => postbuild({ packageDir, version, build: BUILD, nodeVersion: 'v24.0.0', forbidden: null })).toThrow(
        /version must look like X\.Y\.Z/,
      );
      expect(readFileSync(join(outside, 'agraharam.js'), 'utf8')).toBe(CLEAN_BUNDLE);
      expect(existsSync(join(bundleDir, 'agraharam.js.map'))).toBe(true);
    },
  );

  it('requires THIRD_PARTY_LICENSES.md and the font package licenses', () => {
    layOutViteOutput();
    rmSync(join(bundleDir, 'THIRD_PARTY_LICENSES.md'));
    expect(() => run()).toThrow(/THIRD_PARTY_LICENSES\.md is missing/);
    layOutViteOutput();
    rmSync(join(packageDir, 'node_modules/@fontsource-variable/hanken-grotesk/LICENSE'));
    expect(() => run()).toThrow(/hanken-grotesk\/LICENSE is missing\. Run "npm ci"/);
  });

  it('requires THIRD_PARTY_LICENSES.md to list both font packages (their only package notice, §17.8)', () => {
    layOutViteOutput();
    write(join(bundleDir, 'THIRD_PARTY_LICENSES.md'), '# Licenses\n\n## @fontsource-variable/newsreader - 5.3.0\n');
    expect(() => run()).toThrow(/does not list @fontsource-variable\/hanken-grotesk/);
  });
});

describe('postbuild: allowlist', () => {
  it('refuses any file outside the flat allowlist, emitted font files and subdirectories included', () => {
    layOutViteOutput();
    write(join(bundleDir, 'index.html'), '<!doctype html>');
    write(join(bundleDir, 'assets/chunk.js'), 'export {};');
    write(join(bundleDir, 'fonts/newsreader-latin-opsz-normal-Ab12.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
    expect(failureRules()).toEqual([
      'assets/chunk.js not-allowlisted',
      'fonts/newsreader-latin-opsz-normal-Ab12.woff2 not-allowlisted',
      'index.html not-allowlisted',
    ]);
  });
});

describe('postbuild: legal banner (§17.2)', () => {
  it('requires the bundle to start with exactly the banner built from both font licenses', () => {
    layOutViteOutput();
    const banner = legalBanner(packageDir);
    expect(banner.startsWith('/*! ')).toBe(true);
    expect(banner.endsWith('*/')).toBe(true);
    expect(banner).toContain('Newsreader: Copyright 2020 The Demoserif Project Authors');
    expect(banner).toContain('Hanken Grotesk: Copyright 2020 The Demosans Project Authors');
    expect(banner).toContain('SIL Open Font License, Version 1.1');
    expect(banner).toContain('https://openfontlicense.org');
    expect(banner).toContain('OFL-1.1-Newsreader.txt and OFL-1.1-Hanken-Grotesk.txt');
    expect(banner).toContain('frontend/agraharam/');
    expect(banner.match(/Demoserif Project Authors \(/g), 'duplicate notices collapse').toHaveLength(1);
    run();
    expect(readFileSync(join(bundleDir, 'agraharam.js'), 'utf8').startsWith(`${banner}\n`)).toBe(true);
  });

  it('fails the build when a font license has no copyright notice to carry', () => {
    layOutViteOutput();
    write(join(packageDir, 'node_modules/@fontsource-variable/newsreader/LICENSE'), 'SIL Open Font License\n');
    expect(() => run()).toThrow(/newsreader\/LICENSE has no "Copyright … \(…\)" notice/);
  });

  it.each([
    ['a comment end', 'Copyright 2020 Demo */ alert(1) /* Authors (https://example.invalid/x)'],
    ['a non-ASCII character', 'Copyright © 2020 Demo Authors (https://example.invalid/x)'],
    ['a control character', 'Copyright 2020 Demo\tAuthors (https://example.invalid/x)'],
  ])('refuses a copyright notice with %s, which could break out of the banner', (_label, notice) => {
    layOutViteOutput();
    write(
      join(packageDir, 'node_modules/@fontsource-variable/hanken-grotesk/LICENSE'),
      `${notice}\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n`,
    );
    expect(() => legalBanner(packageDir)).toThrow(FontLicenseError);
    expect(() => legalBanner(packageDir)).toThrow(/hanken-grotesk\/LICENSE: .*cannot go into the bundle banner/);
    expect(() => run()).toThrow(FontLicenseError);
  });

  it('fails a bundle without the banner, or with a banner that is not first', () => {
    layOutViteOutput();
    write(join(bundleDir, 'agraharam.js'), CLEAN_BUNDLE);
    expect(failureRules()).toContain('agraharam.js legal-banner');
    layOutViteOutput();
    write(join(bundleDir, 'agraharam.js'), `export{};\n${bundleText(packageDir)}`);
    expect(failureRules()).toContain('agraharam.js legal-banner');
  });

  it('allows the notice URLs in the banner only', () => {
    const banner = '/*! Demo: Copyright 2020 Demo (https://example.invalid/demo) */';
    expect(scanBundleText(`${banner}\nexport{};`, { banner })).toEqual([]);
    expect(scanBundleText(`${banner}\nfetch("https://example.invalid/demo");`, { banner })).toEqual([
      { line: 2, column: 8, rule: 'external-url' },
    ]);
  });
});

describe('postbuild: privacy and safety scan', () => {
  it.each([
    ['a regex lookbehind', 'const r=/(?<=a)b/;', 'regex-lookbehind'],
    ['a negative lookbehind', 'const r=/(?<!a)b/;', 'regex-lookbehind'],
    ['toSorted', 'const s=list.toSorted();', 'es2023-array-copy'],
    ['toReversed', 'const s=list.toReversed();', 'es2023-array-copy'],
    ['toSpliced', 'const s=list.toSpliced(0,1);', 'es2023-array-copy'],
    ['a sourceMappingURL', '//# sourceMappingURL=agraharam.js.map', 'source-map-url'],
    ['a raw decorator', '@customElement("x")\nclass A{}', 'raw-decorator'],
    ['an external URL', 'fetch("https://cdn.example.invalid/x.js");', 'external-url'],
    ['an https w3.org URL', 'const n="https://www.w3.org/2000/svg";', 'external-url'],
    ['a bearer header', 'h.Authorization="Bearer "+t;', 'forbidden-literal'],
    ['a JWT prefix', 'const t="eyJhbGciOi";', 'forbidden-literal'],
    ['a LAN address', 'const u="10.0.0.5";', 'forbidden-literal'],
    ['the private directory name', 'const p=".dashboard-local/x";', 'forbidden-literal'],
    ['a dev-only name', 'class FakeHass{}', 'forbidden-literal'],
    ['the call recorder', 'window.__agrCalls=[];', 'forbidden-literal'],
    ['a signed path', 'const s="?authSig=1";', 'forbidden-literal'],
    ['an access token query', 'const s="?access_token=1";', 'forbidden-literal'],
  ])('fails the build on %s', (_label, planted, rule) => {
    layOutViteOutput(`${CLEAN_BUNDLE}${planted}\n`);
    expect(failureRules()).toContain(`agraharam.js ${rule}`);
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(false);
  });

  it('allows the SVG namespace URL', () => {
    expect(scanBundleText('const a="http://www.w3.org/2000/svg",b="http://www.w3.org/1999/xlink";')).toEqual([]);
  });

  it.each([
    ['the tracking-site prefix before a closing quote', 'const a="https://globe.adsb.lol/?icao="+h;'],
    ['the tracking-site prefix as the built bundle emits it', 'const Yj=`https://globe.adsb.lol/?icao=`;'],
    ['the positions source in single quotes', "const a='https://www.adsb.lol/';"],
    ['the routes source in a template literal', 'const a=`https://github.com/vradarserver/standing-data`;'],
  ])('allows %s as an exact literal (AIRSPACE.md §9)', (_label, text) => {
    expect(scanBundleText(text)).toEqual([]);
  });

  it.each([
    ['another path on an allowed host', 'const a="https://www.adsb.lol/api";'],
    ['the provider API host', 'const a="https://api.adsb.lol/";'],
    ['plain http', 'const a="http://www.adsb.lol/";'],
    ['a bare globe link', 'const a="https://globe.adsb.lol/";'],
    ['a position parameter', 'const a="https://globe.adsb.lol/?lat=1";'],
    ['a parameter after the address', 'const a="https://globe.adsb.lol/?icao=002a1b&lat=1";'],
    ['a template expression after the tracking prefix', 'const a=`https://globe.adsb.lol/?icao=${h}`;'],
    ['a parameter after a templated address', 'const a=`https://globe.adsb.lol/?icao=${h}&lat=1`;'],
    ['a template expression after a source link', 'const a=`https://www.adsb.lol/${p}`;'],
    ['a raw standing-data path', 'const a="https://github.com/vradarserver/standing-data/raw/main/x";'],
    ['a longer repository name', 'const a="https://github.com/vradarserver/standing-data-x";'],
  ])('still fails %s (AIRSPACE.md §9)', (_label, text) => {
    expect(scanBundleText(text).map((hit) => hit.rule)).toEqual(['external-url']);
  });

  it('reports positions and rules only, never the matched text', () => {
    expect(scanBundleText('x\n  y.toSorted()')).toEqual([{ line: 2, column: 4, rule: 'es2023-array-copy' }]);
  });

  it('fails on a planted forbidden ID from the private set, in the bundle and inside an embedded font', () => {
    const forbidden = buildForbiddenSet(
      { documents: [{ groups: { people: [{ entity_id: 'person.demo_planted_owner' }] } }] },
      NO_EXEMPTIONS,
    );
    const font = Buffer.concat([Buffer.from([0x77, 0x4f, 0x00]), Buffer.from('demo_planted_owner')]);
    layOutViteOutput(
      `${CLEAN_BUNDLE}const o="person.demo_planted_owner";\n`,
      embeddedFonts(dataUrl(font), dataUrl(FAKE_FONT_FILES.sans)),
    );
    write(join(packageDir, SERIF_FONT_FILE), font);
    const rules = failureRules(forbidden);
    expect(rules).toContain('agraharam.js entity-id');
    expect(rules).toContain('agraharam.js [embedded font 1] object-id');
    try {
      run(forbidden);
    } catch (error) {
      expect((error as Error).message).not.toContain('demo_planted_owner');
    }
  });

  it('fails a non-fictional entity ID among the bundle string literals (§17.7), allowing the four CSS selectors', () => {
    const realLooking = ['light', 'kitchen'].join('.');
    layOutViteOutput(`${CLEAN_BUNDLE}const c=\`button.tile{x:1}.time.now::before{y:2}\`,i="${realLooking}";\n`);
    const rules = failureRules();
    expect(rules).toEqual(['agraharam.js public-literal']);
  });

  it('passes demo IDs, exempted values and catalog services among the bundle string literals', () => {
    layOutViteOutput(
      `${CLEAN_BUNDLE}const a=["light.demo_lamp","sun.sun","cover.open_cover","light.set_brightness"];\n`,
    );
    expect(() => run()).not.toThrow();
  });

  it('passes a clean bundle against a forbidden set', () => {
    const forbidden = buildForbiddenSet({ documents: [['person.demo_planted_owner']] }, NO_EXEMPTIONS);
    layOutViteOutput();
    expect(() => run(forbidden)).not.toThrow();
  });
});

describe('postbuild: embedded data is exactly the two package fonts (§17.2)', () => {
  it('masks the verified font payloads only: their base64 may hold a forbidden literal by chance', () => {
    expect(dataUrl(FAKE_FONT_FILES.serif)).toContain('base64,eyJ');
    layOutViteOutput();
    expect(() => run()).not.toThrow();
  });

  it.each([
    ['an extra data:text/plain', `const t="${dataUrl(Buffer.from('demo text'), 'text/plain')}";`],
    ['a base64 data:text/javascript import', `import("${dataUrl(Buffer.from('export{}'), 'text/javascript')}");`],
    ['a plain data:text/javascript import', 'import("data:text/javascript,export const x=1");'],
    ['a data:image/jpeg', `const i="${dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg')}";`],
    ['a third copy of a package font', `const x="${dataUrl(FAKE_FONT_FILES.sans)}";`],
  ])('fails the build on %s', (_label, planted) => {
    layOutViteOutput(`${CLEAN_BUNDLE}${planted}\n`);
    expect(failureRules()).toContain('agraharam.js embedded-data');
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(false);
  });

  it.each([
    ['a font whose bytes differ from the package file', [dataUrl(Buffer.from('other')), dataUrl(FAKE_FONT_FILES.sans)]],
    ['a missing font', [dataUrl(FAKE_FONT_FILES.sans)]],
    ['the same font twice instead of both', [dataUrl(FAKE_FONT_FILES.sans), dataUrl(FAKE_FONT_FILES.sans)]],
    [
      'a font payload that is not the whole string',
      [`${dataUrl(FAKE_FONT_FILES.serif)}!x`, dataUrl(FAKE_FONT_FILES.sans)],
    ],
    ['a font under another MIME type', [dataUrl(FAKE_FONT_FILES.serif, 'font/woff'), dataUrl(FAKE_FONT_FILES.sans)]],
  ])('fails the build on %s', (_label, payloads) => {
    layOutViteOutput(CLEAN_BUNDLE, embeddedFonts(...payloads));
    expect(failureRules()).toContain('agraharam.js embedded-data');
  });

  it('still applies the text rules inside a rejected payload', () => {
    layOutViteOutput(`${CLEAN_BUNDLE}const t="${dataUrl(Buffer.from('{"x":1}'), 'text/plain')}";\n`);
    expect(failureRules()).toEqual(
      expect.arrayContaining(['agraharam.js embedded-data', 'agraharam.js forbidden-literal']),
    );
  });

  it('rejects any embedded data when no fonts are expected, at its position', () => {
    expect(scanBundleText('const f="data:font/woff2;base64,AAAA";')).toEqual([
      { line: 1, column: 10, rule: 'embedded-data' },
    ]);
  });

  it('needs the package font files to compare against', () => {
    layOutViteOutput();
    rmSync(join(packageDir, SERIF_FONT_FILE));
    expect(() => run()).toThrow(/newsreader-latin-opsz-normal\.woff2 is missing\. Run "npm ci"/);
  });
});

describe('postbuild size line (§11.5, §17.2)', () => {
  it('targets 720 KiB raw', () => {
    expect(BUNDLE_SIZE_TARGET_BYTES).toBe(737_280);
  });

  it('reports raw and gzip bytes against the target, and warns above it', () => {
    const small = Buffer.from('export {};\n'.repeat(10));
    expect(sizeLine(small)).toMatch(
      new RegExp(
        `^postbuild: agraharam\\.js 110 B raw, \\d+ B gzip \\(target ${BUNDLE_SIZE_TARGET_BYTES} B raw\\)\\.$`,
      ),
    );
    const large = Buffer.alloc(BUNDLE_SIZE_TARGET_BYTES + 1, 'a');
    expect(sizeLine(large)).toMatch(
      /^postbuild: warning: agraharam\.js \d+ B raw, \d+ B gzip, above the \d+ B target\.$/,
    );
  });
});
