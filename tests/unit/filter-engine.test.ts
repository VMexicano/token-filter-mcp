import { describe, it, expect } from 'vitest';
import { FilterEngine } from '../../src/filter-engine.js';
import type { FilterInput, ResolvedConfig } from '../../src/types.js';

/** Helper to create a default config */
function defaultConfig(): ResolvedConfig {
  return {
    maxOutputLines: 100,
    maxOutputBytes: 204800,
    testShowPasses: false,
    testMaxStackFrames: 5,
    gitLogMax: 15,
    diffContextLines: 3,
    dedupThreshold: 3,
    grepMaxResults: 20,
    metrics: { enabled: true, maxFileSizeMb: 5, maxFiles: 5 },
    commands: {},
  };
}

/** Helper to create a FilterInput */
function makeInput(overrides: Partial<FilterInput> = {}): FilterInput {
  return {
    rawOutput: overrides.rawOutput ?? 'line1\nline2\nline3\n',
    exitCode: overrides.exitCode ?? 0,
    commandType: overrides.commandType ?? 'unknown',
    filterLevel: overrides.filterLevel ?? 'normal',
    config: overrides.config ?? defaultConfig(),
  };
}

describe('FilterEngine', () => {
  describe('passthrough level', () => {
    it('returns raw output unchanged when within 200KB cap', () => {
      const engine = new FilterEngine();
      const raw = 'hello world\nfoo bar\n';
      const result = engine.filter(makeInput({
        rawOutput: raw,
        filterLevel: 'passthrough',
      }));
      expect(result.output).toBe(raw);
      expect(result.strategyApplied).toBe('passthrough');
      expect(result.savingsPercent).toBe(0);
    });

    it('truncates output at 200KB when exceeding cap', () => {
      const engine = new FilterEngine();
      const raw = 'x'.repeat(300_000);
      const result = engine.filter(makeInput({
        rawOutput: raw,
        filterLevel: 'passthrough',
      }));
      expect(result.output.length).toBe(204800);
      expect(result.rawChars).toBe(300_000);
    });
  });

  describe('unknown command + non-zero exit code', () => {
    it('returns raw output without applying FallbackFilter', () => {
      const engine = new FilterEngine();
      const raw = 'error: something went wrong\ndetails here\n';
      const result = engine.filter(makeInput({
        rawOutput: raw,
        exitCode: 1,
        commandType: 'unknown',
        filterLevel: 'normal',
      }));
      expect(result.output).toBe(raw);
      expect(result.strategyApplied).toBe('raw (unknown+error)');
    });
  });

  describe('normal level filtering', () => {
    it('applies FallbackFilter (deduplicate+truncate) for unknown commands', () => {
      const engine = new FilterEngine();
      // Create input with repeated lines that should be deduplicated
      const lines = Array.from({ length: 10 }, () => 'repeated line');
      const raw = lines.join('\n');
      const result = engine.filter(makeInput({
        rawOutput: raw,
        exitCode: 0,
        commandType: 'unknown',
        filterLevel: 'normal',
      }));
      // The deduplicate strategy should collapse 10 identical lines
      expect(result.output).toContain('[×10]');
      expect(result.output).toContain('repeated line');
      expect(result.filteredChars).toBeLessThan(result.rawChars);
    });

    it('applies truncation for long outputs', () => {
      const engine = new FilterEngine();
      const lines = Array.from({ length: 200 }, (_, i) => `unique line ${i}`);
      const raw = lines.join('\n');
      const result = engine.filter(makeInput({
        rawOutput: raw,
        exitCode: 0,
        commandType: 'unknown',
        filterLevel: 'normal',
      }));
      // After dedup (no dupes to collapse), truncate should limit to 100 lines
      const outputLines = result.output.split('\n');
      // 50 head + 1 separator + 50 tail = 101
      expect(outputLines.length).toBeLessThanOrEqual(101);
    });
  });

  describe('aggressive level', () => {
    it('halves maxLines compared to normal', () => {
      const engine = new FilterEngine();
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
      const raw = lines.join('\n');

      const normalResult = engine.filter(makeInput({
        rawOutput: raw,
        exitCode: 0,
        commandType: 'unknown',
        filterLevel: 'normal',
      }));
      const aggressiveResult = engine.filter(makeInput({
        rawOutput: raw,
        exitCode: 0,
        commandType: 'unknown',
        filterLevel: 'aggressive',
      }));

      expect(aggressiveResult.filteredChars).toBeLessThanOrEqual(normalResult.filteredChars);
      expect(aggressiveResult.strategyApplied).toContain('aggressive');
    });
  });

  describe('zero-loss enforcement', () => {
    it('re-inserts error lines that were removed by filtering', () => {
      const engine = new FilterEngine();
      // Create 200 lines where an error line is in the middle (will be truncated away)
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        if (i === 100) {
          lines.push('Error: something critical happened');
        } else {
          lines.push(`progress line ${i}`);
        }
      }
      const raw = lines.join('\n');
      const result = engine.filter(makeInput({
        rawOutput: raw,
        exitCode: 0,
        commandType: 'unknown',
        filterLevel: 'normal',
      }));
      // The error line must be preserved regardless of truncation
      expect(result.output).toContain('Error: something critical happened');
    });

    it('does not duplicate error lines that survive filtering', () => {
      const engine = new FilterEngine();
      // Short output where the error line is naturally preserved
      const raw = 'ok\nError: test failed\ndone\n';
      const result = engine.filter(makeInput({
        rawOutput: raw,
        exitCode: 0,
        commandType: 'unknown',
        filterLevel: 'normal',
      }));
      // Count occurrences of the error line
      const matches = result.output.match(/Error: test failed/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe('metrics calculation', () => {
    it('calculates savingsPercent correctly', () => {
      const engine = new FilterEngine();
      const lines = Array.from({ length: 10 }, () => 'same line');
      const raw = lines.join('\n');
      const result = engine.filter(makeInput({
        rawOutput: raw,
        exitCode: 0,
        commandType: 'unknown',
        filterLevel: 'normal',
      }));
      const expected = Math.round(((result.rawChars - result.filteredChars) / result.rawChars) * 1000) / 10;
      expect(result.savingsPercent).toBe(expected);
    });

    it('returns 0 savings for empty input', () => {
      const engine = new FilterEngine();
      const result = engine.filter(makeInput({
        rawOutput: '',
        exitCode: 0,
        commandType: 'unknown',
        filterLevel: 'normal',
      }));
      expect(result.savingsPercent).toBe(0);
      expect(result.rawChars).toBe(0);
    });

    it('includes filterDurationMs as a positive number', () => {
      const engine = new FilterEngine();
      const result = engine.filter(makeInput({
        rawOutput: 'test output',
        filterLevel: 'normal',
      }));
      expect(result.filterDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('strategy registry', () => {
    it('uses a custom strategy when registered', () => {
      const engine = new FilterEngine();
      engine.registerStrategy('TestResultFilter', {
        name: 'TestResultFilter',
        apply: () => 'custom filtered',
      });
      const result = engine.filter(makeInput({
        rawOutput: 'test output with many lines',
        commandType: 'test_runner',
        filterLevel: 'normal',
      }));
      expect(result.output).toBe('custom filtered');
      expect(result.strategyApplied).toBe('TestResultFilter');
    });

    it('falls back to FallbackFilter when strategy is not registered', () => {
      const engine = new FilterEngine();
      // test_runner maps to TestResultFilter which is not registered
      const result = engine.filter(makeInput({
        rawOutput: 'short output',
        commandType: 'test_runner',
        filterLevel: 'normal',
      }));
      // Should use fallback (deduplicate+truncate) since TestResultFilter is not registered
      expect(result.strategyApplied).toBe('deduplicate+truncate');
    });
  });
});
