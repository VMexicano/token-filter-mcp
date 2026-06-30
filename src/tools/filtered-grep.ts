/**
 * filtered_grep — Búsqueda con agrupación y deduplicación
 *
 * Expone una herramienta MCP que busca patrones regex en directorios,
 * agrupa resultados por archivo o por match, deduplica matches idénticos
 * con prefijo [×N], y utiliza ripgrep cuando está disponible con fallback
 * a búsqueda nativa recursiva.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import { z } from 'zod';
import { execSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CommandExecutor } from '../executor.js';
import type { ToolResponse } from '../types.js';

// =============================================================================
// Schema (Req 3.1)
// =============================================================================

export const filteredGrepSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for (required)'),
  path: z.string().describe('Directory path to search in (required)'),
  include: z.string().optional().describe('Glob pattern for files to include (default: *)'),
  exclude: z.string().optional().describe('Glob pattern for files/dirs to exclude (default: node_modules,dist,.git)'),
  max_results: z.number().optional().describe('Maximum number of results to return (default: 20)'),
  group_by: z.enum(['file', 'match']).optional().describe('Group results by file or by match content (default: file)'),
  context_lines: z.number().optional().describe('Number of context lines around each match (default: 2)'),
});

export type FilteredGrepParams = z.infer<typeof filteredGrepSchema>;

// =============================================================================
// Types
// =============================================================================

interface GrepMatch {
  file: string;
  line: number;
  content: string;
  contextBefore: string[];
  contextAfter: string[];
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Handle a filtered_grep invocation.
 *
 * @param params - Validated parameters from the MCP tool invocation
 * @param executor - CommandExecutor instance for running ripgrep
 * @returns ToolResponse with grouped, deduplicated search results
 */
export async function handleFilteredGrep(
  params: FilteredGrepParams,
  executor: CommandExecutor,
): Promise<ToolResponse> {
  const startTime = performance.now();

  const {
    pattern,
    path: searchPath,
    include = '*',
    exclude = 'node_modules,dist,.git',
    max_results = 20,
    group_by = 'file',
    context_lines = 2,
  } = params;

  // --- Validate regex (Req 3.4) ---
  try {
    new RegExp(pattern);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown regex error';
    return buildErrorResponse(
      `Invalid regex pattern: "${pattern}"\nCause: ${errorMsg}`,
    );
  }

  // --- Search for matches ---
  let matches: GrepMatch[];

  const rgAvailable = isRipgrepAvailable();
  if (rgAvailable) {
    matches = await searchWithRipgrep(
      pattern,
      searchPath,
      include,
      exclude,
      context_lines,
      executor,
    );
  } else {
    matches = await searchNative(
      pattern,
      searchPath,
      include,
      exclude,
      context_lines,
    );
  }

  // --- No results (Req 3.5) ---
  if (matches.length === 0) {
    const filterDurationMs = performance.now() - startTime;
    const noResultMsg = [
      `No matches found for pattern: /${pattern}/`,
      `Path: ${searchPath}`,
      `Include: ${include}`,
      `Exclude: ${exclude}`,
    ].join('\n');

    return {
      content: [{ type: 'text', text: noResultMsg }],
      _meta: {
        exitCode: 0,
        savingsPercent: 0,
        filterDurationMs,
        strategy: 'filtered_grep',
        rawChars: 0,
        filteredChars: noResultMsg.length,
      },
    };
  }

  // --- Group and deduplicate (Req 3.2, 3.3) ---
  let output: string;
  if (group_by === 'file') {
    output = formatGroupedByFile(matches, max_results);
  } else {
    output = formatGroupedByMatch(matches, max_results);
  }

  const filterDurationMs = performance.now() - startTime;
  const rawChars = matches.reduce(
    (acc, m) => acc + m.content.length + m.contextBefore.join('\n').length + m.contextAfter.join('\n').length,
    0,
  );

  return {
    content: [{ type: 'text', text: output }],
    _meta: {
      exitCode: 0,
      savingsPercent: rawChars > 0
        ? Math.round(((rawChars - output.length) / rawChars) * 1000) / 10
        : 0,
      filterDurationMs,
      strategy: 'filtered_grep',
      rawChars,
      filteredChars: output.length,
    },
  };
}

// =============================================================================
// Ripgrep Detection
// =============================================================================

let _rgAvailableCache: boolean | null = null;

function isRipgrepAvailable(): boolean {
  if (_rgAvailableCache !== null) return _rgAvailableCache;

  try {
    const cmd = process.platform === 'win32' ? 'where rg' : 'which rg';
    execSync(cmd, { stdio: 'ignore' });
    _rgAvailableCache = true;
  } catch {
    _rgAvailableCache = false;
  }
  return _rgAvailableCache;
}

// =============================================================================
// Ripgrep Search (Req 3.6)
// =============================================================================

