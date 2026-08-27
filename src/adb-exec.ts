/**
 * Minimal, mockable seam around `adb` invocation. Isolated from smart-adb.ts
 * so tests can stub process execution without spawning a real adb binary.
 *
 * Uses execFile (argv array, no shell) rather than a shell string — locator
 * and text values coming from the LLM are never string-interpolated into a
 * shell command, so they cannot break out into shell injection.
 */

import { execFile } from 'node:child_process';

export interface AdbResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execAdb(args: string[], timeoutMs: number): Promise<AdbResult> {
  return new Promise((resolve) => {
    execFile(
      'adb',
      args,
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number };
          resolve({
            stdout: stdout ?? '',
            stderr: (stderr || err.message) ?? '',
            exitCode: typeof err.code === 'number' ? err.code : 1,
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}
