import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * PackageInstallFilter — Reduces package install output to a minimal summary.
 *
 * Handles npm install, pnpm install, yarn install outputs:
 * - On success: returns "ok N packages" (1 line summary)
 * - On "up to date": returns "ok up to date"
 * - On errors/warnings (npm ERR!, npm warn, etc.): preserves those lines
 * - Omits: resolution trees, progress bars, "added" detail lines, fetch info
 *
 * The goal is to reduce verbose install output (often 50-200+ lines) to
 * 1-3 lines for success cases, while preserving full error detail.
 *
 * Validates: Requirements 6.1 (detección de tipo package_install)
 */
export class PackageInstallFilter implements FilterStrategy {
  readonly name = 'package-install';

  // Patterns for summary lines indicating success
  private static readonly ADDED_PACKAGES = /added\s+(\d+)\s+packages?/i;
  private static readonly REMOVED_PACKAGES = /removed\s+(\d+)\s+packages?/i;
  private static readonly CHANGED_PACKAGES = /changed\s+(\d+)\s+packages?/i;
  private static readonly UP_TO_DATE = /up\s+to\s+date/i;
  private static readonly ALREADY_UP_TO_DATE = /already\s+up[- ]to[- ]date/i;
  private static readonly PACKAGES_INSTALLED = /(\d+)\s+packages?\s+installed/i;
  private static readonly AUDIT_FOUND = /found\s+(\d+)\s+vulnerabilit/i;
  private static readonly INSTALL_TIME = /in\s+[\d.]+m?s/i;

  // pnpm patterns
  private static readonly PNPM_PACKAGES = /packages?\s+are\s+ready/i;
  private static readonly PNPM_PROGRESS = /Progress:/i;

  // yarn patterns
  private static readonly YARN_DONE = /Done\s+in\s+[\d.]+m?s/i;
  private static readonly YARN_SUCCESS = /success\s+Saved\s+lockfile/i;

  // Error/warning patterns that must be preserved
  private static readonly ERROR_LINE = /^npm\s+ERR!/i;
  private static readonly WARN_LINE = /^npm\s+warn/i;
  private static readonly PNPM_ERROR = /^ERR_PNPM/;
  private static readonly YARN_ERROR = /^error\s/i;
  private static readonly DEPRECATED = /deprecated/i;

  // Lines to always omit (noise)
  private static readonly PROGRESS_BAR = /[█▓░⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
  private static readonly FETCH_LINE = /^npm\s+http\s+fetch/i;
  private static readonly TIMING_LINE = /^npm\s+timing/i;
  private static readonly SILLY_LINE = /^npm\s+sill/i;
  private static readonly VERBOSE_LINE = /^npm\s+verb/i;

  apply(input: string, options: StrategyOptions): string {
    const exitCode = options.exitCode as number | undefined;

    // If exit code is non-zero, preserve error lines and warnings fully
    if (exitCode !== undefined && exitCode !== 0) {
      return this.extractErrorOutput(input);
    }

    const lines = input.split('\n');

    // Collect error/warning lines (these are always preserved)
    const errorLines = this.collectErrorLines(lines);

    // Try to extract a package count summary
    const summary = this.extractSummary(input);

    // Build the final output
    const outputParts: string[] = [];

    if (summary) {
      outputParts.push(summary);
    } else if (this.isUpToDate(input)) {
      outputParts.push('ok up to date');
    } else {
      // Fallback: couldn't parse a known summary pattern
      outputParts.push('ok install completed');
    }

    // Append audit warnings if present
    const auditMatch = PackageInstallFilter.AUDIT_FOUND.exec(input);
    if (auditMatch) {
      outputParts.push(`${auditMatch[0]}`);
    }

    // Append error/warning lines if any exist even in success
    if (errorLines.length > 0) {
      outputParts.push(...errorLines);
    }

    return outputParts.join('\n');
  }

  /**
   * Extract summary line like "ok 42 packages added" from the install output.
   */
  private extractSummary(input: string): string | null {
    const parts: string[] = [];

    const addedMatch = PackageInstallFilter.ADDED_PACKAGES.exec(input);
    if (addedMatch) {
      parts.push(`${addedMatch[1]} added`);
    }

    const removedMatch = PackageInstallFilter.REMOVED_PACKAGES.exec(input);
    if (removedMatch) {
      parts.push(`${removedMatch[1]} removed`);
    }

    const changedMatch = PackageInstallFilter.CHANGED_PACKAGES.exec(input);
    if (changedMatch) {
      parts.push(`${changedMatch[1]} changed`);
    }

    // pnpm "packages are ready" pattern
    const pnpmReady = PackageInstallFilter.PNPM_PACKAGES.exec(input);
    if (pnpmReady && parts.length === 0) {
      // Try to find a number before "packages are ready"
      const pnpmCount = /(\d+)\s+packages?\s+are\s+ready/i.exec(input);
      if (pnpmCount) {
        parts.push(`${pnpmCount[1]} packages`);
      } else {
        return 'ok packages ready';
      }
    }

    // yarn "Done in Xs" or "packages installed" pattern
    const packagesInstalled = PackageInstallFilter.PACKAGES_INSTALLED.exec(input);
    if (packagesInstalled && parts.length === 0) {
      parts.push(`${packagesInstalled[1]} packages`);
    }

    if (parts.length === 0) {
      return null;
    }

    return `ok ${parts.join(', ')}`;
  }

  /**
   * Check if the output indicates everything is already up to date.
   */
  private isUpToDate(input: string): boolean {
    return (
      PackageInstallFilter.UP_TO_DATE.test(input) ||
      PackageInstallFilter.ALREADY_UP_TO_DATE.test(input)
    );
  }

  /**
   * Collect error and warning lines that should be preserved.
   */
  private collectErrorLines(lines: string[]): string[] {
    const errorLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (
        PackageInstallFilter.ERROR_LINE.test(trimmed) ||
        PackageInstallFilter.WARN_LINE.test(trimmed) ||
        PackageInstallFilter.PNPM_ERROR.test(trimmed) ||
        PackageInstallFilter.YARN_ERROR.test(trimmed)
      ) {
        errorLines.push(trimmed);
      }
    }

    return errorLines;
  }

  /**
   * For non-zero exit codes: extract all error/warning content,
   * preserving the full error context for the LLM.
   */
  private extractErrorOutput(input: string): string {
    const lines = input.split('\n');
    const relevantLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip noise lines even in error output
      if (
        PackageInstallFilter.PROGRESS_BAR.test(trimmed) ||
        PackageInstallFilter.FETCH_LINE.test(trimmed) ||
        PackageInstallFilter.TIMING_LINE.test(trimmed) ||
        PackageInstallFilter.SILLY_LINE.test(trimmed) ||
        PackageInstallFilter.VERBOSE_LINE.test(trimmed)
      ) {
        continue;
      }

      relevantLines.push(line);
    }

    // If we filtered everything out, return original (safety fallback)
    if (relevantLines.length === 0) {
      return input;
    }

    return relevantLines.join('\n');
  }
}
