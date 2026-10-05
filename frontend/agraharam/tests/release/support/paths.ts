/** Paths of the release files that live outside the package, at the repository root (§17.4, §17.5). */
import { join } from 'node:path';
import { PACKAGE_DIR } from '../../scripts/support/temp-repo.ts';

export { PACKAGE_DIR };
export const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
export const HACS_JSON = join(REPO_ROOT, 'hacs.json');
export const WORKFLOW_FILE = join(REPO_ROOT, '.github', 'workflows', 'agraharam.yml');
