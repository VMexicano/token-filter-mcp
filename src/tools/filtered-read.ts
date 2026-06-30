/**
 * filtered_read — MCP tool for reading files with intelligent reduction
 *
 * Modes:
 * - full: Collapses blank lines, license blocks, and large import sections
 * - signatures: Extracts function/class/type/interface declarations by language
 * - relevant: Finds focus pattern matches with ±10 lines of context
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import type { ToolResponse } from '../types.js';

// =============================================================================
// Schema
// =============================================================================

export const filteredReadSchema = z.object({
  path: z.string().describe('Absolute or relative path to the file to read'),
  mode: z
    .enum(['full', 'signatures', 'relevant'])
    .optional()
    .default('full')
    .describe('Reading mode: full (optimized), signatures (declarations only), or relevant (focus-based)'),
  focus: z
    .string()
    .optional()
    .describe('Pattern to search for in relevant mode (string or regex)'),
  start_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Start line number (1-based) for partial reads'),
  end_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('End line number (1-based, inclusive) for partial reads'),
});

export type FilteredReadParams = z.infer<typeof filteredReadSchema>;

// =============================================================================
// Main Handler
// =============================================================================

export function handleFilteredRead(params: FilteredReadParams): ToolResponse {
  const { path: filePath, mode, focus, start_line, end_line } = params;

  // Read file content
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error: unknown) {
    return buildErrorResponse(filePath, error);
  }

  // Apply line range if specified
  let lines = content.split('\n');
  if (start_line !== undefined || end_line !== undefined) {
    const start = (start_line ?? 1) - 1; // Convert to 0-based
    const end = end_line ?? lines.length;
    lines = lines.slice(start, end);
  }

  // Apply mode-specific filtering
  let output: string;
  const rawChars = content.length;

  switch (mode) {
    case 'full':
      output = applyFullMode(lines);
      break;
    case 'signatures':
      output = applySignaturesMode(lines, filePath);
      break;
    case 'relevant':
      output = applyRelevantMode(lines, focus, start_line);
      break;
    default:
      output = applyFullMode(lines);
  }

  const filteredChars = output.length;
  const savingsPercent =
    rawChars > 0 ? Math.round(((rawChars - filteredChars) / rawChars) * 1000) / 10 : 0;

  return {
    content: [{ type: 'text', text: output }],
    _meta: {
      exitCode: 0,
      savingsPercent,
      filterDurationMs: 0,
      strategy: `filtered_read:${mode}`,
      rawChars,
      filteredChars,
    },
  };
}

// =============================================================================
// Mode: full
// =============================================================================

/**
 * Full mode optimizations:
 * 1. Collapse runs of >3 blank lines to 1 blank line
 * 2. Collapse license/copyright comment blocks >5 lines to summary
 * 3. Collapse import blocks >15 consecutive lines to first + summary + last
 */
function applyFullMode(lines: string[]): string {
  let result = collapseBlankLines(lines);
  result = collapseLicenseBlocks(result);
  result = collapseImportBlocks(result);
  return result.join('\n');
}

/** Collapse runs of >3 consecutive blank lines to 1 blank line */
function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  let consecutiveBlanks = 0;

  for (const line of lines) {
    if (line.trim() === '') {
      consecutiveBlanks++;
      if (consecutiveBlanks <= 3) {
        result.push(line);
      }
      // When consecutive blanks exceed 3, only keep 1 (already added the first)
    } else {
      if (consecutiveBlanks > 3) {
        // We already pushed the first blank; remove extras and keep just 1
        while (result.length > 0 && (result.at(-1) ?? '').trim() === '') {
          result.pop();
        }
        result.push('');
      }
      consecutiveBlanks = 0;
      result.push(line);
    }
  }

  return result;
}

/** Detect and collapse license/copyright comment blocks >5 lines */
function collapseLicenseBlocks(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect start of a potential license block
    if (isLicenseBlockStart(lines[i]!)) {
      const blockStart = i;
      // Find the end of the comment block
      const blockEnd = findCommentBlockEnd(lines, i);
      const blockLength = blockEnd - blockStart + 1;

      if (blockLength > 5) {
        // Collapse to a single summary line
        result.push(`// [License block: ${blockLength} lines]`);
        i = blockEnd + 1;
      } else {
        result.push(lines[i]!);
        i++;
      }
    } else {
      result.push(lines[i]!);
      i++;
    }
  }

  return result;
}

