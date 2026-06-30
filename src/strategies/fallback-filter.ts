import type { FilterStrategy, StrategyOptions } from '../types.js';
import { DeduplicateStrategy } from './deduplicate.js';
import { TruncateStrategy } from './truncate.js';

/**
 * FallbackFilter — Conservative strategy for unknown/unrecognized commands.
 *
 * Behavior:
 * - If options.exitCode is non-zero, returns the input unchanged (capped at 200KB)
 *   since for unknown commands all output could be relevant when there's an error.
 * - Otherwise, applies: Deduplicate (threshold from options, default 3) →
 *   Truncate (maxLines from options, default 100, keepEnd=false)
 *
 * Philosophy: be conservative — when in doubt, preserve the line.
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 14.4
 */
export class FallbackFilter implements FilterStrategy {
  readonly name = 'FallbackFilter';

  private readonly deduplicate = new DeduplicateStrategy();
  private readonly truncate = new TruncateStrategy();

  /** Hard cap for raw output in bytes (200KB) */
  private static readonly RAW_CAP = 204800;

  apply(input: string, options: StrategyOptions): string {
    const exitCode = (options.exitCode as number | undefined) ?? 0;

    // Non-zero exit code: return raw output unchanged, capped at 200KB (Req 14.2)
    if (exitCode !== 0) {
      if (input.length > FallbackFilter.RAW_CAP) {
        return input.slice(0, FallbackFilter.RAW_CAP);
      }
      return input;
    }

    // Normal path: Deduplicate → Truncate (Req 14.1, 14.4)
    const deduplicateOptions: StrategyOptions = {
      threshold: options.threshold ?? 3,
    };

    const truncateOptions: StrategyOptions = {
      maxLines: options.maxLines ?? 100,
      keepEnd: false,
    };

    const deduplicated = this.deduplicate.apply(input, deduplicateOptions);
    return this.truncate.apply(deduplicated, truncateOptions);
  }
}
