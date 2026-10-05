/**
 * Copies the built card bundle into the harness preview tree at the same /local/agraharam/<version>/ path HA
 * serves, byte for byte, so e2e and `npm run preview` exercise exactly the files that would be installed (§3).
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} packageDir absolute path of frontend/agraharam
 * @returns {{ source: string, target: string }}
 */
export function stagePreview(packageDir) {
  const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const source = join(packageDir, 'dist', 'agraharam', version);
  const target = join(packageDir, 'dist', 'preview', 'local', 'agraharam', version);
  if (!existsSync(join(source, 'agraharam.js'))) {
    throw new Error(
      `stage-preview: ${relative(packageDir, source)}/agraharam.js is missing. Run "npm run build" first.`,
    );
  }
  // Replace rather than merge, so files from an earlier build can never linger in the preview.
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  assertIdenticalTrees(source, target);
  return { source, target };
}

/** @param {string} dir */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * @param {string} source
 * @param {string} target
 */
function assertIdenticalTrees(source, target) {
  const sourceFiles = listFiles(source);
  if (sourceFiles.join('\n') !== listFiles(target).join('\n')) {
    throw new Error('stage-preview: the staged file list differs from the build output.');
  }
  for (const file of sourceFiles) {
    if (!readFileSync(join(source, file)).equals(readFileSync(join(target, file)))) {
      throw new Error(`stage-preview: ${file} differs from the build output after copying.`);
    }
  }
}

if (import.meta.main) {
  try {
    const { target } = stagePreview(fileURLToPath(new URL('..', import.meta.url)));
    console.log(`stage-preview: staged ${relative(process.cwd(), target)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
