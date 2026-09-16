import { defineConfig } from 'vitest/config';

// This service runs in Node, not the parent project's Workers pool.
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } });
