import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * TruncateStrategy — Reduces output by keeping boundary lines.
 *
 * Modes:
 * - keepEnd=false (default): retains first maxLines/2 and last maxLines/2 lines
 *   with a separator indicating how many lines were omitted.
 * - keepEnd=true: retains only the last maxLines lines.
 *
 * If the input has ≤ maxLines lines, it passes through unmodified.
 */
export class TruncateStrategy implements FilterStrategy {
  readonly name = 'truncate';

  apply(input: string, options: StrategyOptions): string {
    const maxLines = options.maxLines ?? 100;
    const keepEnd = options.keepEnd ?? false;

    const lines = input.split('\n');

    if (lines.length <= maxLines) {
      return input;
    }

    if (keepEnd) {
      return lines.slice(lines.length - maxLines).join('\n');
    }

    // Split evenly between head and tail
    const headCount = Math.floor(maxLines / 2);
    const tailCount = maxLines - headCount;

    const head = lines.slice(0, headCount);
    const tail = lines.slice(lines.length - tailCount);
    const omitted = lines.length - headCount - tailCount;

    return [
      ...head,
      `[...${omitted} lines omitted...]`,
      ...tail,
    ].join('\n');
  }
}
