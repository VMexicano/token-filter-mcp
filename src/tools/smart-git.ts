/**
 * smart_git — MCP tool for git operations with optimized, compact output.
 *
 * Routes each git operation to the appropriate filter strategy:
 * - status → GitStatusCompactFilter
 * - diff → GitDiffFilter (with contextLines from config)
 * - log → GitLogFilter (with maxLines = config.gitLogMax)
 * - commit/push/pull/add/branch → GitActionFilter (with exitCode)
 *
 * On non-zero exit code, returns raw output unchanged — the error IS
 * the actionable information (Req 5.6).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import { z } from 'zod';
import type {
  ResolvedConfig,
  ToolResponse,
  SmartGitParams,
  MetricsEntry,
  FilterLevel,
} from '../types.js';
import type { CommandExecutor } from '../executor.js';
import type { MetricsLogger } from '../metrics.js';
import { GitStatusCompactFilter } from '../strategies/git-status-filter.js';
import { GitDiffFilter } from '../strategies/git-diff-filter.js';
import { GitLogFilter } from '../strategies/git-log-filter.js';
import { GitActionFilter } from '../strategies/git-action-filter.js';

/**
 * Zod schema for smart_git tool parameters.
 * Used by the MCP server to validate incoming tool calls.
 */
export const smartGitSchema = {
  operation: z
    .enum(['status', 'diff', 'log', 'commit', 'push', 'pull', 'add', 'branch'])
    .describe('Git operation to execute'),
  args: z.string().optional().describe('Additional arguments for the git command'),
  cwd: z.string().optional().describe('Working directory'),
  filter_level: z.enum(['normal', 'aggressive', 'passthrough']).optional().describe('Filter aggressiveness. Use "passthrough" to get the full raw git output without filtering'),
};

/** Git operations that use the action filter (minimal confirmation) */
const ACTION_OPERATIONS = new Set(['commit', 'push', 'pull', 'add', 'branch']);

/**
 * Build the git command string based on operation and args.
 * Uses specialized flags for certain operations to produce parseable output.
 */
function buildGitCommand(operation: string, args?: string): string {
  switch (operation) {
    case 'status':
      return args ? `git status --porcelain ${args}` : 'git status --porcelain';
    case 'log':
      return args ? `git log --oneline ${args}` : 'git log --oneline';
    case 'diff':
      return args ? `git diff ${args}` : 'git diff';
    default:
      // commit, push, pull, add, branch
      return args ? `git ${operation} ${args}` : `git ${operation}`;
  }
}

/**
 * Handle a smart_git tool invocation.
 *
 * Pipeline:
 * 1. Build git command from operation + args
 * 2. Execute via CommandExecutor
 * 3. If exit code !== 0, return raw output (error IS actionable info)
 * 4. Route to appropriate filter strategy
 * 5. Calculate savings metrics
 * 6. Log via MetricsLogger
 * 7. Return ToolResponse
 *
 * @param params - Validated tool parameters
 * @param config - Already-loaded ResolvedConfig
 * @param executor - CommandExecutor instance
 * @param metricsLogger - MetricsLogger instance
 * @returns ToolResponse with filtered content and metadata
 */
