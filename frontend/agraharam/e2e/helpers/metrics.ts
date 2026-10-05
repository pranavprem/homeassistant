/**
 * Reported (not asserted) measurements, written under test-results/metrics/ (gitignored). Tests run in parallel
 * workers, so each case is written to its own file first and the combined file is then rebuilt from every case
 * file and swapped in atomically (write to a temporary name, then rename). The last writer always sees every case.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const METRICS_DIR = join(import.meta.dirname, '..', '..', 'test-results', 'metrics');

/** Records `data` as case `caseId` of `test-results/metrics/<name>.json`. */
export function recordMetrics(name: string, caseId: string, data: unknown): void {
  const caseDir = join(METRICS_DIR, `${name}.cases`);
  mkdirSync(caseDir, { recursive: true });
  writeJson(join(caseDir, `${caseId}.json`), data);
  const combined: Record<string, unknown> = {};
  for (const file of readdirSync(caseDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    combined[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(caseDir, file), 'utf8')) as unknown;
  }
  writeJson(join(METRICS_DIR, `${name}.json`), combined);
}

function writeJson(path: string, data: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temporary, path);
}
