import { describe, it, expect } from 'vitest';
import { CommandExecutor } from '../../src/executor.js';
import type { ExecutionOptions } from '../../src/types.js';

describe('CommandExecutor', () => {
  const executor = new CommandExecutor();

  const defaultOptions: ExecutionOptions = {
    cwd: process.cwd(),
    timeoutMs: 10000,
    maxOutputBytes: 204800,
  };

  it('captures stdout from a simple echo command', async () => {
    const result = await executor.execute('echo hello', defaultOptions);

    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr output', async () => {
    const result = await executor.execute('echo error_msg 1>&2', defaultOptions);

    expect(result.stderr.trim()).toBe('error_msg');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exit code for failing commands', async () => {
    const result = await executor.execute('exit 42', defaultOptions);

    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it('measures durationMs', async () => {
    const result = await executor.execute('echo fast', defaultOptions);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('supports shell pipes (shell: true)', async () => {
    const result = await executor.execute('echo "line1" && echo "line2"', defaultOptions);

    expect(result.stdout).toContain('line1');
    expect(result.stdout).toContain('line2');
    expect(result.exitCode).toBe(0);
  });

  it('enforces hard cap on stdout (maxOutputBytes)', async () => {
    const opts: ExecutionOptions = {
      ...defaultOptions,
      maxOutputBytes: 50,
    };
    // Generate output larger than 50 bytes
    const result = await executor.execute(
      'node -e "process.stdout.write(\'x\'.repeat(200))"',
      opts,
    );

    // stdout should be capped at 50 bytes
    expect(result.stdout.length).toBeLessThanOrEqual(50);
    expect(result.exitCode).toBe(0);
  });

  it('enforces hard cap on stderr (maxOutputBytes)', async () => {
    const opts: ExecutionOptions = {
      ...defaultOptions,
      maxOutputBytes: 50,
    };
    const result = await executor.execute(
      'node -e "process.stderr.write(\'e\'.repeat(200))"',
      opts,
    );

    expect(result.stderr.length).toBeLessThanOrEqual(50);
  });

  it('times out and kills long-running processes', async () => {
    const opts: ExecutionOptions = {
      ...defaultOptions,
      timeoutMs: 2000,
    };
    const result = await executor.execute(
      'node -e "setTimeout(() => {}, 30000)"',
      opts,
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(1500);
    expect(result.durationMs).toBeLessThan(15000);
  }, 30000);

  it('returns partial output on timeout', async () => {
    const opts: ExecutionOptions = {
      ...defaultOptions,
      timeoutMs: 2000,
    };
    const result = await executor.execute(
      'node -e "process.stdout.write(\'partial\'); setTimeout(() => {}, 30000)"',
      opts,
    );

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('partial');
  }, 30000);

  it('handles empty output gracefully', async () => {
    const result = await executor.execute(
      'node -e "process.exit(0)"',
      defaultOptions,
    );

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
