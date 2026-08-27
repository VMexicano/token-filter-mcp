/**
 * smart_adb — MCP tool for driving an Android emulator/device without vision.
 *
 * Replaces the expensive "screenshot -> read image -> guess coordinates ->
 * tap -> screenshot again" loop with the accessibility tree: `dump` returns
 * the compact, filtered element list (see UiDumpFilter); `tap` resolves a
 * locator (resource_id/text/content_desc) to its bounds center and executes
 * the tap directly, without the caller ever handling an image.
 *
 * Safety: all adb invocations use execFile with an argv array (no shell),
 * so untrusted locator/text values can never break out into shell injection.
 * `key` only accepts symbolic KEYCODE_* names from an explicit allow-list —
 * raw numeric keycodes are rejected outright (a raw "6" is KEYCODE_ENDCALL
 * and silently turns the screen off; this class of mistake is why the
 * allow-list exists).
 */

import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolResponse } from '../types.js';
import { ERROR_PATTERNS } from '../types.js';
import { extractUiNodes, isActionableUiNode, centerOfBounds, formatUiNode } from '../strategies/ui-dump-filter.js';
import { execAdb } from '../adb-exec.js';

/** Symbolic keyevents allowed through `smart_adb` with operation "key". */
const ALLOWED_KEYCODES = new Set([
  'KEYCODE_BACK',
  'KEYCODE_HOME',
  'KEYCODE_ENTER',
  'KEYCODE_TAB',
  'KEYCODE_DEL',
  'KEYCODE_FORWARD_DEL',
  'KEYCODE_ESCAPE',
  'KEYCODE_APP_SWITCH',
  'KEYCODE_MENU',
  'KEYCODE_SPACE',
  'KEYCODE_DPAD_UP',
  'KEYCODE_DPAD_DOWN',
  'KEYCODE_DPAD_LEFT',
  'KEYCODE_DPAD_RIGHT',
  'KEYCODE_DPAD_CENTER',
  'KEYCODE_VOLUME_UP',
  'KEYCODE_VOLUME_DOWN',
  'KEYCODE_MOVE_HOME',
  'KEYCODE_MOVE_END',
  'KEYCODE_PAGE_UP',
  'KEYCODE_PAGE_DOWN',
]);

export const smartAdbSchema = {
  operation: z
    .enum(['dump', 'tap', 'tap_xy', 'key', 'type', 'swipe', 'long_press', 'install', 'uninstall', 'logcat'])
    .describe(
      'dump: return the filtered accessibility tree. tap: resolve resource_id/text/content_desc to its bounds center and tap it. ' +
        'tap_xy: tap raw coordinates (last resort). key: send a symbolic KEYCODE_* keyevent. type: send text to the focused field. ' +
        'swipe: swipe from (start_x,start_y) to (end_x,end_y). long_press: long-press a locator (resource_id/text/content_desc) or raw x/y. ' +
        'install: install an APK from a local path. uninstall: remove an app by package name. ' +
        'logcat: dump recent logcat output filtered to error/warning lines only (zero-loss: nothing else survives the filter).',
    ),
  device: z.string().optional().describe('adb device serial (from "adb devices"); omit if only one device/emulator is attached'),
  resource_id: z.string().optional().describe('For "tap"/"long_press": exact resource-id to locate (e.g. "back-btn")'),
  text: z.string().optional().describe('For "tap"/"long_press": exact visible text to locate'),
  content_desc: z.string().optional().describe('For "tap"/"long_press": exact content-desc (accessibility label) to locate'),
  x: z.number().int().optional().describe('For "tap_xy"/"long_press": x pixel coordinate'),
  y: z.number().int().optional().describe('For "tap_xy"/"long_press": y pixel coordinate'),
  keycode: z
    .string()
    .optional()
    .describe(`For "key": one of ${Array.from(ALLOWED_KEYCODES).join(', ')}. Raw numeric keycodes are rejected.`),
  input_text: z.string().optional().describe('For "type": text to send via "input text"'),
  start_x: z.number().int().optional().describe('For "swipe": starting x pixel coordinate'),
  start_y: z.number().int().optional().describe('For "swipe": starting y pixel coordinate'),
  end_x: z.number().int().optional().describe('For "swipe": ending x pixel coordinate'),
  end_y: z.number().int().optional().describe('For "swipe": ending y pixel coordinate'),
  duration_ms: z
    .number()
    .int()
    .optional()
    .describe('For "swipe" (default 300) / "long_press" (default 600): gesture duration in milliseconds'),
  apk_path: z.string().optional().describe('For "install": local filesystem path to the .apk to install'),
  package_name: z.string().optional().describe('For "uninstall": package name to remove (e.g. "com.example.app")'),
  lines: z.number().int().optional().describe('For "logcat": how many recent log lines to scan before filtering (default 500)'),
  filter_tag: z.string().optional().describe('For "logcat": restrict to a single logcat tag via "-s <tag>"'),
  timeout_ms: z.number().optional().describe('Timeout per adb invocation in milliseconds (default 15000)'),
};

