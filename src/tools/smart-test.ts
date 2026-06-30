/**
 * smart_test — MCP tool that executes test commands and returns structured, actionable output.
 *
 * Pipeline: execute command → combine output → apply TestResultFilter → log metrics → return response
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { z } from 'zod';
import type {
  ResolvedConfig,
  ToolResponse,
  SmartTestParams,
  MetricsEntry,
} from '../types.js';
import type { CommandExecutor } from '../executor.js';
import type { MetricsLogger } from '../metrics.js';
import { TestResultFilter } from '../strategies/test-result-filter.js';

/**
 * Zod schema for smart_test tool parameters.
 * Used by the MCP server to validate incoming tool calls.
 */
export const smartTestSchema = {
  command: z.string().describe('Test command to execute'),
  cwd: z.string().optional().describe('Working directory'),
  show_passes: z.boolean().optional().describe('Include individual passing tests in output'),
  show_coverage: z.boolean().optional().describe('Include coverage table if present'),
  filter_level: z.enum(['normal', 'aggressive', 'passthrough']).optional().describe('Filter aggressiveness. Use "passthrough" to get the full raw test output without filtering'),
};

/**
 * Handle a smart_test tool invocation.
 *
 * Orchestrates the pipeline:
 * 1. Execute the test command via CommandExecutor
 * 2. Combine stdout+stderr as rawOutput
 * 3. Apply TestResultFilter with options derived from params and config
 * 4. Calculate savings metrics
 * 5. Log metrics via MetricsLogger
 * 6. Return ToolResponse with filtered output and _meta
 *
 * @param params - Validated tool parameters
 * @param config - Already-loaded ResolvedConfig
 * @param executor - CommandExecutor instance
 * @param metricsLogger - MetricsLogger instance
 * @returns ToolResponse with filtered test results and metadata
 */
export async function handleSmartTest(
  params: SmartTestParams,
  config: ResolvedConfig,
  executor: CommandExecutor,
  metricsLogger: MetricsLogger,
): Promise<ToolResponse> {
  const {
    command,
    cwd = process.cwd(),
    show_passes: showPasses = false,
    show_coverage: showCoverage = false,
  } = params;

  // Check for passthrough mode — return raw output without filtering
  const filterLevel = (params as any).filter_level ?? 'normal';

  // Step 1: Execute the test command
  const executionResult = await executor.execute(command, {
    cwd,
    timeoutMs: 60000,
    maxOutputBytes: config.maxOutputBytes,
  });

  // Step 2: Combine stdout + stderr as rawOutput
  const rawOutput = combineOutput(executionResult.stdout, executionResult.stderr);

  // Step 3: Handle timeout case
  if (executionResult.timedOut) {
    const timeoutText = `[TIMEOUT] Test command exceeded timeout and was terminated.\n\n${rawOutput}`;
    const rawChars = timeoutText.length;

    metricsLogger.log({
      timestamp: new Date().toISOString(),
      tool: 'smart_test',
      command,
      rawChars,
      filteredChars: rawChars,
      savingsPercent: 0,
      strategy: 'timeout',
      filterLevel: 'normal',
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

  // Step 4: Handle passthrough mode — return raw output without filtering
  if (filterLevel === 'passthrough') {
    const cappedOutput = rawOutput.length > config.maxOutputBytes
      ? rawOutput.slice(0, config.maxOutputBytes)
      : rawOutput;

    metricsLogger.log({
      timestamp: new Date().toISOString(),
      tool: 'smart_test',
      command,
      rawChars: rawOutput.length,
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
        rawChars: rawOutput.length,
        filteredChars: cappedOutput.length,
      },
    };
  }

  // Step 5: Apply TestResultFilter strategy
  const filterStart = Date.now();
  const testFilter = new TestResultFilter();

  const filteredOutput = testFilter.apply(rawOutput, {
    showPasses,
    showCoverage,
    maxStackFrames: config.testMaxStackFrames,
    exitCode: executionResult.exitCode,
  });

  const filterDurationMs = Date.now() - filterStart;

  // Step 5: Calculate savings metrics
  const rawChars = rawOutput.length;
  const filteredChars = filteredOutput.length;
  const savingsPercent =
    rawChars > 0
      ? Math.round(((rawChars - filteredChars) / rawChars) * 1000) / 10
      : 0;

  // Step 6: Log metrics
  const metricsEntry: MetricsEntry = {
    timestamp: new Date().toISOString(),
    tool: 'smart_test',
    command,
    rawChars,
    filteredChars,
    savingsPercent,
    strategy: 'test-result',
    filterLevel: 'normal',
    exitCode: executionResult.exitCode,
    filterDurationMs,
  };
  metricsLogger.log(metricsEntry);

  // Step 7: Return ToolResponse
  return {
    content: [{ type: 'text', text: filteredOutput }],
    _meta: {
      exitCode: executionResult.exitCode,
      savingsPercent,
      filterDurationMs,
      strategy: 'test-result',
      rawChars,
      filteredChars,
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
