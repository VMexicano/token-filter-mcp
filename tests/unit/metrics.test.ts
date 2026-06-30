import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetricsLogger } from '../../src/metrics.js';
import type { MetricsConfig, MetricsEntry } from '../../src/types.js';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `metrics-test-${process.pid}-${Date.now()}`);
const METRICS_FILE = join(TEST_DIR, 'metrics.jsonl');

function makeEntry(overrides: Partial<MetricsEntry> = {}): MetricsEntry {
  return {
    timestamp: '2024-01-01T00:00:00.000Z',
    tool: 'filtered_shell',
    command: 'npm test',
    rawChars: 1000,
    filteredChars: 200,
    savingsPercent: 80.0,
    strategy: 'TestResultFilter',
    filterLevel: 'normal',
    exitCode: 0,
    filterDurationMs: 12,
    ...overrides,
  };
}

function defaultConfig(): MetricsConfig {
  return {
    enabled: true,
    maxFileSizeMb: 5,
    maxFiles: 5,
  };
}

describe('MetricsLogger', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('log()', () => {
    it('writes entry as JSONL to metrics.jsonl', () => {
      const logger = new MetricsLogger(defaultConfig(), TEST_DIR);
      const entry = makeEntry();

      logger.log(entry);

      expect(existsSync(METRICS_FILE)).toBe(true);
      const content = readFileSync(METRICS_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(entry);
    });

    it('appends multiple entries as separate lines', () => {
      const logger = new MetricsLogger(defaultConfig(), TEST_DIR);

      logger.log(makeEntry({ tool: 'filtered_shell' }));
      logger.log(makeEntry({ tool: 'smart_test' }));
      logger.log(makeEntry({ tool: 'smart_git' }));

      const content = readFileSync(METRICS_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).tool).toBe('filtered_shell');
      expect(JSON.parse(lines[1]).tool).toBe('smart_test');
      expect(JSON.parse(lines[2]).tool).toBe('smart_git');
    });

    it('is a no-op when metrics.enabled is false', () => {
      const logger = new MetricsLogger(
        { ...defaultConfig(), enabled: false },
        TEST_DIR
      );

      logger.log(makeEntry());

      expect(existsSync(METRICS_FILE)).toBe(false);
    });

    it('creates the metrics directory if it does not exist', () => {
      const nestedDir = join(TEST_DIR, 'nested', 'deep');
      const logger = new MetricsLogger(defaultConfig(), nestedDir);

      logger.log(makeEntry());

      expect(existsSync(nestedDir)).toBe(true);
      expect(existsSync(join(nestedDir, 'metrics.jsonl'))).toBe(true);
    });

    it('silently swallows errors and does not throw', () => {
      // Point to a non-writable location (on Windows, an invalid path)
      const badDir = join(TEST_DIR, '\0invalid');
      const logger = new MetricsLogger(defaultConfig(), badDir);

      // This should not throw even if underlying I/O fails
      expect(() => logger.log(makeEntry())).not.toThrow();
    });
  });

  describe('rotation', () => {
    it('rotates when file size exceeds maxFileSizeMb', () => {
      const config: MetricsConfig = {
        enabled: true,
        maxFileSizeMb: 0.0001, // ~100 bytes
        maxFiles: 5,
      };

      // Write enough data to exceed the size limit
      const bigData = 'x'.repeat(200) + '\n';
      writeFileSync(METRICS_FILE, bigData);

      const logger = new MetricsLogger(config, TEST_DIR);
      logger.log(makeEntry());

      // After rotation, old file should be at metrics.1.jsonl
      const rotatedPath = join(TEST_DIR, 'metrics.1.jsonl');
      expect(existsSync(rotatedPath)).toBe(true);
      expect(readFileSync(rotatedPath, 'utf-8')).toBe(bigData);

      // New entry should be in the main file
      const newContent = readFileSync(METRICS_FILE, 'utf-8');
      const parsed = JSON.parse(newContent.trim());
      expect(parsed.tool).toBe('filtered_shell');
    });

    it('shifts numbered files up during rotation', () => {
      const config: MetricsConfig = {
        enabled: true,
        maxFileSizeMb: 0.0001,
        maxFiles: 5,
      };

      // Pre-create metrics.1.jsonl and metrics.2.jsonl
      writeFileSync(join(TEST_DIR, 'metrics.1.jsonl'), 'old-1\n');
      writeFileSync(join(TEST_DIR, 'metrics.2.jsonl'), 'old-2\n');

      // Write enough to trigger rotation
      writeFileSync(METRICS_FILE, 'x'.repeat(200) + '\n');

      const logger = new MetricsLogger(config, TEST_DIR);
      logger.log(makeEntry());

      // Old numbered files should have shifted
      expect(readFileSync(join(TEST_DIR, 'metrics.3.jsonl'), 'utf-8')).toBe('old-2\n');
      expect(readFileSync(join(TEST_DIR, 'metrics.2.jsonl'), 'utf-8')).toBe('old-1\n');
      // New .1 should be the old main file content
      expect(readFileSync(join(TEST_DIR, 'metrics.1.jsonl'), 'utf-8')).toBe('x'.repeat(200) + '\n');
    });

    it('deletes the oldest file when exceeding maxFiles', () => {
      const config: MetricsConfig = {
        enabled: true,
        maxFileSizeMb: 0.0001,
        maxFiles: 3,
      };

      // Pre-create max files
      writeFileSync(join(TEST_DIR, 'metrics.1.jsonl'), 'file-1\n');
      writeFileSync(join(TEST_DIR, 'metrics.2.jsonl'), 'file-2\n');
      writeFileSync(join(TEST_DIR, 'metrics.3.jsonl'), 'file-3\n');

      // Trigger rotation
      writeFileSync(METRICS_FILE, 'x'.repeat(200) + '\n');

      const logger = new MetricsLogger(config, TEST_DIR);
      logger.log(makeEntry());

      // After rotation:
      // 1. metrics.3.jsonl (oldest) is deleted
      // 2. metrics.2.jsonl → metrics.3.jsonl
      // 3. metrics.1.jsonl → metrics.2.jsonl
      // 4. metrics.jsonl → metrics.1.jsonl
      expect(readFileSync(join(TEST_DIR, 'metrics.3.jsonl'), 'utf-8')).toBe('file-2\n');
      expect(readFileSync(join(TEST_DIR, 'metrics.2.jsonl'), 'utf-8')).toBe('file-1\n');
      expect(readFileSync(join(TEST_DIR, 'metrics.1.jsonl'), 'utf-8')).toBe('x'.repeat(200) + '\n');
    });

    it('does not rotate when file is under size limit', () => {
      const config: MetricsConfig = {
        enabled: true,
        maxFileSizeMb: 5,
        maxFiles: 5,
      };

      writeFileSync(METRICS_FILE, 'small data\n');

      const logger = new MetricsLogger(config, TEST_DIR);
      logger.log(makeEntry());

      // No rotation should have occurred
      expect(existsSync(join(TEST_DIR, 'metrics.1.jsonl'))).toBe(false);
    });
  });

  describe('isPassthroughReInvocation()', () => {
    it('returns false when no prior invocation exists', () => {
      const logger = new MetricsLogger(defaultConfig(), TEST_DIR);
      expect(logger.isPassthroughReInvocation('filtered_shell', 'npm test')).toBe(false);
    });

    it('returns true after a non-passthrough invocation of same tool+command', () => {
      const logger = new MetricsLogger(defaultConfig(), TEST_DIR);

      // First invocation with normal filter level
      logger.log(makeEntry({
        tool: 'filtered_shell',
        command: 'npm test',
        filterLevel: 'normal',
      }));

      // Now check if passthrough re-invocation
      expect(logger.isPassthroughReInvocation('filtered_shell', 'npm test')).toBe(true);
    });

    it('returns false for a different command', () => {
      const logger = new MetricsLogger(defaultConfig(), TEST_DIR);

      logger.log(makeEntry({
        tool: 'filtered_shell',
        command: 'npm test',
        filterLevel: 'normal',
      }));

      expect(logger.isPassthroughReInvocation('filtered_shell', 'npm run build')).toBe(false);
    });

    it('does not track passthrough invocations', () => {
      const logger = new MetricsLogger(defaultConfig(), TEST_DIR);

      // Only passthrough invocations — should not be tracked
      logger.log(makeEntry({
        tool: 'filtered_shell',
        command: 'npm test',
        filterLevel: 'passthrough',
      }));

      expect(logger.isPassthroughReInvocation('filtered_shell', 'npm test')).toBe(false);
    });

    it('returns false when metrics are disabled', () => {
      const logger = new MetricsLogger(
        { ...defaultConfig(), enabled: false },
        TEST_DIR
      );
      expect(logger.isPassthroughReInvocation('filtered_shell', 'npm test')).toBe(false);
    });

    it('tracks aggressive level invocations as non-passthrough', () => {
      const logger = new MetricsLogger(defaultConfig(), TEST_DIR);

      logger.log(makeEntry({
        tool: 'smart_test',
        command: 'vitest',
        filterLevel: 'aggressive',
      }));

      expect(logger.isPassthroughReInvocation('smart_test', 'vitest')).toBe(true);
    });
  });
});
