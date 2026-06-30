/**
 * CommandExecutor - Executes shell commands with streaming output capture,
 * hard output cap, and timeout support.
 *
 * Requirements: 1.2, 1.4, 12.2, 12.3
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { ExecutionOptions, ExecutionResult } from './types.js';

export class CommandExecutor {
  /**
   * Execute a shell command with streaming capture, hard output cap, and timeout.
   *
   * - Uses child_process.spawn with shell:true for pipe/expansion support
   * - Streams stdout/stderr into buffers with a hard cap at maxOutputBytes
   * - On timeout: kills the process (SIGTERM then SIGKILL), returns partial output
   * - Measures durationMs from start to process exit
   */
  execute(command: string, options: ExecutionOptions): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let killed = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let killHandle: ReturnType<typeof setTimeout> | undefined;

      const maxBytes = options.maxOutputBytes;

      const child: ChildProcess = spawn(command, [], {
        shell: true,
        cwd: options.cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      // Stream stdout with hard cap
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes >= maxBytes) return;

        const remaining = maxBytes - stdoutBytes;
        const toKeep = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        stdoutBuf = Buffer.concat([stdoutBuf, toKeep]);
        stdoutBytes += toKeep.length;
      });

      // Stream stderr with hard cap
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= maxBytes) return;

        const remaining = maxBytes - stderrBytes;
        const toKeep = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        stderrBuf = Buffer.concat([stderrBuf, toKeep]);
        stderrBytes += toKeep.length;
      });

      // Timeout handling
      if (options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcess(child);
        }, options.timeoutMs);
      }

      const killProcess = (proc: ChildProcess): void => {
        if (killed) return;
        killed = true;

        const pid = proc.pid;
        if (pid === undefined) return;

        // On Windows, use taskkill /T to kill the process tree
        if (process.platform === 'win32') {
          try {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
              windowsHide: true,
            });
          } catch {
            // Process may have already exited
          }
        } else {
          // Unix: Try SIGTERM first
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              // Process may have already exited
            }
          }

          // Force SIGKILL after 500ms if still alive
          killHandle = setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                // Process may have already exited
              }
            }
          }, 500);
        }
      };

      // Handle process exit
      child.on('close', (code: number | null, signal: string | null) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);

        const durationMs = Date.now() - startTime;

        // If killed by signal, set exitCode to 1
        const exitCode = signal !== null || code === null ? 1 : code;

        resolve({
          stdout: stdoutBuf.toString('utf-8'),
          stderr: stderrBuf.toString('utf-8'),
          exitCode,
          timedOut,
          durationMs,
        });
      });

      // Handle spawn errors (e.g., command not found)
      child.on('error', () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);

        const durationMs = Date.now() - startTime;

        resolve({
          stdout: stdoutBuf.toString('utf-8'),
          stderr: stderrBuf.toString('utf-8'),
          exitCode: 1,
          timedOut,
          durationMs,
        });
      });
    });
  }
}
