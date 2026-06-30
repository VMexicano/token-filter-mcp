#!/usr/bin/env node
/**
 * Token Filter MCP Server — Entry point
 *
 * Initializes the MCP server with stdio transport and registers all 5 tools:
 * - filtered_shell: Execute shell commands with intelligent output filtering
 * - filtered_read: Read files with reduction modes (full, signatures, relevant)
 * - filtered_grep: Search patterns with grouping and deduplication
 * - smart_test: Execute test commands with structured output
 * - smart_git: Git operations with compact, optimized output
 *
 * All diagnostic output goes to stderr — stdout is reserved for MCP JSON-RPC.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ConfigLoader } from './config.js';
import { CommandExecutor } from './executor.js';
import { CommandDetector } from './detector.js';
import { FilterEngine } from './filter-engine.js';
import { MetricsLogger } from './metrics.js';

import { filteredShellSchema, handleFilteredShell } from './tools/filtered-shell.js';
import { handleFilteredRead } from './tools/filtered-read.js';
import { handleFilteredGrep } from './tools/filtered-grep.js';
import { smartTestSchema, handleSmartTest } from './tools/smart-test.js';
import { smartGitSchema, handleSmartGit } from './tools/smart-git.js';

// =============================================================================
// Redirect all diagnostic output to stderr (Requirement 11.4)
// =============================================================================

// Override console.log to use stderr so no diagnostic output leaks to stdout
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  console.error(...args);
};

// =============================================================================
// Server initialization
// =============================================================================

const SERVER_NAME = 'token-filter-mcp';
const SERVER_VERSION = '1.0.0';

async function main(): Promise<void> {
  // Instantiate shared dependencies
  const configLoader = new ConfigLoader();
  const executor = new CommandExecutor();
  const detector = new CommandDetector();
  const filterEngine = new FilterEngine();

  // Create the MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // =========================================================================
  // Register tool: filtered_shell
  // =========================================================================
  server.tool(
    'filtered_shell',
    'Execute a shell command with intelligent output filtering. Detects command type and applies the optimal filter strategy to reduce token consumption while preserving all actionable information (errors, failures, changes).',
    filteredShellSchema,
    async (params) => {
      const config = configLoader.load(params.cwd ?? process.cwd());
      const metricsLogger = new MetricsLogger(config.metrics);

      const result = await handleFilteredShell(
        params,
        config,
        executor,
        detector,
        filterEngine,
        metricsLogger,
      );

      return {
        content: result.content,
      };
    },
  );

  // =========================================================================
  // Register tool: filtered_read
  // =========================================================================
  server.tool(
    'filtered_read',
    'Read a file with intelligent reduction. Modes: "full" (collapses blanks, licenses, imports), "signatures" (extracts declarations only), "relevant" (focus pattern with ±10 lines context).',
    {
      path: z.string().describe('Absolute or relative path to the file to read'),
      mode: z
        .enum(['full', 'signatures', 'relevant'])
        .optional()
        .describe('Reading mode: full (optimized), signatures (declarations only), or relevant (focus-based)'),
      focus: z
        .string()
        .optional()
        .describe('Pattern to search for in relevant mode (string or regex)'),
      start_line: z
        .number()
        .int()
        .optional()
        .describe('Start line number (1-based) for partial reads'),
      end_line: z
        .number()
        .int()
        .optional()
        .describe('End line number (1-based, inclusive) for partial reads'),
    },
    async (params) => {
      const result = handleFilteredRead({
        ...params,
        mode: params.mode ?? 'full',
      });
      return {
        content: result.content,
      };
    },
  );

  // =========================================================================
  // Register tool: filtered_grep
  // =========================================================================
  server.tool(
    'filtered_grep',
    'Search for regex patterns in a directory with results grouped by file or match, deduplicated with [×N] prefix. Uses ripgrep when available, falls back to native recursive search.',
    {
      pattern: z.string().describe('Regex pattern to search for (required)'),
      path: z.string().describe('Directory path to search in (required)'),
      include: z.string().optional().describe('Glob pattern for files to include (default: *)'),
      exclude: z.string().optional().describe('Glob pattern for files/dirs to exclude (default: node_modules,dist,.git)'),
      max_results: z.number().optional().describe('Maximum number of results to return (default: 20)'),
      group_by: z.enum(['file', 'match']).optional().describe('Group results by file or by match content (default: file)'),
      context_lines: z.number().optional().describe('Number of context lines around each match (default: 2)'),
    },
    async (params) => {
      const result = await handleFilteredGrep(params, executor);
      return {
        content: result.content,
      };
    },
  );

  // =========================================================================
  // Register tool: smart_test
  // =========================================================================
  server.tool(
    'smart_test',
    'Execute a test command and return structured, actionable output. Shows only failures by default (name, location, error, expected/received, truncated stack). Detects Jest/Vitest/pytest/cargo-test/go-test automatically.',
    smartTestSchema,
    async (params) => {
      const config = configLoader.load(params.cwd ?? process.cwd());
      const metricsLogger = new MetricsLogger(config.metrics);

      const result = await handleSmartTest(params, config, executor, metricsLogger);
      return {
        content: result.content,
      };
    },
  );

  // =========================================================================
  // Register tool: smart_git
  // =========================================================================
  server.tool(
    'smart_git',
    'Execute git operations with compact, optimized output. Supports: status (compact summary), diff (filtered hunks), log (one-line format), and action commands (commit/push/pull/add/branch with minimal confirmation).',
    smartGitSchema,
    async (params) => {
      const config = configLoader.load(params.cwd ?? process.cwd());
      const metricsLogger = new MetricsLogger(config.metrics);

      const result = await handleSmartGit(params, config, executor, metricsLogger);
      return {
        content: result.content,
      };
    },
  );

  // =========================================================================
  // Connect to stdio transport and start
  // =========================================================================
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup confirmation to stderr (never stdout)
  console.error(`[${SERVER_NAME}] Server started (v${SERVER_VERSION})`);
}

// Run the server
main().catch((error) => {
  console.error(`[${SERVER_NAME}] Fatal error:`, error);
  process.exit(1);
});
