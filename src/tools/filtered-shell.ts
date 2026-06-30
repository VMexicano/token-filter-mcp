/**
 * filtered_shell — MCP tool that executes shell commands with intelligent output filtering.
 *
 * Pipeline: load config → detect command type → execute → filter → log metrics → return response
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.5, 1.6
 */

import { z } from 'zod';
import type {
  ResolvedConfig,
  ToolResponse,
  FilteredShellParams,
  MetricsEntry,
} from '../types.js';
import type { CommandExecutor } from '../executor.js';
import type { CommandDetector } from '../detector.js';
import type { FilterEngine } from '../filter-engine.js';
import type { MetricsLogger } from '../metrics.js';

/**
 * Zod schema for filtered_shell tool parameters.
 * Used by the MCP server to validate incoming tool calls.
 */
export const filteredShellSchema = {
  command: z.string().describe('Command to execute'),
  cwd: z.string().optional().describe('Working directory'),
  filter_level: z
    .enum(['normal', 'aggressive', 'passthrough'])
    .optional()
    .describe('Filter aggressiveness'),
  timeout_ms: z.number().optional().describe('Timeout in milliseconds'),
};

/**
 * Handle a filtered_shell tool invocation.
 *
 * Orchestrates the full pipeline:
 * 1. Use the provided config (already loaded by caller)
 * 2. Detect command type via CommandDetector
 * 3. Execute command via CommandExecutor
 * 4. Combine stdout+stderr as rawOutput
 * 5. Filter via FilterEngine
 * 6. Log metrics via MetricsLogger
 * 7. Return ToolResponse with filtered output text and _meta
 *
 * @param params - Validated tool parameters
 * @param config - Already-loaded ResolvedConfig
 * @param executor - CommandExecutor instance
 * @param detector - CommandDetector instance
 * @param filterEngine - FilterEngine instance
 * @param metricsLogger - MetricsLogger instance
 * @returns ToolResponse with filtered content and metadata
 */
export async function handleFilteredShell(
  params: FilteredShellParams,
  config: ResolvedConfig,
  executor: CommandExecutor,
  detector: CommandDetector,
  filterEngine: FilterEngine,
  metricsLogger: MetricsLogger,
): Promise<ToolResponse> {
  const {
    command,
    cwd = process.cwd(),
    filter_level: filterLevel = 'normal',
    timeout_ms: timeoutMs = 60000,
  } = params;

  // Step 1: Detect command type
  const detection = detector.detect(command);

  // Step 2: Execute command
  const executionResult = await executor.execute(command, {
    cwd,
    timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  });

  // Step 3: Combine stdout + stderr as rawOutput
  const rawOutput = combineOutput(executionResult.stdout, executionResult.stderr);

  // Step 4: Handle timeout case (Req 1.4)
  if (executionResult.timedOut) {
    const timeoutText = `[TIMEOUT] Command exceeded ${timeoutMs}ms and was terminated.\n\n${rawOutput}`;
    const rawChars = timeoutText.length;

    // Log metrics for timeout
    metricsLogger.log({
      timestamp: new Date().toISOString(),
      tool: 'filtered_shell',
      command,
      rawChars,
      filteredChars: rawChars,
      savingsPercent: 0,
      strategy: 'timeout',
      filterLevel,
      exitCode: executionResult.exitCode,
      filterDurationMs: 0,
    });

    return {
      content: [{ type: 'text', text: timeoutText }],
      _meta: {
        exitCode: executionResult.exitCode,
        savingsPercent: 0,
        filterDurationMs: 0,
        strategy: 'timeout',
        rawChars,
        filteredChars: rawChars,
      },
    };
  }

  // Step 5: Filter via FilterEngine
  const filterResult = filterEngine.filter({
    rawOutput,
    exitCode: executionResult.exitCode,
    commandType: detection.type,
    filterLevel,
    config,
  });

  // Step 6: Log metrics
  const metricsEntry: MetricsEntry = {
    timestamp: new Date().toISOString(),
    tool: 'filtered_shell',
    command,
    rawChars: filterResult.rawChars,
    filteredChars: filterResult.filteredChars,
    savingsPercent: filterResult.savingsPercent,
    strategy: filterResult.strategyApplied,
    filterLevel,
    exitCode: executionResult.exitCode,
    filterDurationMs: filterResult.filterDurationMs,
  };
  metricsLogger.log(metricsEntry);

  // Step 7: Return ToolResponse
  return {
    content: [{ type: 'text', text: filterResult.output }],
    _meta: {
      exitCode: executionResult.exitCode,
      savingsPercent: filterResult.savingsPercent,
      filterDurationMs: filterResult.filterDurationMs,
      strategy: filterResult.strategyApplied,
      rawChars: filterResult.rawChars,
      filteredChars: filterResult.filteredChars,
    },
  };
}

/**
 * Combine stdout and stderr into a single raw output string.
 * If both are present, stderr is appended after stdout with a separator.
 * If only one is present, return that one directly.
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
