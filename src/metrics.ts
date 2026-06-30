/**
 * MetricsLogger - JSONL metrics logging with file rotation
 *
 * Logs invocation metrics to ~/.config/token-filter-mcp/metrics.jsonl.
 * Implements rotation: max 5MB per file, max 5 historical files.
 * All I/O errors are swallowed silently — metrics never interrupt tool responses.
 * When metrics.enabled is false, all operations are no-ops.
 *
 * Also tracks passthrough re-invocations: detects when a tool+command combo
 * that was previously filtered is re-invoked with passthrough level.
 */

import {
  appendFileSync,
  statSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { MetricsConfig, MetricsEntry } from './types.js';

/** Filename for the active metrics log */
const METRICS_FILENAME = 'metrics.jsonl';

/**
 * MetricsLogger writes invocation metrics as JSONL and handles file rotation.
 */
export class MetricsLogger {
  private readonly config: MetricsConfig;
  private readonly metricsDir: string;
  private readonly metricsFilePath: string;

  /**
   * In-memory set of tool+command combos that have been invoked with
   * a non-passthrough filter level. Used to detect passthrough re-invocations.
   */
  private readonly filteredInvocations: Set<string> = new Set();

  constructor(config: MetricsConfig, baseDir?: string) {
    this.config = config;
    this.metricsDir = baseDir ?? join(homedir(), '.config', 'token-filter-mcp');
    this.metricsFilePath = join(this.metricsDir, METRICS_FILENAME);
  }

  /**
   * Log a metrics entry as a JSONL line.
   * No-op if metrics are disabled.
   * Silently swallows all I/O errors (Req 10.3).
   */
  log(entry: MetricsEntry): void {
    if (!this.config.enabled) {
      return;
    }

    try {
      // Ensure the metrics directory exists
      this.ensureDirectory();

      // Rotate if current file exceeds max size
      this.rotateIfNeeded();

      // Write the entry as a single JSON line
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.metricsFilePath, line, 'utf-8');

      // Track this invocation for passthrough re-invocation detection
      this.trackInvocation(entry);
    } catch {
      // Silently swallow all errors (Req 10.3)
      // Metrics failures must never interrupt tool responses
    }
  }

  /**
   * Check if this tool+command combination was previously invoked with a
   * non-passthrough filter level. Returns true if a prior filtered invocation
   * exists, indicating the user may be re-invoking with passthrough because
   * the filter was cutting relevant information (Req 10.4).
   */
  isPassthroughReInvocation(tool: string, command: string): boolean {
    if (!this.config.enabled) {
      return false;
    }
    const key = this.makeKey(tool, command);
    return this.filteredInvocations.has(key);
  }

  /**
   * Track a logged invocation. If the filter level is NOT passthrough,
   * add it to the set of previously-filtered invocations.
   */
  private trackInvocation(entry: MetricsEntry): void {
    if (entry.filterLevel !== 'passthrough') {
      const key = this.makeKey(entry.tool, entry.command ?? '');
      this.filteredInvocations.add(key);
    }
  }

  /**
   * Create a unique key for tool+command tracking.
   */
  private makeKey(tool: string, command: string): string {
    return `${tool}::${command}`;
  }

  /**
   * Ensure the metrics directory exists. Creates it recursively if needed.
   */
  private ensureDirectory(): void {
    if (!existsSync(this.metricsDir)) {
      mkdirSync(this.metricsDir, { recursive: true });
    }
  }

  /**
   * Rotate the metrics file if it exceeds the configured max size.
   * Rotation scheme:
   *   metrics.jsonl → metrics.1.jsonl
   *   metrics.1.jsonl → metrics.2.jsonl
   *   ...
   *   metrics.(maxFiles).jsonl is deleted
   */
  private rotateIfNeeded(): void {
    const maxBytes = this.config.maxFileSizeMb * 1024 * 1024;

    // Check current file size
    let currentSize = 0;
    try {
      const stats = statSync(this.metricsFilePath);
      currentSize = stats.size;
    } catch {
      // File doesn't exist yet — no rotation needed
      return;
    }

    if (currentSize < maxBytes) {
      return;
    }

    // Delete the oldest file if it exceeds maxFiles
    const oldestPath = this.numberedFilePath(this.config.maxFiles);
    try {
      unlinkSync(oldestPath);
    } catch {
      // File may not exist — that's fine
    }

    // Shift numbered files up: N → N+1
    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const from = this.numberedFilePath(i);
      const to = this.numberedFilePath(i + 1);
      try {
        renameSync(from, to);
      } catch {
        // File may not exist — skip
      }
    }

    // Rename current file to .1
    try {
      renameSync(this.metricsFilePath, this.numberedFilePath(1));
    } catch {
      // If rename fails, we'll just append to the existing file
    }
  }

  /**
   * Get the path for a numbered metrics file (e.g., metrics.1.jsonl).
   */
  private numberedFilePath(n: number): string {
    return join(this.metricsDir, `metrics.${n}.jsonl`);
  }
}
