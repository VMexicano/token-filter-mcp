import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * GitLogFilter — Formats git log --oneline output into a compact list.
 *
 * Strategy:
 * 1. Split input into lines, filter empty ones
 * 2. Take first maxEntries lines (options.maxLines ?? 15)
 * 3. Each line is kept as-is (hash is already 7 chars from --oneline)
 * 4. If total lines > maxEntries, append "(+N more commits)"
 * 5. Return the formatted entries joined by newline
 *
 * Validates: Requirements 5.4
 */
export class GitLogFilter implements FilterStrategy {
  readonly name = 'GitLogFilter';

  apply(input: string, options: StrategyOptions): string {
    const maxEntries = options.maxLines ?? 15;

    // Split and filter empty lines
    const lines = input.split('\n').filter(line => line.trim().length > 0);

    if (lines.length === 0) {
      return input;
    }

    // Take the first maxEntries lines
    const entries = lines.slice(0, maxEntries);

    // Build result
    const result: string[] = [...entries];

    // Indicate total commits available if there are more
    if (lines.length > maxEntries) {
      const remaining = lines.length - maxEntries;
      result.push(`(+${remaining} more commits)`);
    }

    return result.join('\n');
  }
}
