import type { FilterStrategy, StrategyOptions } from '../types.js';
import { GroupStrategy } from './group.js';

/**
 * LinterFilter — Filters linter/type-checker output to show only errors and warnings.
 *
 * Detects the linter type from the input (tsc, eslint, biome, ruff, pylint, flake8)
 * and applies appropriate grouping and filtering:
 *
 * - tsc: Groups by file (lines like `src/file.ts(line,col): error TSxxxx: message`)
 * - eslint: Groups by file (file path headers followed by indented error lines)
 * - biome: Groups by file (lines like `path/file.ts:line:col lint/rule`)
 * - ruff/pylint/flake8: Groups by file (lines like `file.py:line:col: CODE message`)
 * - mypy: Groups by file (lines like `file.py:line: error: message  [error-code]`)
 * - Fallback: Keeps lines containing error/warning keywords
 *
 * In all cases, lines indicating "all passed" or "0 problems" are omitted.
 *
 * Requirements: 6.1 (detección de tipo linter)
 */
export class LinterFilter implements FilterStrategy {
  readonly name = 'linter';

  private readonly groupStrategy = new GroupStrategy();

  apply(input: string, options: StrategyOptions): string {
    const linterType = this.detectLinterType(input);

    switch (linterType) {
      case 'tsc':
        return this.filterTsc(input);
      case 'eslint':
        return this.filterEslint(input);
      case 'biome':
        return this.filterBiome(input);
      case 'ruff-pylint-flake8':
        return this.filterPythonLinter(input);
      case 'mypy':
        return this.filterMypy(input);
      default:
        return this.filterGeneric(input);
    }
  }

  // ---------------------------------------------------------------------------
  // Linter Type Detection
  // ---------------------------------------------------------------------------

