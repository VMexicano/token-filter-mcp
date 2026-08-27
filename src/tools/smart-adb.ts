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
    .enum(['dump', 'tap', 'tap_xy', 'key', 'type'])
    .describe(
      'dump: return the filtered accessibility tree. tap: resolve resource_id/text/content_desc to its bounds center and tap it. ' +
        'tap_xy: tap raw coordinates (last resort). key: send a symbolic KEYCODE_* keyevent. type: send text to the focused field.',
    ),
  device: z.string().optional().describe('adb device serial (from "adb devices"); omit if only one device/emulator is attached'),
  resource_id: z.string().optional().describe('For "tap": exact resource-id to locate (e.g. "back-btn")'),
  text: z.string().optional().describe('For "tap": exact visible text to locate'),
  content_desc: z.string().optional().describe('For "tap": exact content-desc (accessibility label) to locate'),
  x: z.number().int().optional().describe('For "tap_xy": x pixel coordinate'),
  y: z.number().int().optional().describe('For "tap_xy": y pixel coordinate'),
  keycode: z
    .string()
    .optional()
    .describe(`For "key": one of ${Array.from(ALLOWED_KEYCODES).join(', ')}. Raw numeric keycodes are rejected.`),
  input_text: z.string().optional().describe('For "type": text to send via "input text"'),
  timeout_ms: z.number().optional().describe('Timeout per adb invocation in milliseconds (default 15000)'),
};

interface SmartAdbParams {
  operation: 'dump' | 'tap' | 'tap_xy' | 'key' | 'type';
  device?: string;
  resource_id?: string;
  text?: string;
  content_desc?: string;
  x?: number;
  y?: number;
  keycode?: string;
  input_text?: string;
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

function describeLocator(locator: { resource_id?: string; text?: string; content_desc?: string }): string {
  if (locator.resource_id) return `resource_id="${locator.resource_id}"`;
  if (locator.text) return `text="${locator.text}"`;
  if (locator.content_desc) return `content_desc="${locator.content_desc}"`;
  return '(no locator)';
}
