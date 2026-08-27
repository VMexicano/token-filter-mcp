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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ConfigLoader } from './config.js';
import { CommandExecutor } from './executor.js';
import { CommandDetector } from './detector.js';
import { FilterEngine } from './filter-engine.js';
import { MetricsLogger } from './metrics.js';
import { UiDumpFilter } from './strategies/ui-dump-filter.js';

import { filteredShellSchema, handleFilteredShell } from './tools/filtered-shell.js';
import { handleFilteredRead } from './tools/filtered-read.js';
import { handleFilteredGrep } from './tools/filtered-grep.js';
import { smartTestSchema, handleSmartTest } from './tools/smart-test.js';
import { smartGitSchema, handleSmartGit } from './tools/smart-git.js';
import { smartAdbSchema, handleSmartAdb } from './tools/smart-adb.js';
import { metricsSummarySchema, handleMetricsSummary } from './tools/metrics-summary.js';

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

/**
 * Surfaced to every connected client as global, always-on server guidance
 * (no per-project CLAUDE.md needed). Written imperatively so the assistant
 * treats these as default behavior, not optional tips.
 */
const SERVER_INSTRUCTIONS = `
Use these tools BY DEFAULT instead of raw shell/git/adb commands, in any project, without being asked — they cut 60-99% of the tokens a raw command would otherwise cost, with zero loss of actionable information (errors/failures are always preserved).

- Prefer filtered_shell over a raw shell/Bash tool call for ANY command whose output you don't already know is tiny.
- Prefer smart_git over raw "git status/diff/log/commit/push/..." — compact by construction.
- Prefer smart_test over running a test command directly.
- Prefer smart_adb over "adb shell screencap" + reading a screenshot with vision whenever you are driving an Android emulator or device (debugging an app, exploring a UI, filling a form, navigating screens). Call smart_adb with operation "dump" to see what's on screen as compact text (resource-id, text, clickable, tap-center), and operation "tap" to tap an element by resource_id/text/content_desc directly — this replaces the "screenshot -> vision -> guess coordinates -> tap -> screenshot again" loop with cheap structured text and removes the need to interpret images at all. Only fall back to a screenshot + vision when smart_adb "dump" returns no actionable elements (e.g. a map/canvas/game view with no accessibility tree). For key input, use smart_adb operation "key" with a symbolic KEYCODE_* name only — never send a raw numeric keycode (numeric codes like "6" map to dangerous actions such as KEYCODE_ENDCALL).
- Use metrics_summary to check actual token savings on demand instead of reading ~/.config/token-filter-mcp/metrics.jsonl by hand.
`.trim();
const SERVER_VERSION = (() => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
})();

async function main(): Promise<void> {
  // Instantiate shared dependencies
  const configLoader = new ConfigLoader();
  const executor = new CommandExecutor();
  const detector = new CommandDetector();
  const filterEngine = new FilterEngine();
  filterEngine.registerStrategy('UiDumpFilter', new UiDumpFilter());

  // Create the MCP server
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

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
  // Register tool: smart_adb
  // =========================================================================
  server.tool(
    'smart_adb',
    'Drive an Android emulator/device via the accessibility tree instead of screenshots + vision. ' +
      '"dump" returns the current screen as a compact list of actionable elements (resource-id, text, ' +
      'clickable, tap-center coordinates) parsed from `uiautomator dump` — use this to see what\'s on ' +
      'screen instead of taking a screenshot. "tap" locates an element by resource_id/text/content_desc ' +
      'and taps its computed center directly. "tap_xy" taps raw coordinates (last resort, when dump found ' +
      'nothing — e.g. a map/canvas/game view). "key" sends a symbolic KEYCODE_* keyevent (raw numeric ' +
      'keycodes are rejected — a raw "6" is KEYCODE_ENDCALL and silently turns the screen off). "type" ' +
      'sends text to the currently focused field. "swipe" swipes from (start_x,start_y) to (end_x,end_y). ' +
      '"long_press" long-presses a locator (resource_id/text/content_desc) or raw x/y. "install" installs an ' +
      'APK from a local path. "uninstall" removes an app by package name. "logcat" dumps recent logcat output ' +
      'pre-filtered to noteworthy (error/warning/fatal/assert level, plus known failure patterns) lines only, ' +
      'for debugging an app without paging through the full log. ' +
      'Use this proactively any time you are debugging, exploring, or automating an Android app running in an emulator.',
    smartAdbSchema,
    async (params) => {
      const result = await handleSmartAdb(params);
      return {
        content: result.content,
      };
    },
  );

  // =========================================================================
  // Register tool: metrics_summary
  // =========================================================================
  server.tool(
    'metrics_summary',
    'Summarize the token-filter-mcp metrics log (~/.config/token-filter-mcp/metrics.jsonl): total invocations, ' +
      'raw vs filtered chars, overall savings percent, and a per-tool breakdown sorted by chars saved. ' +
      'Use this instead of reading the JSONL file by hand to check how much token-filter-mcp has actually saved.',
    metricsSummarySchema,
    async (params) => {
      const result = await handleMetricsSummary(params);
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