async function searchWithRipgrep(
  pattern: string,
  searchPath: string,
  include: string,
  exclude: string,
  contextLines: number,
  executor: CommandExecutor,
): Promise<GrepMatch[]> {
  // Build rg command
  const args: string[] = [
    'rg',
    '--line-number',
    '--no-heading',
    '--with-filename',
    `--context=${contextLines}`,
  ];

  // Include globs
  if (include && include !== '*') {
    for (const glob of include.split(',')) {
      args.push(`--glob=${glob.trim()}`);
    }
  }

  // Exclude globs
  if (exclude) {
    for (const glob of exclude.split(',')) {
      args.push(`--glob=!${glob.trim()}`);
    }
  }

  // Escape the pattern for shell and add it
  args.push('-e', `"${escapeShellArg(pattern)}"`);
  args.push(`"${escapeShellArg(searchPath)}"`);

  const command = args.join(' ');

  const result = await executor.execute(command, {
    cwd: searchPath,
    timeoutMs: 30000,
    maxOutputBytes: 204800,
  });

  // rg exits with 1 when no matches found (not an error)
  if (result.exitCode > 1) {
    return [];
  }

  return parseRipgrepOutput(result.stdout, searchPath, contextLines);
}

/**
 * Parse ripgrep output with context lines.
 * Format with --no-heading + --with-filename + context:
 *   file:line:content
 *   file-line-content (context lines)
 *   -- (separator between groups)
 */
function parseRipgrepOutput(
  output: string,
  basePath: string,
  _contextLines: number,
): GrepMatch[] {
  if (!output.trim()) return [];

  const matches: GrepMatch[] = [];
  const lines = output.split('\n');

  // Group lines by separator '--'
  const groups: string[][] = [];
  let currentGroup: string[] = [];

  for (const line of lines) {
    if (line === '--') {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
    } else if (line.trim() !== '') {
      currentGroup.push(line);
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  for (const group of groups) {
    // Find the actual match line(s) — denoted by `:` separator (not `-`)
    for (let i = 0; i < group.length; i++) {
      const parsed = parseRgLine(group[i]);
      if (!parsed) continue;

      if (parsed.isMatch) {
        const contextBefore: string[] = [];
        const contextAfter: string[] = [];

        // Gather context before
        for (let j = i - 1; j >= 0; j--) {
          const ctxParsed = parseRgLine(group[j]);
          if (ctxParsed && !ctxParsed.isMatch) {
            contextBefore.unshift(ctxParsed.content);
          } else {
            break;
          }
        }

        // Gather context after
        for (let j = i + 1; j < group.length; j++) {
          const ctxParsed = parseRgLine(group[j]);
          if (ctxParsed && !ctxParsed.isMatch) {
            contextAfter.push(ctxParsed.content);
          } else {
            break;
          }
        }

        matches.push({
          file: relative(basePath, parsed.file) || parsed.file,
          line: parsed.line,
          content: parsed.content,
          contextBefore,
          contextAfter,
        });
      }
    }
  }

  return matches;
}

interface ParsedRgLine {
  file: string;
  line: number;
  content: string;
  isMatch: boolean;
}

/**
 * Parse a single ripgrep output line.
 * Match lines use `:` as separator: file:line:content
 * Context lines use `-` as separator: file-line-content
 */
function parseRgLine(rawLine: string): ParsedRgLine | null {
  // Try match line pattern (file:lineNum:content)
  const matchRegex = /^(.+?):(\d+):(.*)$/;
  const matchResult = matchRegex.exec(rawLine);
  if (matchResult) {
    return {
      file: matchResult[1],
      line: parseInt(matchResult[2], 10),
      content: matchResult[3],
      isMatch: true,
    };
  }

  // Try context line pattern (file-lineNum-content)
  const contextRegex = /^(.+?)-(\d+)-(.*)$/;
  const contextResult = contextRegex.exec(rawLine);
  if (contextResult) {
    return {
      file: contextResult[1],
      line: parseInt(contextResult[2], 10),
      content: contextResult[3],
      isMatch: false,
    };
  }

  return null;
}

// =============================================================================
// Native Recursive Search (Fallback) (Req 3.6)
// =============================================================================

async function searchNative(
  pattern: string,
  searchPath: string,
  include: string,
  exclude: string,
  contextLines: number,
): Promise<GrepMatch[]> {
  const regex = new RegExp(pattern);
  const excludePatterns = exclude.split(',').map(p => p.trim()).filter(Boolean);
  const includePatterns = include === '*' ? [] : include.split(',').map(p => p.trim()).filter(Boolean);

  const files = await collectFiles(searchPath, excludePatterns, includePatterns);
  const matches: GrepMatch[] = [];

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const fileLines = content.split('\n');
      const relPath = relative(searchPath, filePath) || filePath;

      for (let i = 0; i < fileLines.length; i++) {
        if (regex.test(fileLines[i])) {
          const contextBefore: string[] = [];
          const contextAfter: string[] = [];

          // Gather context before
          for (let j = Math.max(0, i - contextLines); j < i; j++) {
            contextBefore.push(fileLines[j]);
          }

          // Gather context after
          for (let j = i + 1; j <= Math.min(fileLines.length - 1, i + contextLines); j++) {
            contextAfter.push(fileLines[j]);
          }

          matches.push({
            file: relPath,
            line: i + 1, // 1-indexed
            content: fileLines[i],
            contextBefore,
            contextAfter,
          });
        }
      }
    } catch {
      // Skip unreadable files silently
    }
  }

  return matches;
}