  private detectLinterType(input: string): LinterType {
    // tsc: "error TS" pattern
    if (/error TS\d+/.test(input)) {
      return 'tsc';
    }

    // eslint: file path followed by indented lines with line:col pattern, or "problems" summary
    if (
      /^\s+\d+:\d+\s+(error|warning)\s+/m.test(input) ||
      /\d+ problems? \(\d+ errors?, \d+ warnings?\)/.test(input)
    ) {
      return 'eslint';
    }

    // biome: lines with "lint/" or "format/" category markers
    if (/\s(lint|format)\/\w+/.test(input) || /biome/i.test(input.split('\n')[0] ?? '')) {
      return 'biome';
    }

    // mypy: "file.py:line: error|warning|note: message" (checked before the ruff/pylint/flake8
    // code-based pattern, since mypy uses the literal words "error:"/"warning:"/"note:" instead
    // of a rule code like E501)
    if (/\.py:\d+(?::\d+)?:\s*(?:error|warning|note):/.test(input)) {
      return 'mypy';
    }

    // ruff/pylint/flake8: Python file paths with codes like E501, W291, C0301, etc.
    if (/\.py:\d+:\d+:\s*[A-Z]\d+/.test(input) || /\.py:\d+:\s*[A-Z]\d+/.test(input)) {
      return 'ruff-pylint-flake8';
    }

    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // TSC Filter
  // ---------------------------------------------------------------------------

  private filterTsc(input: string): string {
    const lines = input.split('\n');
    const errorLines: string[] = [];

    for (const line of lines) {
      // tsc errors: "src/file.ts(line,col): error TSxxxx: message"
      // Also keep lines that are part of error context (indented continuation)
      if (/\(\d+,\d+\):\s*error\s+TS\d+/.test(line)) {
        errorLines.push(line);
      } else if (/^\s+/.test(line) && errorLines.length > 0) {
        // Indented continuation of previous error
        errorLines.push(line);
      }
    }

    if (errorLines.length === 0) {
      return this.noErrorsSummary(input);
    }

    // Group by file using regex to extract filename
    const grouped = this.groupStrategy.apply(errorLines.join('\n'), {
      groupKey: /^([^(]+)\(/,
    });

    // Add error count summary
    const errorCount = errorLines.filter((l) => /error\s+TS\d+/.test(l)).length;
    return `Found ${errorCount} error${errorCount !== 1 ? 's' : ''}:\n\n${grouped}`;
  }

  // ---------------------------------------------------------------------------
  // ESLint Filter
  // ---------------------------------------------------------------------------

  private filterEslint(input: string): string {
    const lines = input.split('\n');
    const outputLines: string[] = [];
    let currentFile: string | null = null;
    let currentFileHasErrors = false;
    const currentFileLines: string[] = [];

    for (const line of lines) {
      // Skip summary lines like "✓ 0 problems" or empty/pass indicators
      if (this.isPassLine(line)) {
        continue;
      }

      // File header: a non-indented path-like line (no leading spaces)
      if (!line.startsWith(' ') && /[/\\]/.test(line) && !line.startsWith('✖')) {
        // Flush previous file if it had errors
        this.flushFileErrors(currentFile, currentFileHasErrors, currentFileLines, outputLines);
        currentFile = line;
        currentFileHasErrors = false;
        currentFileLines.length = 0;
        continue;
      }

      // Error/warning lines: indented with "line:col  error|warning  message  rule"
      if (/^\s+\d+:\d+\s+(error|warning)\s+/.test(line)) {
        currentFileHasErrors = true;
        currentFileLines.push(line);
        continue;
      }

      // Summary line with error/problem counts
      if (/\d+ problems?/.test(line) || /✖/.test(line)) {
        outputLines.push(line);
      }
    }

    // Flush last file
    this.flushFileErrors(currentFile, currentFileHasErrors, currentFileLines, outputLines);

    if (outputLines.length === 0) {
      return this.noErrorsSummary(input);
    }

    return outputLines.join('\n').trim();
  }

  private flushFileErrors(
    currentFile: string | null,
    hasErrors: boolean,
    fileLines: string[],
    outputLines: string[],
  ): void {
    if (currentFile && hasErrors) {
      outputLines.push(currentFile, ...fileLines, '');
    }
  }

  // ---------------------------------------------------------------------------
  // Biome Filter
  // ---------------------------------------------------------------------------

  private filterBiome(input: string): string {
    const lines = input.split('\n');
    const errorLines: string[] = [];

    for (const line of lines) {
      // Biome diagnostic lines typically contain file:line:col and a rule category
      if (/\s(lint|format)\/\w+/.test(line) || /error\[/.test(line) || /warning\[/.test(line)) {
        errorLines.push(line);
      } else if (/^\s*(×|✖|⚠)/.test(line)) {
        // Error/warning marker lines
        errorLines.push(line);
      } else if (/^\s+\d+\s*│/.test(line) && errorLines.length > 0) {
        // Code snippet context in biome output
        errorLines.push(line);
      }
    }

    if (errorLines.length === 0) {
      return this.noErrorsSummary(input);
    }

    // Group by file using the path extraction
    const grouped = this.groupStrategy.apply(errorLines.join('\n'), {
      groupKey: /^([^:\s]+\.\w+)/,
    });

    return grouped;
  }

  // ---------------------------------------------------------------------------
  // Python Linter Filter (ruff, pylint, flake8)
  // ---------------------------------------------------------------------------

  private filterPythonLinter(input: string): string {
    const lines = input.split('\n');
    const errorLines: string[] = [];

    for (const line of lines) {
      // Pattern: file.py:line[:col]: CODE message
      if (/\.py:\d+[:\d]*:\s*[A-Z]\d+/.test(line)) {
        errorLines.push(line);
      }
    }

    if (errorLines.length === 0) {
      return this.noErrorsSummary(input);
    }

    // Group by file. The alternation's first branch handles a Windows drive-letter
    // prefix (e.g. "C:\proj\file.py") so grouping doesn't stop at the drive colon.
    const grouped = this.groupStrategy.apply(errorLines.join('\n'), {
      groupKey: /^([A-Za-z]:[^:]*\.py|[^:]+\.py)/,
    });

    return grouped;
  }

  // ---------------------------------------------------------------------------
  // mypy Filter
  // ---------------------------------------------------------------------------

  private filterMypy(input: string): string {
    const lines = input.split('\n');
    const errorLines: string[] = [];

    for (const line of lines) {
      // Pattern: file.py:line[:col]: error|warning|note: message [error-code]
      if (/\.py:\d+(?::\d+)?:\s*(?:error|warning|note):/.test(line)) {
        errorLines.push(line);
      }
    }

    if (errorLines.length === 0) {
      return this.noErrorsSummary(input);
    }

    // Group by file. The alternation's first branch handles a Windows drive-letter
    // prefix (e.g. "C:\proj\file.py") so grouping doesn't stop at the drive colon.
    const grouped = this.groupStrategy.apply(errorLines.join('\n'), {
      groupKey: /^([A-Za-z]:[^:]*\.py|[^:]+\.py)/,
    });

    // Summarize by severity actually present — a run with only notes/warnings and no
    // errors must not be reported as "Found 0 errors" (misleading: implies a clean run).
    const errorCount = errorLines.filter((l) => /:\s*error:/.test(l)).length;
    const warningCount = errorLines.filter((l) => /:\s*warning:/.test(l)).length;
    const noteCount = errorLines.filter((l) => /:\s*note:/.test(l)).length;
    const parts = [
      errorCount > 0 ? `${errorCount} error${errorCount !== 1 ? 's' : ''}` : null,
      warningCount > 0 ? `${warningCount} warning${warningCount !== 1 ? 's' : ''}` : null,
      noteCount > 0 ? `${noteCount} note${noteCount !== 1 ? 's' : ''}` : null,
    ].filter((p): p is string => p !== null);

    return `Found ${parts.join(', ')}:\n\n${grouped}`;
  }

  // ---------------------------------------------------------------------------
  // Generic Fallback Filter
  // ---------------------------------------------------------------------------

  private filterGeneric(input: string): string {
    const lines = input.split('\n');
    const errorLines: string[] = [];

    for (const line of lines) {
      if (this.isErrorOrWarningLine(line) && !this.isPassLine(line)) {
        errorLines.push(line);
      }
    }

    if (errorLines.length === 0) {
      return this.noErrorsSummary(input);
    }

    return errorLines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isErrorOrWarningLine(line: string): boolean {
    return /\b(error|warning|Error|Warning|ERROR|WARNING|FAIL|FAILED|fatal|FATAL)\b/.test(line);
  }

  private isPassLine(line: string): boolean {
    return /✓|✔/.test(line) ||
      /0 problems/.test(line) ||
      /0 errors/.test(line) ||
      /All checks passed/i.test(line) ||
      /no (issues|errors|warnings|problems)/i.test(line);
  }

  private noErrorsSummary(input: string): string {
    // Extract any summary line from the input
    const lines = input.split('\n');
    const summaryLine = lines.find(
      (l) =>
        /\d+\s*(errors?|warnings?|problems?|issues?)/i.test(l) ||
        /found\s+\d+/i.test(l) ||
        /check/i.test(l),
    );

    if (summaryLine) {
      return `[LINT OK] ${summaryLine.trim()}`;
    }

    return '[LINT OK] No errors or warnings found';
  }
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

type LinterType = 'tsc' | 'eslint' | 'biome' | 'ruff-pylint-flake8' | 'mypy' | 'unknown';
