/**
 * Postbuild (§11.5) on a temp package laid out like a fresh `vite build`: maps moved out, licenses copied, the exact
 * allowlist enforced, the privacy and browser-floor scan, and a reproducible manifest plus SHA256SUMS.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildForbiddenSet, parseExemptions } from '../../scripts/lib/public-scan.mjs';
import {
  BUNDLE_SIZE_TARGET_BYTES,
  postbuild,
  PostbuildError,
  scanBundleText,
  sizeLine,
} from '../../scripts/postbuild.mjs';
import {
  CLEAN_BUNDLE,
  FAKE_BUILD_INFO as BUILD,
  FAKE_FONTS as FONTS,
  layOutViteOutput as layOut,
  writeFile as write,
} from './support/fake-build.ts';

const VERSION = '9.9.9';
const NO_EXEMPTIONS = parseExemptions({});

let packageDir: string;
let bundleDir: string;

function layOutViteOutput(bundle = CLEAN_BUNDLE): void {
  layOut(packageDir, VERSION, bundle);
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

describe('postbuild: the §11.5 tree', () => {
  it('moves source maps out, copies both OFL texts and writes the manifest and checksums', () => {
    layOutViteOutput();
    run();
    expect(existsSync(join(bundleDir, 'agraharam.js.map'))).toBe(false);
    expect(readFileSync(join(packageDir, 'dist/sourcemaps', VERSION, 'agraharam.js.map'), 'utf8')).toBe(
      '{"version":3}',
    );
    expect(readFileSync(join(bundleDir, 'LICENSES/OFL-1.1-Newsreader.txt'), 'utf8')).toContain('Newsreader');
    expect(readFileSync(join(bundleDir, 'LICENSES/OFL-1.1-Hanken-Grotesk.txt'), 'utf8')).toContain('Hanken');

    const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'agraharam-dashboard',
      version: VERSION,
      git_sha: BUILD.gitSha,
      git_dirty: false,
      commit_time: BUILD.commitTime,
      node: 'v24.0.0',
      entry: 'agraharam.js',
      resource_url: `/local/agraharam/${VERSION}/agraharam.js`,
    });
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
      'LICENSES/OFL-1.1-Hanken-Grotesk.txt',
      'LICENSES/OFL-1.1-Newsreader.txt',
      'LICENSES/THIRD_PARTY_LICENSES.md',
      'agraharam.js',
      FONTS.sans,
      FONTS.serif,
    ]);
    const entry = manifest.files.find((file: { path: string }) => file.path === 'agraharam.js');
    expect(entry).toEqual({
      path: 'agraharam.js',
      bytes: Buffer.byteLength(CLEAN_BUNDLE),
      sha256: createHash('sha256').update(CLEAN_BUNDLE).digest('hex'),
    });
  });

  it('writes SHA256SUMS for every file including the manifest, verifiable with the standard tool', () => {
    layOutViteOutput();
    run();
    const lines = readFileSync(join(bundleDir, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(7);
    expect(lines.map((line) => line.slice(66))).toContain('manifest.json');
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
    rmSync(join(bundleDir, 'LICENSES/THIRD_PARTY_LICENSES.md'));
    expect(() => run()).toThrow(/THIRD_PARTY_LICENSES\.md is missing/);
    layOutViteOutput();
    rmSync(join(packageDir, 'node_modules/@fontsource-variable/hanken-grotesk/LICENSE'));
    expect(() => run()).toThrow(/hanken-grotesk\/LICENSE is missing\. Run "npm ci"/);
  });
});

describe('postbuild: allowlist', () => {
  it('refuses any file outside the allowlist', () => {
    layOutViteOutput();
    write(join(bundleDir, 'index.html'), '<!doctype html>');
    write(join(bundleDir, 'assets/chunk.js'), 'export {};');
    expect(failureRules()).toEqual(['assets/chunk.js not-allowlisted', 'index.html not-allowlisted']);
  });

  it('requires exactly one font of each family and no third font', () => {
    layOutViteOutput();
    write(join(bundleDir, 'fonts/extra-face-123.woff2'), Buffer.from([0]));
    expect(failureRules()).toEqual(['fonts/ unexpected-font-count']);
    rmSync(join(bundleDir, 'fonts/extra-face-123.woff2'));
    rmSync(join(bundleDir, FONTS.serif));
    expect(failureRules()).toContain('fonts/newsreader-latin-opsz-normal-<hash>.woff2 expected-exactly-one');
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

  it('reports positions and rules only, never the matched text', () => {
    expect(scanBundleText('x\n  y.toSorted()')).toEqual([{ line: 2, column: 4, rule: 'es2023-array-copy' }]);
  });

  it('fails on a planted forbidden ID from the private set, in the bundle and in a binary font', () => {
    const forbidden = buildForbiddenSet(
      { documents: [{ groups: { people: [{ entity_id: 'person.demo_planted_owner' }] } }] },
      NO_EXEMPTIONS,
    );
    layOutViteOutput(`${CLEAN_BUNDLE}const o="person.demo_planted_owner";\n`);
    write(
      join(bundleDir, FONTS.sans),
      Buffer.concat([Buffer.from([0x77, 0x4f, 0x00]), Buffer.from('demo_planted_owner')]),
    );
    const rules = failureRules(forbidden);
    expect(rules).toContain('agraharam.js entity-id');
    expect(rules).toContain(`${FONTS.sans} object-id`);
    try {
      run(forbidden);
    } catch (error) {
      expect((error as Error).message).not.toContain('demo_planted_owner');
    }
  });

  it('passes a clean bundle against a forbidden set', () => {
    const forbidden = buildForbiddenSet({ documents: [['person.demo_planted_owner']] }, NO_EXEMPTIONS);
    layOutViteOutput();
    expect(() => run(forbidden)).not.toThrow();
  });
});

describe('postbuild size line (§11.5)', () => {
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
