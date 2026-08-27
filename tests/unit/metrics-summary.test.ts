import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleMetricsSummary } from '../../src/tools/metrics-summary.js';
import type { MetricsEntry } from '../../src/types.js';

const TEST_DIR = join(tmpdir(), `metrics-summary-test-${process.pid}-${Date.now()}`);

function makeEntry(overrides: Partial<MetricsEntry> = {}): MetricsEntry {
  return {
    timestamp: '2024-01-01T00:00:00.000Z',
    tool: 'filtered_shell',
    command: 'npm test',
    rawChars: 1000,
    filteredChars: 200,
    savingsPercent: 80,
    strategy: 'TestResultFilter',
    filterLevel: 'normal',
    exitCode: 0,
    filterDurationMs: 12,
    ...overrides,
  };
}

function writeJsonl(filename: string, entries: MetricsEntry[]) {
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(TEST_DIR, filename), body, 'utf-8');
}

describe('metrics_summary', () => {
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

  it('reports no metrics when the directory does not exist', async () => {
    const result = await handleMetricsSummary({}, join(TEST_DIR, 'does-not-exist'));

    expect(result.content[0].text).toContain('No metrics recorded yet');
  });

  it('aggregates raw/filtered chars and savings across entries', async () => {
    writeJsonl('metrics.jsonl', [
      makeEntry({ tool: 'smart_git', rawChars: 1000, filteredChars: 200 }),
      makeEntry({ tool: 'smart_git', rawChars: 500, filteredChars: 100 }),
      makeEntry({ tool: 'smart_test', rawChars: 2000, filteredChars: 100 }),
    ]);

    const result = await handleMetricsSummary({}, TEST_DIR);
    const text = result.content[0].text;

    expect(text).toContain('Invocations: 3');
    expect(text).toContain('3500 raw -> 400 filtered');
    expect(text).toContain('smart_test');
    expect(text).toContain('smart_git');
  });

  it('sorts the per-tool breakdown by chars saved, descending', async () => {
    writeJsonl('metrics.jsonl', [
      makeEntry({ tool: 'small_saver', rawChars: 100, filteredChars: 90 }),
      makeEntry({ tool: 'big_saver', rawChars: 10000, filteredChars: 100 }),
    ]);

    const result = await handleMetricsSummary({}, TEST_DIR);
    const text = result.content[0].text;

    expect(text.indexOf('big_saver')).toBeLessThan(text.indexOf('small_saver'));
  });

  it('filters by tool when requested', async () => {
    writeJsonl('metrics.jsonl', [
      makeEntry({ tool: 'smart_git' }),
      makeEntry({ tool: 'smart_test' }),
    ]);

    const result = await handleMetricsSummary({ tool: 'smart_git' }, TEST_DIR);

    expect(result.content[0].text).toContain('Invocations: 1');
    expect(result.content[0].text).not.toContain('smart_test');
  });

  it('reports when no metrics match the requested tool filter', async () => {
    writeJsonl('metrics.jsonl', [makeEntry({ tool: 'smart_git' })]);

    const result = await handleMetricsSummary({ tool: 'nonexistent_tool' }, TEST_DIR);

    expect(result.content[0].text).toContain('No metrics recorded for tool "nonexistent_tool"');
  });

  it('limits to the N most recent entries', async () => {
    writeJsonl('metrics.jsonl', [
      makeEntry({ tool: 'smart_git', rawChars: 100, filteredChars: 50 }),
      makeEntry({ tool: 'smart_test', rawChars: 200, filteredChars: 50 }),
    ]);

    const result = await handleMetricsSummary({ limit: 1 }, TEST_DIR);

    expect(result.content[0].text).toContain('Invocations: 1');
    // Only the last entry (smart_test) should be counted
    expect(result.content[0].text).toContain('smart_test');
    expect(result.content[0].text).not.toContain('smart_git');
  });

  it('reads rotated files in chronological order (oldest rotated first, current last)', async () => {
    writeJsonl('metrics.2.jsonl', [makeEntry({ tool: 'oldest', timestamp: '2024-01-01T00:00:00.000Z' })]);
    writeJsonl('metrics.1.jsonl', [makeEntry({ tool: 'middle', timestamp: '2024-01-02T00:00:00.000Z' })]);
    writeJsonl('metrics.jsonl', [makeEntry({ tool: 'current', timestamp: '2024-01-03T00:00:00.000Z' })]);

    const result = await handleMetricsSummary({}, TEST_DIR);
    const text = result.content[0].text;

    expect(text).toContain('Invocations: 3');
    expect(text).toContain('2024-01-01T00:00:00.000Z -> 2024-01-03T00:00:00.000Z');
  });

  it('degrades gracefully when the directory exists but becomes unreadable', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: () => true,
        readdirSync: () => {
          throw new Error('EACCES: permission denied');
        },
      };
    });

    const { handleMetricsSummary: handleMetricsSummaryWithBrokenFs } = await import('../../src/tools/metrics-summary.js');
    const result = await handleMetricsSummaryWithBrokenFs({}, TEST_DIR);

    expect(result.content[0].text).toContain('No metrics recorded yet');

    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('skips malformed JSONL lines without failing', async () => {
    writeJsonl('metrics.jsonl', [makeEntry({ tool: 'smart_git' })]);
    // Append a corrupt line manually
    const file = join(TEST_DIR, 'metrics.jsonl');
    writeFileSync(file, JSON.stringify(makeEntry({ tool: 'smart_git' })) + '\nnot valid json\n', 'utf-8');

    const result = await handleMetricsSummary({}, TEST_DIR);

    expect(result.content[0].text).toContain('Invocations: 1');
  });
});