/** Check if a line starts a license/copyright comment block */
function isLicenseBlockStart(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  // Multi-line comment with license/copyright keywords
  if (
    (trimmed.startsWith('/*') || trimmed.startsWith('/**')) &&
    (trimmed.includes('license') || trimmed.includes('copyright'))
  ) {
    return true;
  }
  // Single-line comment with license/copyright keywords
  if (
    (trimmed.startsWith('//') || trimmed.startsWith('#')) &&
    (trimmed.includes('license') || trimmed.includes('copyright'))
  ) {
    return true;
  }
  return false;
}

/** Find the end of a comment block starting at `start` */
function findCommentBlockEnd(lines: string[], start: number): number {
  const firstLine = lines[start]!.trim();

  // Multi-line comment block (/* ... */)
  if (firstLine.startsWith('/*')) {
    for (let i = start; i < lines.length; i++) {
      if (lines[i]!.includes('*/')) {
        return i;
      }
    }
    // If no closing found, treat as extending to end
    return lines.length - 1;
  }

  // Single-line comment block (// or #)
  const commentPrefix = firstLine.startsWith('//') ? '//' : '#';
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith(commentPrefix) || trimmed === '') {
      end = i;
    } else {
      break;
    }
  }
  return end;
}

/** Collapse import blocks with >15 consecutive import lines */
function collapseImportBlocks(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (isImportLine(lines[i]!)) {
      const blockStart = i;
      // Collect consecutive import lines
      while (i < lines.length && isImportLine(lines[i]!)) {
        i++;
      }
      const blockEnd = i - 1;
      const blockLength = blockEnd - blockStart + 1;

      if (blockLength > 15) {
        // Show first, summary, and last
        result.push(lines[blockStart]!);
        result.push(`... (${blockLength - 2} more imports)`);
        result.push(lines[blockEnd]!);
      } else {
        // Keep all imports
        for (let j = blockStart; j <= blockEnd; j++) {
          result.push(lines[j]!);
        }
      }
    } else {
      result.push(lines[i]!);
      i++;
    }
  }

  return result;
}

/** Check if a line is an import statement */
function isImportLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('import ') ||
    trimmed.startsWith('import{') ||
    trimmed.startsWith('from ') ||
    trimmed.startsWith('require(') ||
    trimmed.startsWith('const ') && trimmed.includes('require(') ||
    // Python
    trimmed.startsWith('from ') ||
    // Rust
    trimmed.startsWith('use ') ||
    // Go
    false // Go imports are handled via `import (` block pattern
  );
}

// =============================================================================
// Mode: signatures
// =============================================================================

/** Language-specific signature extraction patterns */
interface LanguagePatterns {
  patterns: RegExp[];
}

const TYPESCRIPT_PATTERNS: LanguagePatterns = {
  patterns: [
    /^\s*export\s+(default\s+)?(async\s+)?function\s+/,
    /^\s*export\s+(default\s+)?class\s+/,
    /^\s*export\s+(default\s+)?interface\s+/,
    /^\s*export\s+(default\s+)?type\s+/,
    /^\s*export\s+(default\s+)?enum\s+/,
    /^\s*export\s+(default\s+)?const\s+\w+\s*[=:]/,
    /^\s*(async\s+)?function\s+\w+/,
    /^\s*class\s+\w+/,
    /^\s*interface\s+\w+/,
    /^\s*type\s+\w+/,
    /^\s*enum\s+\w+/,
    /^\s*(public|private|protected|static|abstract|readonly)\s+/,
  ],
};

const PYTHON_PATTERNS: LanguagePatterns = {
  patterns: [
    /^\s*(async\s+)?def\s+\w+/,
    /^\s*class\s+\w+/,
  ],
};

const RUST_PATTERNS: LanguagePatterns = {
  patterns: [
    /^\s*(pub\s+)?(async\s+)?fn\s+\w+/,
    /^\s*(pub\s+)?struct\s+\w+/,
    /^\s*(pub\s+)?enum\s+\w+/,
    /^\s*(pub\s+)?trait\s+\w+/,
    /^\s*impl\s+/,
  ],
};

const GO_PATTERNS: LanguagePatterns = {
  patterns: [
    /^\s*func\s+/,
    /^\s*type\s+\w+/,
  ],
};

function getLanguagePatterns(filePath: string): LanguagePatterns | null {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mts':
    case '.mjs':
      return TYPESCRIPT_PATTERNS;
    case '.py':
      return PYTHON_PATTERNS;
    case '.rs':
      return RUST_PATTERNS;
    case '.go':
      return GO_PATTERNS;
    default:
      return null;
  }
}

