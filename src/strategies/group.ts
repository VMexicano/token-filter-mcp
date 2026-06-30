import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * GroupStrategy — Groups lines by a regex capture key.
 *
 * For each line that matches the `groupKey` RegExp, the first capture group
 * is used as the grouping key. Lines that don't match are placed in a "misc" group.
 *
 * Output format per group:
 * ```
 * [group name] (N items):
 *   line 1
 *   line 2
 * ```
 *
 * Groups are sorted by item count descending.
 * Maximum 20 groups are included in the output.
 */
export class GroupStrategy implements FilterStrategy {
  readonly name = 'group';

  apply(input: string, options: StrategyOptions): string {
    const groupKey = options.groupKey;

    if (!groupKey) {
      return input;
    }

    const lines = input.split('\n');

    if (lines.length === 0) {
      return input;
    }

    const groups = new Map<string, string[]>();

    for (const line of lines) {
      const key = this.extractKey(line, groupKey);
      const bucket = groups.get(key) ?? [];
      bucket.push(line);
      groups.set(key, bucket);
    }

    // Sort groups by item count descending, limit to 20
    const sorted = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 20);

    const result: string[] = [];

    for (const [key, items] of sorted) {
      result.push(`[${key}] (${items.length} items):`);
      for (const item of items) {
        result.push(`  ${item}`);
      }
    }

    return result.join('\n');
  }

  private extractKey(line: string, groupKey: RegExp): string {
    const match = groupKey.exec(line);
    if (match?.[1] !== undefined) {
      return match[1];
    }
    return 'misc';
  }
}
