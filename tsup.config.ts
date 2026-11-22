import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { self: 'src/main.ts' },
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    platform: 'node',
    target: 'node20',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
});
