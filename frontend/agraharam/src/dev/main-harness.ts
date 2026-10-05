/**
 * harness.html entry (e2e and `npm run preview`): loads the BUILT card bundle from /local/agraharam/<version>/,
 * then mounts the fake HA shell. It never imports element source, so an element defined from source can never stand
 * in for the bundle under test (§10.3). A failed bundle load is left uncaught on purpose: the page-error counter in
 * harness.html records it and every e2e spec asserts that counter is 0.
 */
import './ha-shell.ts';

declare const __HARNESS_BUNDLE_URL__: string;

// String() keeps the specifier dynamic: a literal import() of the defined constant fails the harness build.
const url = String(__HARNESS_BUNDLE_URL__);
await import(/* @vite-ignore */ url);

document.body.append(document.createElement('dev-ha-shell'));
