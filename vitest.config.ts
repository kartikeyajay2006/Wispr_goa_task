import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Tests never reach the Claude API: scripted clients cover that path, and an empty key keeps the rest offline.
    env: {ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ERASEOPS_AI: 'auto'},
  },
});
