import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * GitDiffFilter — Compacts `git diff` output by removing repetitive headers
 * and limiting context lines around changes.
 *
 * Behavior:
 * - Strips repetitive headers: `diff --git`, `index`, `---`, `+++`
 * - Retains hunk headers (`@@`) and changed lines (`+`/`-`)
 * - Limits context lines (unchanged lines starting with space) to
 *   options.contextLines (default 3) around changed lines
 * - Always preserves `rename from`, `rename to`, and `Binary files` lines
 * - Appends a per-file summary of insertions/deletions at the end
 *
 * Requirements: 5.3, 5.7
 */
export class GitDiffFilter implements FilterStrategy {
  readonly name = 'git-diff';

  apply(input: string, options: StrategyOptions): string {
    const contextLines = options.contextLines ?? 3;
    const lines = input.split('\n');

    // Parse diff into file sections
    const fileSections = this.parseFileSections(lines);

    const outputLines: string[] = [];
    const fileSummaries: string[] = [];

    for (const section of fileSections) {
      const { filename, hunks, preservedLines, insertions, deletions } = this.processSection(section, contextLines);

      // Add preserved lines (rename from/to, Binary files)
      for (const line of preservedLines) {
        outputLines.push(line);
      }

      // Add filtered hunks
      for (const hunk of hunks) {
        outputLines.push(...hunk);
      }

      // Build per-file summary
      if (filename) {
        fileSummaries.push(`${filename}: +${insertions} -${deletions}`);
      }
    }

    // Append summaries
    if (fileSummaries.length > 0) {
      if (outputLines.length > 0 && outputLines.at(-1) !== '') {
        outputLines.push('');
      }
      outputLines.push(...fileSummaries);
    }

    return outputLines.join('\n');
  }

  /**
   * Split the diff into per-file sections.
   * Each section starts with a `diff --git` line.
   */
  private parseFileSections(lines: string[]): string[][] {
    const sections: string[][] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        if (current.length > 0) {
          sections.push(current);
        }
        current = [line];
      } else {
        current.push(line);
      }
    }

    if (current.length > 0) {
      sections.push(current);
    }

    return sections;
  }

  /**
   * Process a single file section: extract filename, filter hunks,
   * preserve special lines, and count insertions/deletions.
   */
  private processSection(sectionLines: string[], contextLines: number) {
    let filename: string | null = null;
    const preservedLines: string[] = [];
    const rawHunks: string[][] = [];
    let currentHunk: string[] = [];
    let insertions = 0;
    let deletions = 0;

    for (const line of sectionLines) {
      // Extract filename from `diff --git a/path b/path`
      if (line.startsWith('diff --git ')) {
        const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
        filename = match ? match[1] : this.extractFilenameFromDiffLine(line);
        continue; // Strip this header
      }

      // Strip index line
      if (line.startsWith('index ')) {
        continue;
      }

      // Strip --- and +++ lines
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        continue;
      }

      // Always preserve rename and binary file lines
      if (
        line.startsWith('rename from ') ||
        line.startsWith('rename to ') ||
        line.startsWith('Binary files ')
      ) {
        preservedLines.push(line);
        continue;
      }

      // Hunk header starts a new hunk
      if (line.startsWith('@@ ')) {
        if (currentHunk.length > 0) {
          rawHunks.push(currentHunk);
        }
        currentHunk = [line];
        continue;
      }

      // Inside a hunk
      if (currentHunk.length > 0) {
        currentHunk.push(line);
      }
    }

    // Push last hunk
    if (currentHunk.length > 0) {
      rawHunks.push(currentHunk);
    }

    // Filter context lines and count changes in each hunk
    const filteredHunks: string[][] = [];

    for (const hunk of rawHunks) {
      const { filtered, ins, del } = this.filterHunkContext(hunk, contextLines);
      if (filtered.length > 0) {
        filteredHunks.push(filtered);
      }
      insertions += ins;
      deletions += del;
    }

    return {
      filename,
      hunks: filteredHunks,
      preservedLines,
      insertions,
      deletions,
    };
  }

  /**
   * Filter a hunk to keep only `contextLines` unchanged lines around changes.
   * Also counts insertions and deletions.
   */
  private filterHunkContext(hunk: string[], contextLines: number) {
    // First line is the @@ header
    const header = hunk[0];
    const bodyLines = hunk.slice(1);

    let insertions = 0;
    let deletions = 0;

    // Mark which lines are changes (additions or deletions)
    const isChange: boolean[] = bodyLines.map(line => {
      if (line.startsWith('+')) {
        insertions++;
        return true;
      }
      if (line.startsWith('-')) {
        deletions++;
        return true;
      }
      return false;
    });

    // Determine which context lines to keep (within contextLines of a change)
    const keepLine: boolean[] = new Array(bodyLines.length).fill(false);

    for (let i = 0; i < bodyLines.length; i++) {
      if (isChange[i]) {
        keepLine[i] = true;
        // Mark context lines before
        for (let j = Math.max(0, i - contextLines); j < i; j++) {
          keepLine[j] = true;
        }
        // Mark context lines after
        for (let j = i + 1; j <= Math.min(bodyLines.length - 1, i + contextLines); j++) {
          keepLine[j] = true;
        }
      }
    }

    // Build filtered output
    const filtered: string[] = [header];
    for (let i = 0; i < bodyLines.length; i++) {
      if (keepLine[i]) {
        filtered.push(bodyLines[i]);
      }
    }

    return { filtered, ins: insertions, del: deletions };
  }

  /**
   * Fallback filename extraction when the standard pattern doesn't match.
   */
  private extractFilenameFromDiffLine(line: string): string {
    // Try to extract from `diff --git a/file b/file`
    const parts = line.split(' ');
    if (parts.length >= 4) {
      const bPath = parts.at(-1) ?? '';
      return bPath.startsWith('b/') ? bPath.slice(2) : bPath;
    }
    return 'unknown';
  }
}