interface SmartAdbParams {
  operation: 'dump' | 'tap' | 'tap_xy' | 'key' | 'type' | 'swipe' | 'long_press' | 'install' | 'uninstall' | 'logcat';
  device?: string;
  resource_id?: string;
  text?: string;
  content_desc?: string;
  x?: number;
  y?: number;
  keycode?: string;
  input_text?: string;
  start_x?: number;
  start_y?: number;
  end_x?: number;
  end_y?: number;
  duration_ms?: number;
  apk_path?: string;
  package_name?: string;
  lines?: number;
  filter_tag?: string;
  timeout_ms?: number;
}

function withDevice(device: string | undefined, args: string[]): string[] {
  return device ? ['-s', device, ...args] : args;
}

function textResponse(text: string, meta: Partial<ToolResponse['_meta']> = {}): ToolResponse {
  const rawChars = text.length;
  return {
    content: [{ type: 'text', text }],
    _meta: {
      exitCode: 0,
      savingsPercent: 0,
      filterDurationMs: 0,
      strategy: 'smart-adb',
      rawChars,
      filteredChars: rawChars,
      ...meta,
    },
  };
}

/** Pull the current UI tree from the device and parse it into nodes. */
async function fetchUiNodes(device: string | undefined, timeoutMs: number) {
  const remotePath = '//sdcard/token-filter-mcp-ui-dump.xml';
  const localPath = join(tmpdir(), `token-filter-mcp-ui-dump-${process.pid}-${Date.now()}.xml`);

  const dumpResult = await execAdb(withDevice(device, ['shell', 'uiautomator', 'dump', remotePath]), timeoutMs);
  if (dumpResult.exitCode !== 0) {
    throw new Error(`uiautomator dump failed: ${dumpResult.stderr || dumpResult.stdout}`);
  }

  const pullResult = await execAdb(withDevice(device, ['pull', remotePath, localPath]), timeoutMs);
  if (pullResult.exitCode !== 0) {
    throw new Error(`adb pull failed: ${pullResult.stderr || pullResult.stdout}`);
  }

  try {
    const xml = await readFile(localPath, 'utf-8');
    return extractUiNodes(xml);
  } finally {
    await unlink(localPath).catch(() => {});
  }
}

