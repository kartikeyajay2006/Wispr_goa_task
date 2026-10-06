import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Source tests only: compiled copies under dist/ (from tsc -b) must never run.
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Tests never reach a model API: scripted clients cover that path, and empty keys keep the rest offline.
    env: {OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ERASEOPS_AI: 'auto'},
  },
});
