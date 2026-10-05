import { configDefaults, defineConfig } from 'vitest/config';
import { APP_VERSION, GIT_SHA } from './build-env.ts';

/** These suites spawn git, bash and node, so they run without DOM globals or the DOM setup file. */
const NODE_PROJECT_TESTS = ['tests/scripts/**/*.test.ts', 'tests/install/**/*.test.ts'];

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION), __GIT_SHA__: JSON.stringify(GIT_SHA) },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          setupFiles: ['tests/setup.ts'],
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...NODE_PROJECT_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: NODE_PROJECT_TESTS,
        },
      },
    ],
  },
});
