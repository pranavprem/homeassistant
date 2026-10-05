/**
 * Test double for the GitHub CLI used by tests/release/publish.test.ts. It answers `gh api` calls from a JSON fixture
 * keyed by the call's arguments (with --paginate dropped), records every call, and refuses to run without the
 * GH_TOKEN and GH_REPO a real release step must pass through its env. `release create` succeeds and is recorded.
 *
 * A fixture value is printed as JSON. `{ "pages": [[…], […]] }` is a paginated list: like the real
 * `gh api --paginate` (without --jq or --slurp), it prints the pages merged into one JSON array. A missing route
 * fails like a 404.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(String(process.env['FAKE_GH_LOG']), `${JSON.stringify(args)}\n`);

if (!process.env['GH_TOKEN'] || !process.env['GH_REPO']) {
  process.stderr.write('fake gh: GH_TOKEN and GH_REPO must be set in the step env\n');
  process.exit(4);
}
if (args[0] === 'release' && args[1] === 'create') process.exit(0);

const routes = JSON.parse(readFileSync(String(process.env['FAKE_GH_FIXTURE']), 'utf8'));
const key = args.filter((arg) => arg !== '--paginate').join(' ');
if (!Object.hasOwn(routes, key)) {
  process.stderr.write(`fake gh: Not Found (HTTP 404) for ${key}\n`);
  process.exit(1);
}
const answer = routes[key];
if (answer !== null && typeof answer === 'object' && Array.isArray(answer.pages)) {
  process.stdout.write(`${JSON.stringify(answer.pages.flat())}\n`);
} else if (answer !== null) {
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}
