/**
 * FilterEngine — Orchestrates filter strategy selection and application.
 *
 * Responsibilities:
 * - Select strategy based on commandType (via registry)
 * - Apply filter level adjustments (normal, aggressive, passthrough)
 * - Enforce zero-loss invariant post-filtering
 * - Calculate and return metrics (rawChars, filteredChars, savingsPercent, filterDurationMs)
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 13.1, 13.2, 13.3, 13.5
 */

import type {
  FilterInput,
  FilterResult,
  FilterStrategy,
  StrategyOptions,
  CommandType,
} from './types.js';
import { ERROR_PATTERNS } from './types.js';
import { DeduplicateStrategy } from './strategies/deduplicate.js';
import { TruncateStrategy } from './strategies/truncate.js';
import { ComposedStrategy } from './strategies/composed.js';

/** Maximum output size in bytes for passthrough and hard cap (200KB) */
const PASSTHROUGH_CAP_BYTES = 204800;

/**
 * FilterEngine orchestrates strategy selection, application, and zero-loss enforcement.
 */
export class FilterEngine {
  private readonly strategyRegistry: Map<string, FilterStrategy>;
  private readonly fallbackStrategy: FilterStrategy;

  constructor(customStrategies?: Map<string, FilterStrategy>) {
    // Build strategy registry — for now, use FallbackFilter (Deduplicate+Truncate)
    // as placeholder for all unimplemented compound strategies.
    const deduplicate = new DeduplicateStrategy();
    const truncate = new TruncateStrategy();
    this.fallbackStrategy = new ComposedStrategy([deduplicate, truncate]);

    this.strategyRegistry = customStrategies ?? new Map<string, FilterStrategy>();

    // Register FallbackFilter if not already provided
    if (!this.strategyRegistry.has('FallbackFilter')) {
      this.strategyRegistry.set('FallbackFilter', this.fallbackStrategy);
    }
  }

  /**
   * Register a strategy by name for use in the registry.
   */
  registerStrategy(name: string, strategy: FilterStrategy): void {
    this.strategyRegistry.set(name, strategy);
  }

  /**
   * Main entry point: filter raw output based on command type, exit code, and filter level.
   */
  filter(input: FilterInput): FilterResult {
    const startTime = performance.now();
    const { rawOutput, exitCode, commandType, filterLevel, config } = input;
    const rawChars = rawOutput.length;

    // --- Passthrough level: return raw output with 200KB cap (Req 8.3) ---
    if (filterLevel === 'passthrough') {
      const output = this.applyPassthroughCap(rawOutput);
      const filterDurationMs = performance.now() - startTime;
      return this.buildResult(output, rawChars, 'passthrough', filterDurationMs);
    }

    // --- Non-zero exit code + unknown command: return raw output (Req 14.2, 13.2) ---
    if (exitCode !== 0 && commandType === 'unknown') {
      const output = this.applyPassthroughCap(rawOutput);
      const filterDurationMs = performance.now() - startTime;
      return this.buildResult(output, rawChars, 'raw (unknown+error)', filterDurationMs);
    }

    // --- Select strategy based on commandType ---
    const strategyName = this.resolveStrategyName(commandType);
    const strategy = this.strategyRegistry.get(strategyName) ?? this.fallbackStrategy;

    // --- Build options from config, adjusted by filter level ---
    const options = this.buildOptions(config, filterLevel);

    // --- Apply strategy ---
    let filtered = strategy.apply(rawOutput, options);

    // --- Zero-loss verification (Req 13.1, 13.3, 8.5) ---
    filtered = this.enforceZeroLoss(rawOutput, filtered);

    const filterDurationMs = performance.now() - startTime;
    const appliedName = filterLevel === 'aggressive'
      ? `${strategy.name}+aggressive`
      : strategy.name;

    return this.buildResult(filtered, rawChars, appliedName, filterDurationMs);
  }

