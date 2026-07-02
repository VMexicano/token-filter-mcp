#!/usr/bin/env node
/**
 * Vitest launcher that normalizes the Windows drive-letter case before
 * spawning vitest.
 *
 * Why: on Windows, when the process cwd uses a lowercase drive letter
 * (e.g. `c:\…` instead of `C:\…`), vitest 4 loads `@vitest/runner` under two
 * distinct module URLs (`c:/…` vs `C:/…`). Node treats them as separate
 * modules, so two runner instances exist — the one that evaluates the test
 * file never gets its `runner` set. This surfaces as:
 *
 *   TypeError: Cannot read properties of undefined (reading 'config')
 *
 * at the first `describe(...)`, and every suite reports "0 test".
 *
 * Fixing the cwd in vitest.config.ts is not enough because the pool workers
 * are spawned with the parent process cwd. Correcting the cwd here, before
 * spawning vitest, makes the child (and its workers) inherit a consistent
 * uppercase-drive cwd. No-op on non-Windows and when already uppercase.
 *
 * Refs: vitest-dev/vitest#3812, vitejs/vite#18468
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform === 'win32') {
  const cwd = process.cwd();
  const normalized = cwd.replace(/^([a-z]):/, (_m, drive) => `${drive.toUpperCase()}:`);
  if (normalized !== cwd) {
    try {
      process.chdir(normalized);
    } catch {
      // Best effort — fall through with the original cwd.
    }
  }
}

const require = createRequire(import.meta.url);
// Normalize the drive-letter case of the resolved bin path too: vitest loads
// `@vitest/runner` relative to its own module URL, so a lowercase-drive bin
// path reintroduces the duplicate-instance problem even with an uppercase cwd.
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  .replace(/^([a-z]):/, (_m, drive) => `${drive.toUpperCase()}:`);

const child = spawn(process.execPath, [vitestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
