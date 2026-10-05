/**
 * Copies the built card bundle into the harness preview tree at the same /local/agraharam/<version>/ path HA
 * serves, byte for byte, so e2e and `npm run preview` exercise exactly the files that would be installed (§3). The
 * release directory is flat (§17.2), so only its top-level regular files are staged; anything else fails.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../build-env.ts';

/**
 * @param {string} packageDir absolute path of frontend/agraharam
 * @param {string} version the build version (`APP_VERSION`, which honours AGR_PATCH like the build itself)
 * @returns {{ source: string, target: string }}
 */
export function stagePreview(packageDir, version) {
  const source = join(packageDir, 'dist', 'agraharam', version);
  const target = join(packageDir, 'dist', 'preview', 'local', 'agraharam', version);
  if (!existsSync(join(source, 'agraharam.js'))) {
    throw new Error(
      `stage-preview: ${relative(packageDir, source)}/agraharam.js is missing. Run "npm run build" first.`,
    );
  }
  const files = flatFiles(source);
  // Replace rather than merge, so files from an earlier build can never linger in the preview.
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of files) copyFileSync(join(source, file), join(target, file));
  for (const file of files) {
    if (!readFileSync(join(source, file)).equals(readFileSync(join(target, file)))) {
      throw new Error(`stage-preview: ${file} differs from the build output after copying.`);
    }
  }
  return { source, target };
}

/**
 * @param {string} dir
 * @returns {string[]} the directory's file names, sorted
 * @throws {Error} on a subdirectory, link or special file: the §17.2 release directory is flat
 */
function flatFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const unexpected = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (unexpected.length > 0) {
    throw new Error(
      `stage-preview: the build output must be flat files only; found ${unexpected.sort().join(', ')}. Rebuild with ` +
        '"npm run build".',
    );
  }
  return entries.map((entry) => entry.name).sort();
}

if (import.meta.main) {
  try {
    const { target } = stagePreview(fileURLToPath(new URL('..', import.meta.url)), APP_VERSION);
    console.log(`stage-preview: staged ${relative(process.cwd(), target)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
