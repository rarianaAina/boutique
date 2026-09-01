import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Le schéma se compare contre un VRAI Postgres : la connexion est lente à
    // établir, et l'épreuve crée puis détruit une base.
    testTimeout: 60_000,
    poolOptions: { forks: { execArgv: ['--experimental-sqlite'] } },
  },
});