/**
 * Recursively collect files in a directory, respecting include/exclude patterns.
 */
async function collectFiles(
  dirPath: string,
  excludePatterns: string[],
  includePatterns: string[],
): Promise<string[]> {
  const results: string[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);

      // Check exclude patterns
      if (matchesAnyGlob(entry.name, excludePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        const subFiles = await collectFiles(entryPath, excludePatterns, includePatterns);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        // Check include patterns (if specified)
        if (includePatterns.length === 0 || matchesAnyGlob(entry.name, includePatterns)) {
          results.push(entryPath);
        }
      }
    }
  } catch {
    // Skip directories that can't be read
  }

  return results;
}

/**
 * Simple glob matching for include/exclude patterns.
 * Supports: *.ext, exact name, prefix*, *suffix
 */
function matchesAnyGlob(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(name, pattern)) return true;
  }
  return false;
}

function matchGlob(name: string, pattern: string): boolean {
  // Exact match
  if (name === pattern) return true;

  // *.ext pattern
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1); // .ext
    return name.endsWith(ext);
  }

  // prefix* pattern
  if (pattern.endsWith('*') && !pattern.startsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }

  // *suffix pattern (not *.ext)
  if (pattern.startsWith('*') && !pattern.includes('.')) {
    const suffix = pattern.slice(1);
    return name.endsWith(suffix);
  }

  // **/ directory-anywhere pattern — match directory name
  if (pattern.startsWith('**/')) {
    return name === pattern.slice(3);
  }

  return false;
}

// =============================================================================
// Grouping & Deduplication (Req 3.2, 3.3)
// =============================================================================

/**
 * Format results grouped by file (Req 3.3).
 * Shows filename as header + indented matches with line numbers.
 */
function formatGroupedByFile(matches: GrepMatch[], maxResults: number): string {
  // Group by file
  const byFile = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const existing = byFile.get(m.file) ?? [];
    existing.push(m);
    byFile.set(m.file, existing);
  }

  const outputLines: string[] = [];
  let resultCount = 0;

  for (const [file, fileMatches] of byFile) {
    if (resultCount >= maxResults) break;

    outputLines.push(`── ${file}`);

    // Deduplicate matches with same content within this file
    const dedupedMatches = deduplicateMatches(fileMatches);

    for (const { match, count } of dedupedMatches) {
      if (resultCount >= maxResults) break;

      const prefix = count > 1 ? `[×${count}] ` : '';

      // Context before
      for (const ctxLine of match.contextBefore) {
        outputLines.push(`     ${ctxLine}`);
      }

      // Match line
      outputLines.push(`  ${prefix}${match.line}: ${match.content}`);

      // Context after
      for (const ctxLine of match.contextAfter) {
        outputLines.push(`     ${ctxLine}`);
      }

      resultCount++;
    }

    outputLines.push(''); // blank line between files
  }

  // Trim trailing blank line
  if (outputLines.at(-1) === '') {
    outputLines.pop();
  }

  return outputLines.join('\n');
}

/**
 * Format results grouped by match content (Req 3.2).
 * Groups identical match content, shows locations where each appears.
 */
function formatGroupedByMatch(matches: GrepMatch[], maxResults: number): string {
  // Group by normalized match content
  const byContent = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const key = m.content.trim();
    const existing = byContent.get(key) ?? [];
    existing.push(m);
    byContent.set(key, existing);
  }

  const outputLines: string[] = [];
  let resultCount = 0;

  for (const [content, contentMatches] of byContent) {
    if (resultCount >= maxResults) break;

    const count = contentMatches.length;
    const prefix = count > 1 ? `[×${count}] ` : '';

    outputLines.push(`${prefix}${content}`);

    // List locations
    for (const m of contentMatches) {
      outputLines.push(`    ${m.file}:${m.line}`);
    }

    outputLines.push(''); // blank line between groups
    resultCount++;
  }

  // Trim trailing blank line
  if (outputLines.at(-1) === '') {
    outputLines.pop();
  }

  return outputLines.join('\n');
}

/**
 * Deduplicate matches with identical content, preserving the first occurrence
 * and reporting count with [×N] prefix.
 */
function deduplicateMatches(matches: GrepMatch[]): Array<{ match: GrepMatch; count: number }> {
  const seen = new Map<string, { match: GrepMatch; count: number }>();

  for (const m of matches) {
    const key = m.content.trim();
    const existing = seen.get(key);
    if (existing) {
      existing.count++;
    } else {
      seen.set(key, { match: m, count: 1 });
    }
  }

  return Array.from(seen.values());
}

// =============================================================================
// Utilities
// =============================================================================

function escapeShellArg(arg: string): string {
  // Escape double quotes and backslashes for shell safety
  return arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildErrorResponse(message: string): ToolResponse {
  return {
    content: [{ type: 'text', text: message }],
    _meta: {
      exitCode: 1,
      savingsPercent: 0,
      filterDurationMs: 0,
      strategy: 'filtered_grep',
      rawChars: 0,
      filteredChars: message.length,
    },
  };
}
