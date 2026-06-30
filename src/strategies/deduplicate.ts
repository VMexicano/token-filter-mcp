import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * DeduplicateStrategy — Collapses consecutive identical lines.
 *
 * Lines are compared after trimming (leading/trailing whitespace removed).
 * When `threshold` or more consecutive lines are identical (trimmed),
 * they are collapsed into a single `[×N] <line>` indicator.
 *
 * Lines that repeat fewer than `threshold` times are preserved individually.
 *
 * Default threshold: 3
 */
export class DeduplicateStrategy implements FilterStrategy {
  readonly name = 'deduplicate';

  apply(input: string, options: StrategyOptions): string {
    const threshold = options.threshold ?? 3;
    const lines = input.split('\n');

    if (lines.length === 0) {
      return input;
    }

    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const currentTrimmed = lines[i].trim();
      let count = 1;

      // Count consecutive identical lines (compared trimmed)
      while (
        i + count < lines.length &&
        lines[i + count].trim() === currentTrimmed
      ) {
        count++;
      }

      if (count >= threshold) {
        // Collapse into a single indicator
        result.push(`[×${count}] ${currentTrimmed}`);
      } else {
        // Preserve individually (use original lines, not trimmed)
        for (let j = 0; j < count; j++) {
          result.push(lines[i + j]);
        }
      }

      i += count;
    }

    return result.join('\n');
  }
}
