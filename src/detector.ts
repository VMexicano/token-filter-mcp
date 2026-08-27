/**
 * Command Detector — Classifies shell commands into known types
 * and selects the appropriate filter strategy.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import type { CommandType, DetectionResult } from './types.js';

/** A single detection pattern entry */
interface PatternEntry {
  pattern: RegExp;
  type: CommandType;
  strategy: string;
  confidence: number;
}

/**
 * Ordered list of patterns — most specific first.
 * Order matters: the first match wins (Requirement 6.3).
 */
const PATTERNS: PatternEntry[] = [
  // Test runners — specific commands
  { pattern: /^(?:jest|vitest|pytest|mocha)\b/, type: 'test_runner', strategy: 'TestResultFilter', confidence: 1 },
  { pattern: /^cargo\s+test\b/, type: 'test_runner', strategy: 'TestResultFilter', confidence: 1 },
  { pattern: /^go\s+test\b/, type: 'test_runner', strategy: 'TestResultFilter', confidence: 1 },

  // Direct `test` script across package managers (npm/pnpm/yarn/bun) — Requirement 6.6
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+test\b/, type: 'test_runner', strategy: 'TestResultFilter', confidence: 1 },

  // `<pm> run *test*` across package managers — Requirement 6.6
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+run\s+\S*test\S*/i, type: 'test_runner', strategy: 'TestResultFilter', confidence: 0.85 },

  // Git — specific subcommands before generic (Requirement 6.3)
  { pattern: /^git\s+status\b/, type: 'git_status', strategy: 'GitStatusCompactFilter', confidence: 1 },
  { pattern: /^git\s+diff\b/, type: 'git_diff', strategy: 'GitDiffFilter', confidence: 1 },
  { pattern: /^git\s+log\b/, type: 'git_log', strategy: 'GitLogFilter', confidence: 1 },
  { pattern: /^git\s+(?:add|commit|push|pull|checkout|branch|merge|rebase|stash|fetch)\b/, type: 'git_action', strategy: 'GitActionFilter', confidence: 0.9 },

  // Linters / type-checkers
  { pattern: /^(?:tsc|eslint|biome|ruff|pylint|flake8)\b/, type: 'linter', strategy: 'LinterFilter', confidence: 0.9 },

  // Build tools — script-based via package managers (npm/pnpm/yarn/bun)
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+run\s+\S*build\S*/i, type: 'build_tool', strategy: 'LinterFilter', confidence: 0.85 },
  { pattern: /^(?:pnpm|yarn|bun)\s+build\b/i, type: 'build_tool', strategy: 'LinterFilter', confidence: 0.8 },

  // Build tools — native bundlers / compilers / build systems
  { pattern: /^(?:vite|rollup|esbuild|parcel|turbo|nx)\s+build\b/, type: 'build_tool', strategy: 'LinterFilter', confidence: 0.85 },
  { pattern: /^webpack\b/, type: 'build_tool', strategy: 'LinterFilter', confidence: 0.85 },
  { pattern: /^cargo\s+build\b/, type: 'build_tool', strategy: 'LinterFilter', confidence: 0.9 },
  { pattern: /^go\s+build\b/, type: 'build_tool', strategy: 'LinterFilter', confidence: 0.9 },
  { pattern: /^(?:make|cmake|gradle|\.\/gradlew|mvn)\b/, type: 'build_tool', strategy: 'LinterFilter', confidence: 0.75 },

  // Package install
  { pattern: /^npm\s+(?:install|ci)\b/, type: 'package_install', strategy: 'PackageInstallFilter', confidence: 0.9 },
  { pattern: /^pnpm\s+(?:install|add)\b/, type: 'package_install', strategy: 'PackageInstallFilter', confidence: 0.9 },
  { pattern: /^yarn\s+install\b/, type: 'package_install', strategy: 'PackageInstallFilter', confidence: 0.9 },

  // Android UI automation — uiautomator XML dump (accessibility tree via adb)
  { pattern: /\buiautomator\s+dump\b/, type: 'ui_dump', strategy: 'UiDumpFilter', confidence: 0.95 },

  // Docker
  { pattern: /^docker\b/, type: 'docker', strategy: 'FallbackFilter', confidence: 0.8 },

  // HTTP clients
  { pattern: /^(?:curl|wget|http)\b/, type: 'http_client', strategy: 'FallbackFilter', confidence: 0.8 },
];

/**
 * CommandDetector classifies a command string into a known type
 * and returns the strategy to apply for filtering its output.
 */
export class CommandDetector {
  /**
   * Normalize a command by stripping known prefixes:
   * - Leading environment variable assignments (KEY=value)
   * - `npx ` prefix
   * - `pnpm exec ` prefix
   * - `./node_modules/.bin/` prefix
   *
   * Validates: Requirement 6.2
   */
  normalize(command: string): string {
    let normalized = command.trim();

    // Strip leading env var assignments: KEY=value KEY2="value" ...
    // Matches patterns like VAR=val, VAR="val with spaces", VAR='val'
    while (/^[A-Za-z_]\w*=/.test(normalized)) {
      normalized = normalized.replace(/^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*/, '');
    }
    normalized = normalized.trim();

    // Strip `npx ` prefix
    normalized = normalized.replace(/^npx\s+/, '');

    // Strip `pnpm exec ` prefix
    normalized = normalized.replace(/^pnpm\s+exec\s+/, '');

    // Strip `./node_modules/.bin/` prefix
    normalized = normalized.replace(/^\.\/node_modules\/\.bin\//, '');

    return normalized;
  }

  /**
   * Detect the command type by normalizing the command, extracting
   * the first command before any pipe, and matching against known patterns.
   *
   * Validates: Requirements 6.1, 6.3, 6.4, 6.5, 6.6
   */
  detect(command: string): DetectionResult {
    // Step 1: Normalize prefixes
    let normalized = this.normalize(command);

    // Step 2: Handle pipes — classify based on first command (Requirement 6.5)
    const pipeIndex = normalized.indexOf('|');
    if (pipeIndex !== -1) {
      normalized = normalized.substring(0, pipeIndex).trim();
    }

    // Step 3: Match patterns in order of specificity (Requirement 6.3)
    for (const entry of PATTERNS) {
      if (entry.pattern.test(normalized)) {
        return {
          type: entry.type,
          strategy: entry.strategy,
          confidence: entry.confidence,
        };
      }
    }

    // Step 4: Fallback to unknown (Requirement 6.4)
    return {
      type: 'unknown',
      strategy: 'FallbackFilter',
      confidence: 0,
    };
  }
}
