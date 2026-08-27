/**
 * metrics_summary — MCP tool that aggregates the metrics.jsonl log written by
 * MetricsLogger (see ../metrics.ts) into a compact, human-readable summary.
 *
 * The log itself is append-only JSONL with size-based rotation
 * (metrics.jsonl, metrics.1.jsonl, ..., metrics.<maxFiles>.jsonl); nothing
 * previously exposed a way to query it without reading the raw file by hand.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolResponse, MetricsEntry } from '../types.js';

export const metricsSummarySchema = {
  tool: z.string().optional().describe('Restrict the summary to a single MCP tool name (e.g. "smart_git")'),
  limit: z.number().int().optional().describe('Only consider the N most recent entries (default: all available)'),
};

interface MetricsSummaryParams {
  tool?: string;
  limit?: number;
}

function metricsDir(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.config', 'token-filter-mcp');
}

/** Rotated files sort oldest-first (highest suffix), current metrics.jsonl (most recent) last. */
function orderedMetricsFiles(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => /^metrics(\.\d+)?\.jsonl$/.test(f));
  const rotated = files
    .filter((f) => f !== 'metrics.jsonl')
    .sort((a, b) => {
      const na = Number(a.match(/\.(\d+)\./)?.[1] ?? 0);
      const nb = Number(b.match(/\.(\d+)\./)?.[1] ?? 0);
      return nb - na;
    });
  return files.includes('metrics.jsonl') ? [...rotated, 'metrics.jsonl'] : rotated;
}

function readAllEntries(baseDir?: string): MetricsEntry[] {
  const dir = metricsDir(baseDir);
  if (!existsSync(dir)) return [];

  const entries: MetricsEntry[] = [];
  for (const file of orderedMetricsFiles(dir)) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as MetricsEntry);
      } catch {
        // Skip malformed lines rather than fail the whole summary
      }
    }
  }
  return entries;
}

function textResponse(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

export async function handleMetricsSummary(params: MetricsSummaryParams, baseDir?: string): Promise<ToolResponse> {
  let entries = readAllEntries(baseDir);

  if (entries.length === 0) {
    return textResponse(
      'No metrics recorded yet. Metrics are written to ~/.config/token-filter-mcp/metrics.jsonl the first ' +
        'time a filtered tool runs (unless metrics.enabled is set to false in config).',
    );
  }

  if (params.tool) {
    entries = entries.filter((e) => e.tool === params.tool);
    if (entries.length === 0) {
      return textResponse(`No metrics recorded for tool "${params.tool}".`);
    }
  }

  if (params.limit && params.limit > 0) {
    entries = entries.slice(-params.limit);
  }

  const totalRaw = entries.reduce((sum, e) => sum + e.rawChars, 0);
  const totalFiltered = entries.reduce((sum, e) => sum + e.filteredChars, 0);
  const savedChars = totalRaw - totalFiltered;
  const savingsPercent = totalRaw > 0 ? (savedChars / totalRaw) * 100 : 0;
  const estimatedTokensSaved = Math.round(savedChars / 4);

  const byTool = new Map<string, { count: number; raw: number; filtered: number }>();
  for (const e of entries) {
    const bucket = byTool.get(e.tool) ?? { count: 0, raw: 0, filtered: 0 };
    bucket.count += 1;
    bucket.raw += e.rawChars;
    bucket.filtered += e.filteredChars;
    byTool.set(e.tool, bucket);
  }

  const rows = Array.from(byTool.entries())
    .map(([tool, b]) => ({
      tool,
      count: b.count,
      saved: b.raw - b.filtered,
      pct: b.raw > 0 ? ((b.raw - b.filtered) / b.raw) * 100 : 0,
    }))
    .sort((a, b) => b.saved - a.saved);

  const firstTimestamp = entries[0]?.timestamp;
  const lastTimestamp = entries[entries.length - 1]?.timestamp;

  const lines = [
    'Token Filter Metrics Summary',
    `Invocations: ${entries.length}${firstTimestamp && lastTimestamp ? ` (${firstTimestamp} -> ${lastTimestamp})` : ''}`,
    `Chars: ${totalRaw} raw -> ${totalFiltered} filtered`,
    `Saved: ${savedChars} chars (${savingsPercent.toFixed(1)}%), ~${estimatedTokensSaved} tokens estimated (chars/4)`,
    '',
    'By tool (sorted by chars saved):',
    ...rows.map(
      (r) =>
        `  ${r.tool.padEnd(20)} ${String(r.count).padStart(5)} calls  ${String(r.saved).padStart(10)} chars saved  ${r.pct.toFixed(1)}%`,
    ),
  ];

  return textResponse(lines.join('\n'));
}
