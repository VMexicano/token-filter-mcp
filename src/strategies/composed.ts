import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * ComposedStrategy — Pipes output through an ordered array of strategies.
 *
 * Each strategy receives the output of the previous one as input.
 * The same options are passed to every strategy in the pipeline.
 *
 * The composed name is the joined names of all inner strategies (e.g., "deduplicate+truncate").
 */
export class ComposedStrategy implements FilterStrategy {
  constructor(private readonly strategies: FilterStrategy[]) {}

  get name(): string {
    return this.strategies.map(s => s.name).join('+');
  }

  apply(input: string, options: StrategyOptions): string {
    return this.strategies.reduce(
      (output, strategy) => strategy.apply(output, options),
      input,
    );
  }
}
