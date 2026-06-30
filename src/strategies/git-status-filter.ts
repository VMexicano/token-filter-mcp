import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * GitStatusCompactFilter — Parses `git status --porcelain` output into a compact format.
 *
 * Porcelain format: two characters for status (XY) followed by a space and filename.
 * Common statuses: M (modified), A (added), D (deleted), R (renamed), ? (untracked)
 *
 * Two-char codes are mapped to simple categories:
 * - Any M in X or Y position → Modified
 * - A in X position → Added
 * - D in X or Y position → Deleted
 * - ?? → Untracked
 * - R in X position → Renamed (treated as Modified for counting)
 *
 * Output format:
 *   M 2 | A 1 | D 1 | ? 1
 *
 *   Modified:
 *     src/file1.ts
 *     src/file4.ts
 *   Added:
 *     src/file2.ts
 *   Deleted:
 *     old-file.ts
 *   Untracked:
 *     src/file3.ts
 */
export class GitStatusCompactFilter implements FilterStrategy {
  readonly name = 'git-status-compact';

  apply(input: string, _options: StrategyOptions): string {
    const lines = input.split('\n').filter((line) => line.length > 0);

    if (lines.length === 0) {
      return 'No changes';
    }

    const groups = this.classifyFiles(lines);
    const summary = this.buildSummary(groups);
    const sections = this.buildSections(groups);

    return [summary, '', ...sections].join('\n');
  }

  /**
   * Classify each porcelain line into a category and collect filenames.
   */
  private classifyFiles(lines: string[]): GroupedFiles {
    const groups: GroupedFiles = {
      modified: [],
      added: [],
      deleted: [],
      untracked: [],
    };

    for (const line of lines) {
      if (line.length < 4) continue;

      const x = line[0];
      const y = line[1];
      const filename = line.slice(3);
      const category = this.categorize(x, y);

      groups[category].push(filename);
    }

    return groups;
  }

  /**
   * Map two-char porcelain status codes to a simple category.
   */
  private categorize(x: string, y: string): FileCategory {
    if (x === '?' && y === '?') return 'untracked';
    if (x === 'D' || y === 'D') return 'deleted';
    if (x === 'A') return 'added';
    return 'modified';
  }

  /**
   * Build the compact summary line: `M N | A N | D N | ? N`
   */
  private buildSummary(groups: GroupedFiles): string {
    const parts: string[] = [];
    if (groups.modified.length > 0) parts.push(`M ${groups.modified.length}`);
    if (groups.added.length > 0) parts.push(`A ${groups.added.length}`);
    if (groups.deleted.length > 0) parts.push(`D ${groups.deleted.length}`);
    if (groups.untracked.length > 0) parts.push(`? ${groups.untracked.length}`);
    return parts.join(' | ');
  }

  /**
   * Build grouped file listing sections.
   */
  private buildSections(groups: GroupedFiles): string[] {
    const sections: string[] = [];
    const labels: Array<[FileCategory, string]> = [
      ['modified', 'Modified:'],
      ['added', 'Added:'],
      ['deleted', 'Deleted:'],
      ['untracked', 'Untracked:'],
    ];

    for (const [key, label] of labels) {
      const files = groups[key];
      if (files.length > 0) {
        sections.push(label);
        for (const file of files) {
          sections.push(`  ${file}`);
        }
      }
    }

    return sections;
  }
}

type FileCategory = 'modified' | 'added' | 'deleted' | 'untracked';

interface GroupedFiles {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}