export async function handleSmartGit(
  params: SmartGitParams,
  config: ResolvedConfig,
  executor: CommandExecutor,
  metricsLogger: MetricsLogger,
): Promise<ToolResponse> {
  const {
    operation,
    args,
    cwd = process.cwd(),
  } = params;

  // Check for passthrough mode
  const filterLevel: FilterLevel = ((params as any).filter_level ?? 'normal') as FilterLevel;

  // Step 1: Build the git command
  const command = buildGitCommand(operation, args);

  // Step 2: Execute via CommandExecutor
  const executionResult = await executor.execute(command, {
    cwd,
    timeoutMs: 60000,
    maxOutputBytes: config.maxOutputBytes,
  });

  // Step 3: Combine stdout + stderr as rawOutput
  const rawOutput = combineOutput(executionResult.stdout, executionResult.stderr);
  const rawChars = rawOutput.length;

  // Step 4: If passthrough mode, return raw output without filtering
  if (filterLevel === 'passthrough') {
    const cappedOutput = rawOutput.length > config.maxOutputBytes
      ? rawOutput.slice(0, config.maxOutputBytes)
      : rawOutput;

    metricsLogger.log({
      timestamp: new Date().toISOString(),
      tool: 'smart_git',
      command,
      rawChars,
      filteredChars: cappedOutput.length,
      savingsPercent: 0,
      strategy: 'passthrough',
      filterLevel: 'passthrough',
      exitCode: executionResult.exitCode,
      filterDurationMs: 0,
    });

    return {
      content: [{ type: 'text', text: cappedOutput }],
      _meta: {
        exitCode: executionResult.exitCode,
        savingsPercent: 0,
        filterDurationMs: 0,
        strategy: 'passthrough',
        rawChars,
        filteredChars: cappedOutput.length,
      },
    };
  }

  // Step 5: If exit code !== 0, return raw output — error IS the actionable info (Req 5.6)
  if (executionResult.exitCode !== 0) {
    metricsLogger.log({
      timestamp: new Date().toISOString(),
      tool: 'smart_git',
      command,
      rawChars,
      filteredChars: rawChars,
      savingsPercent: 0,
      strategy: 'raw-error',
      filterLevel,
      exitCode: executionResult.exitCode,
      filterDurationMs: 0,
    });

    return {
      content: [{ type: 'text', text: rawOutput }],
      _meta: {
        exitCode: executionResult.exitCode,
        savingsPercent: 0,
        filterDurationMs: 0,
        strategy: 'raw-error',
        rawChars,
        filteredChars: rawChars,
      },
    };
  }

  // Step 5: Route to appropriate filter strategy
  const filterStart = Date.now();
  const { filteredOutput, strategyName } = applyStrategy(operation, rawOutput, config);
  const filterDurationMs = Date.now() - filterStart;

  const filteredChars = filteredOutput.length;

  // Step 6: Calculate savings
  const savingsPercent = rawChars > 0
    ? Math.round(((rawChars - filteredChars) / rawChars) * 1000) / 10
    : 0;

  // Step 7: Log metrics
  const metricsEntry: MetricsEntry = {
    timestamp: new Date().toISOString(),
    tool: 'smart_git',
    command,
    rawChars,
    filteredChars,
    savingsPercent,
    strategy: strategyName,
    filterLevel,
    exitCode: executionResult.exitCode,
    filterDurationMs,
  };
  metricsLogger.log(metricsEntry);

  // Step 8: Return ToolResponse
  return {
    content: [{ type: 'text', text: filteredOutput }],
    _meta: {
      exitCode: executionResult.exitCode,
      savingsPercent,
      filterDurationMs,
      strategy: strategyName,
      rawChars,
      filteredChars,
    },
  };
}

/**
 * Apply the appropriate filter strategy based on the git operation.
 */
function applyStrategy(
  operation: string,
  rawOutput: string,
  config: ResolvedConfig,
): { filteredOutput: string; strategyName: string } {
  if (operation === 'status') {
    const filter = new GitStatusCompactFilter();
    return {
      filteredOutput: filter.apply(rawOutput, {}),
      strategyName: filter.name,
    };
  }

  if (operation === 'diff') {
    const filter = new GitDiffFilter();
    return {
      filteredOutput: filter.apply(rawOutput, { contextLines: config.diffContextLines }),
      strategyName: filter.name,
    };
  }

  if (operation === 'log') {
    const filter = new GitLogFilter();
    return {
      filteredOutput: filter.apply(rawOutput, { maxLines: config.gitLogMax }),
      strategyName: filter.name,
    };
  }

  if (ACTION_OPERATIONS.has(operation)) {
    const filter = new GitActionFilter();
    return {
      filteredOutput: filter.apply(rawOutput, { exitCode: 0 }),
      strategyName: filter.name,
    };
  }

  // Fallback: return raw output unchanged
  return {
    filteredOutput: rawOutput,
    strategyName: 'raw',
  };
}

/**
 * Combine stdout and stderr into a single raw output string.
 * If both are present, stderr is appended after stdout with a separator.
 */
function combineOutput(stdout: string, stderr: string): string {
  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;

  if (hasStdout && hasStderr) {
    return `${stdout}\n${stderr}`;
  }
  if (hasStdout) {
    return stdout;
  }
  if (hasStderr) {
    return stderr;
  }
  return '';
}
