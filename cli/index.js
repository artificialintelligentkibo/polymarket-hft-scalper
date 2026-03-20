#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tsxCliPath = require.resolve('tsx/dist/cli.mjs');
const entryPath = path.join(__dirname, 'index.ts');

const child = spawn(process.execPath, [tsxCliPath, entryPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('[scalper] Failed to launch CLI:', error instanceof Error ? error.message : error);
  process.exit(1);
});