export async function handleSmartAdb(params: SmartAdbParams): Promise<ToolResponse> {
  const timeoutMs = params.timeout_ms ?? 15000;
  const { operation, device } = params;

  try {
    if (operation === 'dump') {
      const nodes = await fetchUiNodes(device, timeoutMs);
      const kept = nodes.filter(isActionableUiNode);
      const body =
        kept.length === 0
          ? '(no actionable elements found in UI tree)'
          : [`${kept.length}/${nodes.length} elements`, ...kept.map(formatUiNode)].join('\n');
      return textResponse(body, { strategy: 'ui-dump' });
    }

    if (operation === 'tap') {
      const { resource_id, text, content_desc } = params;
      if (!resource_id && !text && !content_desc) {
        return textResponse('Error: "tap" requires one of resource_id, text, or content_desc.');
      }

      const nodes = await fetchUiNodes(device, timeoutMs);
      const match = findNode(nodes, { resource_id, text, content_desc });

      if (!match) {
        const kept = nodes.filter(isActionableUiNode);
        const available = kept.length > 0 ? kept.map(formatUiNode).join('\n') : '(no actionable elements found)';
        return textResponse(
          `No element matched ${describeLocator({ resource_id, text, content_desc })}.\n` +
            `Currently on screen:\n${available}`,
        );
      }

      const center = centerOfBounds(match.bounds);
      if (!center) {
        return textResponse(`Matched an element but it has no usable bounds: ${formatUiNode(match)}`);
      }

      const tapResult = await execAdb(
        withDevice(device, ['shell', 'input', 'tap', String(center.x), String(center.y)]),
        timeoutMs,
      );
      if (tapResult.exitCode !== 0) {
        return textResponse(`Tap failed: ${tapResult.stderr || tapResult.stdout}`);
      }

      return textResponse(`Tapped ${describeLocator({ resource_id, text, content_desc })} at (${center.x},${center.y})`);
    }

    if (operation === 'tap_xy') {
      const { x, y } = params;
      if (x === undefined || y === undefined) {
        return textResponse('Error: "tap_xy" requires both x and y.');
      }
      const tapResult = await execAdb(withDevice(device, ['shell', 'input', 'tap', String(x), String(y)]), timeoutMs);
      if (tapResult.exitCode !== 0) {
        return textResponse(`Tap failed: ${tapResult.stderr || tapResult.stdout}`);
      }
      return textResponse(`Tapped (${x},${y})`);
    }

    if (operation === 'key') {
      const { keycode } = params;
      if (!keycode || !ALLOWED_KEYCODES.has(keycode)) {
        return textResponse(
          `Error: "${keycode ?? '(missing)'}" is not an allowed keycode. Allowed: ${Array.from(ALLOWED_KEYCODES).join(', ')}. ` +
            'Raw numeric keycodes are rejected (e.g. "6" is KEYCODE_ENDCALL and turns the screen off).',
        );
      }
      const keyResult = await execAdb(withDevice(device, ['shell', 'input', 'keyevent', keycode]), timeoutMs);
      if (keyResult.exitCode !== 0) {
        return textResponse(`Keyevent failed: ${keyResult.stderr || keyResult.stdout}`);
      }
      return textResponse(`Sent ${keycode}`);
    }

    if (operation === 'type') {
      const { input_text } = params;
      if (!input_text) {
        return textResponse('Error: "type" requires input_text.');
      }
      // Android's `input text` splits on literal spaces; %s is the standard encoding for a space.
      const encoded = input_text.replace(/ /g, '%s');
      const typeResult = await execAdb(withDevice(device, ['shell', 'input', 'text', encoded]), timeoutMs);
      if (typeResult.exitCode !== 0) {
        return textResponse(`Type failed: ${typeResult.stderr || typeResult.stdout}`);
      }
      return textResponse(`Typed: ${input_text}`);
    }

    if (operation === 'swipe') {
      const { start_x, start_y, end_x, end_y, duration_ms } = params;
      if (start_x === undefined || start_y === undefined || end_x === undefined || end_y === undefined) {
        return textResponse('Error: "swipe" requires start_x, start_y, end_x, and end_y.');
      }
      const duration = duration_ms ?? 300;
      const swipeResult = await execAdb(
        withDevice(device, ['shell', 'input', 'swipe', String(start_x), String(start_y), String(end_x), String(end_y), String(duration)]),
        timeoutMs,
      );
      if (swipeResult.exitCode !== 0) {
        return textResponse(`Swipe failed: ${swipeResult.stderr || swipeResult.stdout}`);
      }
      return textResponse(`Swiped (${start_x},${start_y}) -> (${end_x},${end_y}) over ${duration}ms`);
    }

    if (operation === 'long_press') {
      const { resource_id, text, content_desc, x, y, duration_ms } = params;
      const duration = duration_ms ?? 600;
      let px: number;
      let py: number;
      let label: string;

      if (resource_id || text || content_desc) {
        const nodes = await fetchUiNodes(device, timeoutMs);
        const match = findNode(nodes, { resource_id, text, content_desc });
        if (!match) {
          const kept = nodes.filter(isActionableUiNode);
          const available = kept.length > 0 ? kept.map(formatUiNode).join('\n') : '(no actionable elements found)';
          return textResponse(
            `No element matched ${describeLocator({ resource_id, text, content_desc })}.\n` +
              `Currently on screen:\n${available}`,
          );
        }
        const center = centerOfBounds(match.bounds);
        if (!center) {
          return textResponse(`Matched an element but it has no usable bounds: ${formatUiNode(match)}`);
        }
        px = center.x;
        py = center.y;
        label = describeLocator({ resource_id, text, content_desc });
      } else if (x !== undefined && y !== undefined) {
        px = x;
        py = y;
        label = `(${x},${y})`;
      } else {
        return textResponse('Error: "long_press" requires a locator (resource_id/text/content_desc) or x/y.');
      }

      const pressResult = await execAdb(
        withDevice(device, ['shell', 'input', 'swipe', String(px), String(py), String(px), String(py), String(duration)]),
        timeoutMs,
      );
      if (pressResult.exitCode !== 0) {
        return textResponse(`Long press failed: ${pressResult.stderr || pressResult.stdout}`);
      }
      return textResponse(`Long-pressed ${label} for ${duration}ms`);
    }

    if (operation === 'install') {
      const { apk_path } = params;
      if (!apk_path) {
        return textResponse('Error: "install" requires apk_path.');
      }
      const installResult = await execAdb(withDevice(device, ['install', '-r', apk_path]), Math.max(timeoutMs, 60000));
      if (installResult.exitCode !== 0) {
        return textResponse(`Install failed: ${installResult.stderr || installResult.stdout}`);
      }
      return textResponse(`Installed ${apk_path}: ${installResult.stdout.trim() || 'Success'}`);
    }

    if (operation === 'uninstall') {
      const { package_name } = params;
      if (!package_name) {
        return textResponse('Error: "uninstall" requires package_name.');
      }
      const uninstallResult = await execAdb(withDevice(device, ['uninstall', package_name]), timeoutMs);
      if (uninstallResult.exitCode !== 0) {
        return textResponse(`Uninstall failed: ${uninstallResult.stderr || uninstallResult.stdout}`);
      }
      return textResponse(`Uninstalled ${package_name}: ${uninstallResult.stdout.trim() || 'Success'}`);
    }

    if (operation === 'logcat') {
      const { lines, filter_tag } = params;
      const tailLines = lines ?? 500;
      const args = ['logcat', '-d', '-t', String(tailLines)];
      if (filter_tag) args.push('-s', filter_tag);

      const logResult = await execAdb(withDevice(device, args), timeoutMs);
      if (logResult.exitCode !== 0) {
        return textResponse(`Logcat failed: ${logResult.stderr || logResult.stdout}`);
      }

      const rawLines = logResult.stdout.split('\n').filter((l) => l.length > 0);
      const kept = rawLines.filter(isNoteworthyLogLine);
      const body =
        kept.length === 0
          ? `(no error/warning lines in the last ${rawLines.length} logcat lines)`
          : [`${kept.length}/${rawLines.length} lines (errors/warnings)`, ...kept].join('\n');
      return textResponse(body, { strategy: 'logcat-filter' });
    }

    return textResponse(`Error: unknown operation "${operation as string}"`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return textResponse(`Error: ${message}`);
  }
}

function findNode(
  nodes: Array<Record<string, string>>,
  locator: { resource_id?: string; text?: string; content_desc?: string },
): Record<string, string> | undefined {
  if (locator.resource_id) {
    return nodes.find((n) => n['resource-id'] === locator.resource_id);
  }
  if (locator.text) {
    const exact = nodes.find((n) => (n.text ?? '').trim() === locator.text);
    if (exact) return exact;
    return nodes.find((n) => (n.text ?? '').includes(locator.text as string));
  }
  if (locator.content_desc) {
    const exact = nodes.find((n) => (n['content-desc'] ?? '').trim() === locator.content_desc);
    if (exact) return exact;
    return nodes.find((n) => (n['content-desc'] ?? '').includes(locator.content_desc as string));
  }
  return undefined;
}

/** logcat's default "brief" format prefixes each line with a single-letter level, e.g. "W/Tag(1234): msg". */
function isNoteworthyLogLine(line: string): boolean {
  if (/^[EWF]\//.test(line)) return true;
  return ERROR_PATTERNS.some((pattern) => pattern.test(line));
}

function describeLocator(locator: { resource_id?: string; text?: string; content_desc?: string }): string {
  if (locator.resource_id) return `resource_id="${locator.resource_id}"`;
  if (locator.text) return `text="${locator.text}"`;
  if (locator.content_desc) return `content_desc="${locator.content_desc}"`;
  return '(no locator)';
}
