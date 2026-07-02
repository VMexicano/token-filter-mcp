/**
 * Token Filter MCP Server - Shared types and interfaces
 *
 * This module defines all shared types used across the server:
 * - Core types for filtering, detection, and execution
 * - Tool parameter interfaces for the 5 MCP tools
 * - Strategy interfaces for composable filters
 * - Error patterns for zero-loss enforcement
 */

// =============================================================================
// Core Types
// =============================================================================

/** Filter intensity level applied to command output */
export type FilterLevel = 'normal' | 'aggressive' | 'passthrough';

/** Classification of detected command types */
export type CommandType =
  | 'test_runner'
  | 'git_status'
  | 'git_diff'
  | 'git_log'
  | 'git_action'
  | 'linter'
  | 'build_tool'
  | 'package_install'
  | 'docker'
  | 'http_client'
  | 'unknown';

// =============================================================================
// Execution Interfaces
// =============================================================================

/** Result of executing a shell command */
export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/** Options for command execution */
export interface ExecutionOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

// =============================================================================
// Filter Interfaces
// =============================================================================

/** Result of applying a filter strategy to raw output */
export interface FilterResult {
  output: string;
  rawChars: number;
  filteredChars: number;
  savingsPercent: number;
  strategyApplied: string;
  filterDurationMs: number;
}

/** Input to the filter engine */
export interface FilterInput {
  rawOutput: string;
  exitCode: number;
  commandType: CommandType;
  filterLevel: FilterLevel;
  config: ResolvedConfig;
}

// =============================================================================
// Detection Interfaces
// =============================================================================

/** Result of command type detection */
export interface DetectionResult {
  type: CommandType;
  strategy: string;
  confidence: number;
}

// =============================================================================
// Configuration Interfaces
// =============================================================================

/** Fully resolved configuration after merging all levels */
export interface ResolvedConfig {
  maxOutputLines: number;
  maxOutputBytes: number;
  testShowPasses: boolean;
  testMaxStackFrames: number;
  gitLogMax: number;
  diffContextLines: number;
  dedupThreshold: number;
  grepMaxResults: number;
  metrics: MetricsConfig;
  commands: Record<string, CommandOverride>;
}

/** Metrics subsection of configuration */
export interface MetricsConfig {
  enabled: boolean;
  maxFileSizeMb: number;
  maxFiles: number;
}

/** Per-command override in configuration */
export interface CommandOverride {
  filter?: string;
  filterLevel?: FilterLevel;
  options?: Record<string, unknown>;
}

// =============================================================================
// Metrics Interfaces
// =============================================================================

/** A single metrics log entry written as JSONL */
export interface MetricsEntry {
  timestamp: string;
  tool: string;
  command?: string;
  rawChars: number;
  filteredChars: number;
  savingsPercent: number;
  strategy: string;
  filterLevel: FilterLevel;
  exitCode: number;
  filterDurationMs: number;
}

// =============================================================================
// MCP Response Interface
// =============================================================================

/** Standard MCP tool response envelope */
export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  _meta?: {
    exitCode: number;
    savingsPercent: number;
    filterDurationMs: number;
    strategy: string;
    rawChars: number;
    filteredChars: number;
  };
}

// =============================================================================
// Tool Parameter Interfaces
// =============================================================================

/** Parameters for filtered_shell tool */
export interface FilteredShellParams {
  command: string;
  cwd?: string;
  filter_level?: FilterLevel;
  timeout_ms?: number;
}

/** Parameters for filtered_read tool */
export interface FilteredReadParams {
  path: string;
  mode?: 'full' | 'signatures' | 'relevant';
  focus?: string;
  start_line?: number;
  end_line?: number;
}

/** Parameters for filtered_grep tool */
export interface FilteredGrepParams {
  pattern: string;
  path: string;
  include?: string;
  exclude?: string;
  max_results?: number;
  group_by?: 'file' | 'match';
  context_lines?: number;
}

/** Parameters for smart_test tool */
export interface SmartTestParams {
  command: string;
  cwd?: string;
  show_passes?: boolean;
  show_coverage?: boolean;
}

/** Parameters for smart_git tool */
export interface SmartGitParams {
  operation: 'status' | 'diff' | 'log' | 'commit' | 'push' | 'pull' | 'add' | 'branch';
  args?: string;
  cwd?: string;
}

// =============================================================================
// Strategy Interfaces
// =============================================================================

/** Options passed to filter strategies */
export interface StrategyOptions {
  maxLines?: number;
  keepEnd?: boolean;
  threshold?: number;
  groupKey?: RegExp;
  startMarkers?: RegExp[];
  endMarkers?: RegExp[];
  contextLines?: number;
  [key: string]: unknown;
}

/** Interface for composable filter strategies */
export interface FilterStrategy {
  name: string;
  apply(input: string, options: StrategyOptions): string;
}

// =============================================================================
// Error Patterns (Zero-Loss Markers)
// =============================================================================

/**
 * Regex patterns that identify error lines which must NEVER be removed
 * during filtering. This enforces the zero-loss invariant.
 */
export const ERROR_PATTERNS: RegExp[] = [
  /\bFAIL\b/i,
  /\bError:/,
  /\berror:/,
  /\bFAILED\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bpanic\b/,
  /\bFATAL\b/i,
  /\bCannot\b/,
  /\bTraceback\b/,
  /\bException\b/,
];
