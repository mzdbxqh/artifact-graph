import { configDefaults, defineConfig } from 'vitest/config';

const publicRepoExcludes =
  process.env.ARTIFACT_GRAPH_PUBLIC_REPO === '1' ? ['test/artifact-chain-toolkit.test.ts'] : [];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...publicRepoExcludes],
  },
});