/**
 * Signatures mode: extract function/class/type/interface declarations.
 * Returns only the signature lines (without implementation bodies).
 */
function applySignaturesMode(lines: string[], filePath: string): string {
  const langPatterns = getLanguagePatterns(filePath);

  if (!langPatterns) {
    return `[Unsupported file extension for signatures mode: ${extname(filePath)}]\n\n${lines.join('\n')}`;
  }

  const signatures: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isSignature = langPatterns.patterns.some((pattern) => pattern.test(line));

    if (isSignature) {
      signatures.push(`${i + 1}: ${line.trimEnd()}`);
    }
  }

  if (signatures.length === 0) {
    return '[No signatures found]';
  }

  return signatures.join('\n');
}

// =============================================================================
// Mode: relevant
// =============================================================================

interface MatchRegion {
  start: number;
  end: number;
}

/**
 * Relevant mode: find pattern matches with ±10 lines of context.
 * Merges overlapping regions, caps at 50 matches.
 */
function applyRelevantMode(
  lines: string[],
  focus: string | undefined,
  baseLineOffset?: number
): string {
  if (!focus) {
    return '[Error: "focus" parameter is required for relevant mode]';
  }

  // Try to interpret focus as regex; fallback to plain text search
  let pattern: RegExp;
  try {
    pattern = new RegExp(focus, 'gi');
  } catch {
    // If regex is invalid, escape it and use as plain text
    const escaped = focus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(escaped, 'gi');
  }

  // Find all match line numbers
  const matchLineNumbers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i]!)) {
      matchLineNumbers.push(i);
    }
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
  }

  if (matchLineNumbers.length === 0) {
    return `[No matches found for pattern: ${focus}]`;
  }

  // Check truncation
  const truncated = matchLineNumbers.length > 50;
  const effectiveMatches = truncated ? matchLineNumbers.slice(0, 50) : matchLineNumbers;

  // Build regions with ±10 context
  const contextSize = 10;
  const regions: MatchRegion[] = [];

  for (const lineNum of effectiveMatches) {
    const start = Math.max(0, lineNum - contextSize);
    const end = Math.min(lines.length - 1, lineNum + contextSize);
    regions.push({ start, end });
  }

  // Merge overlapping regions
  const mergedRegions = mergeRegions(regions);

  // Build output with line numbers
  const lineOffset = (baseLineOffset ?? 1) - 1; // Adjust for start_line
  const outputParts: string[] = [];

  for (const region of mergedRegions) {
    const regionLines: string[] = [];
    for (let i = region.start; i <= region.end; i++) {
      const lineNum = i + 1 + lineOffset;
      const marker = effectiveMatches.includes(i) ? '>' : ' ';
      regionLines.push(`${marker} ${lineNum}: ${lines[i]}`);
    }
    outputParts.push(regionLines.join('\n'));
  }

  let output = outputParts.join('\n\n---\n\n');

  // Add header with match count
  const header = `[${matchLineNumbers.length} match${matchLineNumbers.length === 1 ? '' : 'es'} for "${focus}"]`;
  output = header + '\n\n' + output;

  // Add truncation notice
  if (truncated) {
    output +=
      `\n\n[Truncated: showing first 50 of ${matchLineNumbers.length} matches. Use a more specific pattern.]`;
  }

  return output;
}

/** Merge overlapping or adjacent regions */
function mergeRegions(regions: MatchRegion[]): MatchRegion[] {
  if (regions.length === 0) return [];

  // Sort by start
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const merged: MatchRegion[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;

    if (current.start <= last.end + 1) {
      // Overlapping or adjacent — merge
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

// =============================================================================
// Error Handling
// =============================================================================

/** Build a structured error response for file access failures */
function buildErrorResponse(filePath: string, error: unknown): ToolResponse {
  let cause = 'Unknown error';

  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code === 'ENOENT') {
      cause = 'File not found';
    } else if (code === 'EACCES' || code === 'EPERM') {
      cause = 'Permission denied';
    } else if (code === 'EISDIR') {
      cause = 'Path is a directory, not a file';
    } else {
      cause = error.message;
    }
  }

  const errorMessage = `[Error] Cannot read file: ${filePath}\nCause: ${cause}`;

  return {
    content: [{ type: 'text', text: errorMessage }],
    _meta: {
      exitCode: 1,
      savingsPercent: 0,
      filterDurationMs: 0,
      strategy: 'error',
      rawChars: 0,
      filteredChars: errorMessage.length,
    },
  };
}
