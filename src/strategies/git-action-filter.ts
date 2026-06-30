import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * GitActionFilter — Minimal confirmation for git action commands.
 *
 * Handles commit, push, pull, and add operations:
 * - On error (exitCode !== 0): returns the full raw output unchanged,
 *   since the error IS the actionable information (Req 5.6).
 * - On success: parses the output to extract key info and returns
 *   a one-line confirmation in `ok <detail>` format (Req 5.5).
 *
 * Validates: Requirements 5.5, 5.6
 */
export class GitActionFilter implements FilterStrategy {
  readonly name = 'git-action';

  // Pattern: [branch hash] message  (e.g., [main abc1234] fix: typo)
  private static readonly COMMIT_HASH_PATTERN = /\[[\w\-/]+\s+([a-f0-9]+)\]/;

  // Pattern: branch -> remote/branch (e.g., main -> origin/main)
  private static readonly PUSH_BRANCH_PATTERN = /(\S+)\s*->\s*(\S+)/;

  // Pattern: N file(s) changed, N insertion(s)(+), N deletion(s)(-)
  private static readonly PULL_FILES_PATTERN = /(\d+)\s+files?\s+changed/;
  private static readonly PULL_INSERTIONS_PATTERN = /(\d+)\s+insertions?\(\+\)/;
  private static readonly PULL_DELETIONS_PATTERN = /(\d+)\s+deletions?\(-\)/;

  apply(input: string, options: StrategyOptions): string {
    const exitCode = options.exitCode as number | undefined;

    // If exit code is non-zero, return the full output unchanged — the error
    // is the actionable information the LLM needs to see.
    if (exitCode !== undefined && exitCode !== 0) {
      return input;
    }

    // For successful operations, try to extract meaningful details
    const lines = input.split('\n').filter((line) => line.trim().length > 0);

    // Try commit pattern
    const commitMatch = this.tryCommit(input);
    if (commitMatch) return commitMatch;

    // Try push pattern
    const pushMatch = this.tryPush(input);
    if (pushMatch) return pushMatch;

    // Try pull pattern
    const pullMatch = this.tryPull(input);
    if (pullMatch) return pullMatch;

    // For add or when no pattern matches, return minimal ok
    // with the first non-empty line trimmed to 80 chars as fallback detail
    if (lines.length === 0) {
      return 'ok';
    }

    const firstLine = lines[0].trim();
    if (firstLine.length === 0) {
      return 'ok';
    }

    const detail = firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine;
    return `ok ${detail}`;
  }

  private tryCommit(input: string): string | null {
    const match = GitActionFilter.COMMIT_HASH_PATTERN.exec(input);
    if (match) {
      return `ok ${match[0]}`;
    }
    return null;
  }

  private tryPush(input: string): string | null {
    // Push output typically contains lines like:
    //   To https://github.com/user/repo.git
    //      abc1234..def5678  main -> main
    // or:  * [new branch]  feature -> feature
    const lines = input.split('\n');
    for (const line of lines) {
      const match = GitActionFilter.PUSH_BRANCH_PATTERN.exec(line);
      if (match && !line.includes('[') && !line.includes('To ')) {
        return `ok ${match[1]} → ${match[2]}`;
      }
    }
    // Check for "new branch" pattern
    for (const line of lines) {
      if (line.includes('[new branch]')) {
        const branchMatch = GitActionFilter.PUSH_BRANCH_PATTERN.exec(line);
        if (branchMatch) {
          return `ok ${branchMatch[1]} → ${branchMatch[2]}`;
        }
      }
    }
    return null;
  }

  private tryPull(input: string): string | null {
    const filesMatch = GitActionFilter.PULL_FILES_PATTERN.exec(input);
    if (!filesMatch) return null;

    const files = filesMatch[1];
    const insertionsMatch = GitActionFilter.PULL_INSERTIONS_PATTERN.exec(input);
    const deletionsMatch = GitActionFilter.PULL_DELETIONS_PATTERN.exec(input);
    const insertions = insertionsMatch?.[1] ?? '0';
    const deletions = deletionsMatch?.[1] ?? '0';

    return `ok +${files} files, ${insertions} insertions, ${deletions} deletions`;
  }
}