  /**
   * Resolve which strategy name to use for a given command type.
   * Maps commandType → strategy name from the detector's conventions.
   */
  private resolveStrategyName(commandType: CommandType): string {
    const typeToStrategy: Record<CommandType, string> = {
      test_runner: 'TestResultFilter',
      git_status: 'GitStatusCompactFilter',
      git_diff: 'GitDiffFilter',
      git_log: 'GitLogFilter',
      git_action: 'GitActionFilter',
      linter: 'LinterFilter',
      package_install: 'PackageInstallFilter',
      docker: 'FallbackFilter',
      http_client: 'FallbackFilter',
      unknown: 'FallbackFilter',
    };
    return typeToStrategy[commandType];
  }

  /**
   * Build strategy options from config, applying aggressive adjustments if needed.
   *
   * Normal (Req 8.1): use config defaults as-is.
   * Aggressive (Req 8.2): halve maxLines, reduce contextLines to 1.
   */
  private buildOptions(
    config: FilterInput['config'],
    filterLevel: FilterInput['filterLevel'],
  ): StrategyOptions {
    let maxLines = config.maxOutputLines;
    let contextLines = config.diffContextLines;
    const threshold = config.dedupThreshold;

    if (filterLevel === 'aggressive') {
      maxLines = Math.max(1, Math.floor(maxLines / 2));
      contextLines = 1;
    }

    return {
      maxLines,
      contextLines,
      threshold,
      keepEnd: false,
    };
  }

  /**
   * Enforce zero-loss invariant: after filtering, re-insert any lines from
   * the raw output that match ERROR_PATTERNS but are missing from filtered output.
   *
   * Validates: Requirements 13.1, 13.3, 8.5
   */
  private enforceZeroLoss(rawOutput: string, filteredOutput: string): string {
    const rawLines = rawOutput.split('\n');
    const filteredLines = filteredOutput.split('\n');

    // Collect all error lines from raw output
    const errorLines: string[] = [];
    for (const line of rawLines) {
      if (this.isErrorLine(line)) {
        errorLines.push(line);
      }
    }

    if (errorLines.length === 0) {
      return filteredOutput;
    }

    // Build a set of filtered lines for fast lookup
    const filteredSet = new Set(filteredLines.map(l => l.trim()));

    // Find missing error lines
    const missingErrorLines: string[] = [];
    for (const errorLine of errorLines) {
      const trimmed = errorLine.trim();
      if (trimmed.length === 0) continue;
      if (!filteredSet.has(trimmed)) {
        missingErrorLines.push(errorLine);
        filteredSet.add(trimmed); // avoid reinserting duplicates
      }
    }

    if (missingErrorLines.length === 0) {
      return filteredOutput;
    }

    // Re-insert missing error lines at the end of the output with a separator
    return [
      filteredOutput,
      '[zero-loss: re-inserted error lines]',
      ...missingErrorLines,
    ].join('\n');
  }

  /**
   * Check if a line matches any of the known error patterns.
   */
  private isErrorLine(line: string): boolean {
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(line)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Apply the 200KB hard cap for passthrough mode.
   */
  private applyPassthroughCap(output: string): string {
    if (output.length > PASSTHROUGH_CAP_BYTES) {
      return output.slice(0, PASSTHROUGH_CAP_BYTES);
    }
    return output;
  }

  /**
   * Build a FilterResult with calculated metrics.
   *
   * Validates: Requirements 1.6, 10.1 (savings calculation)
   */
  private buildResult(
    output: string,
    rawChars: number,
    strategyApplied: string,
    filterDurationMs: number,
  ): FilterResult {
    const filteredChars = output.length;
    const savingsPercent = rawChars > 0
      ? Math.round(((rawChars - filteredChars) / rawChars) * 1000) / 10
      : 0;

    return {
      output,
      rawChars,
      filteredChars,
      savingsPercent,
      strategyApplied,
      filterDurationMs,
    };
  }
}
