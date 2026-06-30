/**
 * ConfigLoader - Hierarchical configuration loading for Token Filter MCP
 *
 * Searches for configuration in this order (later overrides earlier):
 * 1. Hardcoded defaults
 * 2. Global config: ~/.config/token-filter-mcp/config.json
 * 3. Project config: <cwd>/.token-filter.json
 *
 * Merge is property-level (not full object replacement).
 * Invalid JSON is skipped gracefully with a warning to stderr.
 * No caching — reloads on every invocation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ResolvedConfig, CommandOverride, FilterLevel } from './types.js';

/**
 * Shape of the JSON configuration file (snake_case keys).
 */
interface TokenFilterConfig {
  defaults?: {
    max_output_lines?: number;
    max_output_bytes?: number;
    test_show_passes?: boolean;
    test_max_stack_frames?: number;
    git_log_max?: number;
    diff_context_lines?: number;
    dedup_threshold?: number;
    grep_max_results?: number;
  };
  commands?: Record<string, {
    filter?: string;
    filter_level?: string;
    options?: Record<string, unknown>;
  }>;
  metrics?: {
    enabled?: boolean;
    max_file_size_mb?: number;
    max_files?: number;
  };
}

/** Hardcoded default configuration values */
const DEFAULT_CONFIG: ResolvedConfig = {
  maxOutputLines: 100,
  maxOutputBytes: 204800,
  testShowPasses: false,
  testMaxStackFrames: 5,
  gitLogMax: 15,
  diffContextLines: 3,
  dedupThreshold: 3,
  grepMaxResults: 20,
  metrics: {
    enabled: true,
    maxFileSizeMb: 5,
    maxFiles: 5,
  },
  commands: {},
};

/**
 * ConfigLoader loads and merges configuration from multiple sources.
 * Each call to load() re-reads from disk (no caching).
 */
export class ConfigLoader {
  /**
   * Load configuration by merging: defaults ← global config ← project config.
   * @param cwd - The current working directory to search for project-level config.
   * @returns Fully resolved configuration.
   */
  load(cwd: string): ResolvedConfig {
    // Start with hardcoded defaults
    let config = this.cloneConfig(DEFAULT_CONFIG);

    // Layer 2: global config (~/.config/token-filter-mcp/config.json)
    const globalConfigPath = join(
      homedir(),
      '.config',
      'token-filter-mcp',
      'config.json'
    );
    const globalConfig = this.readConfigFile(globalConfigPath);
    if (globalConfig) {
      config = this.mergeConfig(config, globalConfig);
    }

    // Layer 3: project config (<cwd>/.token-filter.json)
    const projectConfigPath = join(cwd, '.token-filter.json');
    const projectConfig = this.readConfigFile(projectConfigPath);
    if (projectConfig) {
      config = this.mergeConfig(config, projectConfig);
    }

    return config;
  }

  /**
   * Read and parse a JSON config file. Returns null if file doesn't exist
   * or contains invalid JSON (logs warning to stderr in that case).
   */
  private readConfigFile(filePath: string): TokenFilterConfig | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as TokenFilterConfig;
      return parsed;
    } catch (error: unknown) {
      if (error instanceof Error) {
        // File not found is expected — don't warn
        const code = (error as Error & { code?: string }).code;
        if (code === 'ENOENT') {
          return null;
        }
        // Invalid JSON or other read errors — warn and skip
        console.error(
          `[token-filter-mcp] Warning: Could not load config from ${filePath}: ${error.message}`
        );
      }
      return null;
    }
  }

  /**
   * Merge a partial config (from file) into the current resolved config.
   * Merge is at property level — individual fields override, objects are merged.
   */
  private mergeConfig(base: ResolvedConfig, override: TokenFilterConfig): ResolvedConfig {
    const result = this.cloneConfig(base);

    // Merge defaults (snake_case → camelCase)
    if (override.defaults) {
      const d = override.defaults;
      if (d.max_output_lines !== undefined) result.maxOutputLines = d.max_output_lines;
      if (d.max_output_bytes !== undefined) result.maxOutputBytes = d.max_output_bytes;
      if (d.test_show_passes !== undefined) result.testShowPasses = d.test_show_passes;
      if (d.test_max_stack_frames !== undefined) result.testMaxStackFrames = d.test_max_stack_frames;
      if (d.git_log_max !== undefined) result.gitLogMax = d.git_log_max;
      if (d.diff_context_lines !== undefined) result.diffContextLines = d.diff_context_lines;
      if (d.dedup_threshold !== undefined) result.dedupThreshold = d.dedup_threshold;
      if (d.grep_max_results !== undefined) result.grepMaxResults = d.grep_max_results;
    }

    // Merge metrics (property-level)
    if (override.metrics) {
      const m = override.metrics;
      if (m.enabled !== undefined) result.metrics.enabled = m.enabled;
      if (m.max_file_size_mb !== undefined) result.metrics.maxFileSizeMb = m.max_file_size_mb;
      if (m.max_files !== undefined) result.metrics.maxFiles = m.max_files;
    }

    // Merge commands (property-level per command key)
    if (override.commands) {
      for (const [key, cmdOverride] of Object.entries(override.commands)) {
        const existing = result.commands[key] ?? {};
        const merged: CommandOverride = { ...existing };

        if (cmdOverride.filter !== undefined) merged.filter = cmdOverride.filter;
        if (cmdOverride.filter_level !== undefined) {
          merged.filterLevel = cmdOverride.filter_level as FilterLevel;
        }
        if (cmdOverride.options !== undefined) {
          merged.options = { ...(existing.options ?? {}), ...cmdOverride.options };
        }

        result.commands[key] = merged;
      }
    }

    return result;
  }

  /**
   * Deep-clone a ResolvedConfig to avoid mutations between layers.
   */
  private cloneConfig(config: ResolvedConfig): ResolvedConfig {
    return {
      maxOutputLines: config.maxOutputLines,
      maxOutputBytes: config.maxOutputBytes,
      testShowPasses: config.testShowPasses,
      testMaxStackFrames: config.testMaxStackFrames,
      gitLogMax: config.gitLogMax,
      diffContextLines: config.diffContextLines,
      dedupThreshold: config.dedupThreshold,
      grepMaxResults: config.grepMaxResults,
      metrics: {
        enabled: config.metrics.enabled,
        maxFileSizeMb: config.metrics.maxFileSizeMb,
        maxFiles: config.metrics.maxFiles,
      },
      commands: Object.fromEntries(
        Object.entries(config.commands).map(([key, cmd]) => [
          key,
          {
            ...cmd,
            options: cmd.options ? { ...cmd.options } : undefined,
          },
        ])
      ),
    };
  }
}
