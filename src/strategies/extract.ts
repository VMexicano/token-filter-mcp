import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * ExtractStrategy — Captures sections between start and end markers.
 *
 * Behavior:
 * - Scans lines; when a line matches any startMarker, begins capturing.
 * - Captures until a line matches any endMarker (end marker line excluded)
 *   or until EOF is reached.
 * - Concatenates captured sections with a "---" separator.
 * - Limits to a maximum of 10 sections.
 * - If no startMarker is found anywhere in the input, returns the input
 *   unchanged as a safety fallback (Req 7.5).
 *
 * Validates: Requirements 7.4, 7.5
 */
export class ExtractStrategy implements FilterStrategy {
  readonly name = 'extract';

  private static readonly MAX_SECTIONS = 10;
  private static readonly SEPARATOR = '---';

  apply(input: string, options: StrategyOptions): string {
    const startMarkers = options.startMarkers ?? [];
    const endMarkers = options.endMarkers ?? [];

    // If no start markers configured, return input unchanged
    if (startMarkers.length === 0) {
      return input;
    }

    const lines = input.split('\n');
    const { sections, foundAnyStart } = this.extractSections(lines, startMarkers, endMarkers);

    // Safety fallback: if no start marker was found in the entire input,
    // return the original input unchanged (Req 7.5)
    if (!foundAnyStart) {
      return input;
    }

    return sections
      .slice(0, ExtractStrategy.MAX_SECTIONS)
      .map((section) => section.join('\n'))
      .join(`\n${ExtractStrategy.SEPARATOR}\n`);
  }

  private extractSections(
    lines: string[],
    startMarkers: RegExp[],
    endMarkers: RegExp[],
  ): { sections: string[][]; foundAnyStart: boolean } {
    const sections: string[][] = [];
    let foundAnyStart = false;
    let capturing = false;
    let currentSection: string[] = [];

    for (const line of lines) {
      if (capturing) {
        const isEndMarker = endMarkers.some((marker) => marker.test(line));
        if (isEndMarker) {
          sections.push(currentSection);
          currentSection = [];
          capturing = false;
          if (sections.length >= ExtractStrategy.MAX_SECTIONS) {
            break;
          }
        } else {
          currentSection.push(line);
        }
      } else if (startMarkers.some((marker) => marker.test(line))) {
        foundAnyStart = true;
        capturing = true;
        currentSection = [line];
      }
    }

    // If still capturing at EOF, finalize the open section
    if (capturing && currentSection.length > 0) {
      sections.push(currentSection);
    }

    return { sections, foundAnyStart };
  }
}
