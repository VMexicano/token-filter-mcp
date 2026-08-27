import type { FilterStrategy, StrategyOptions } from '../types.js';

/** A single parsed `<node>` from a `uiautomator dump` accessibility tree. */
export type UiNode = Record<string, string>;

/** Tap-target center in device pixel coordinates. */
export interface UiNodeCenter {
  x: number;
  y: number;
}

/**
 * Parse every `<node ...>` tag out of a raw `uiautomator dump` XML string.
 * Hierarchy is ignored on purpose — only attributes (resource-id, text,
 * content-desc, clickable, bounds, class) matter for tap targeting.
 */
export function extractUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const nodeRegex = /<node\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = nodeRegex.exec(xml)) !== null) {
    nodes.push(parseAttrs(match[1]));
  }
  return nodes;
}

function parseAttrs(attrString: string): UiNode {
  const attrs: UiNode = {};
  const attrRegex = /([\w-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(attrString)) !== null) {
    attrs[match[1]] = decodeEntities(match[2]);
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * A node is actionable when it is directly tappable, or when it carries
 * text/resource-id/content-desc worth surfacing. Pure layout wrappers
 * (ViewGroup/FrameLayout chains with none of these) are noise.
 */
export function isActionableUiNode(node: UiNode): boolean {
  if (node.clickable === 'true') return true;
  if ((node.text ?? '').trim() !== '') return true;
  if ((node['resource-id'] ?? '').trim() !== '') return true;
  if ((node['content-desc'] ?? '').trim() !== '') return true;
  return false;
}

/** Compute the tap center from a `bounds="[x1,y1][x2,y2]"` attribute. */
export function centerOfBounds(bounds: string | undefined): UiNodeCenter | null {
  if (!bounds) return null;
  const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds);
  if (!match) return null;
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const x2 = Number(match[3]);
  const y2 = Number(match[4]);
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

/** Render a single node as one compact, human/LLM-readable line. */
export function formatUiNode(node: UiNode): string {
  const id = node['resource-id']?.trim() || '-';
  const cls = (node.class ?? '').split('.').pop() || '-';
  const clickable = node.clickable === 'true' ? 'tap' : '-';
  const bounds = node.bounds ?? '';
  const center = centerOfBounds(bounds);
  const text = node.text?.trim();
  const desc = node['content-desc']?.trim();

  const labelParts: string[] = [];
  if (text) labelParts.push(`text="${text}"`);
  if (desc) labelParts.push(`desc="${desc}"`);

  const centerPart = center ? ` center=(${center.x},${center.y})` : '';
  const labelPart = labelParts.length > 0 ? ` | ${labelParts.join(' ')}` : '';

  return `${id} | ${cls} | ${clickable} | bounds=${bounds}${centerPart}${labelPart}`;
}

/**
 * UiDumpFilter — Compacts `adb shell uiautomator dump` XML output (the Android
 * accessibility tree) into a flat list of actionable elements.
 *
 * Behavior:
 * - Parses every `<node ...>` tag regardless of nesting depth (hierarchy is
 *   irrelevant for tap targeting — only resource-id/text/bounds matter).
 * - Keeps a node when clickable="true" OR it carries non-empty text,
 *   resource-id, or content-desc. Pure layout wrappers (ViewGroup/FrameLayout
 *   chains with none of these) are discarded — they are the bulk of a raw dump.
 * - Computes the tap center from `bounds` for direct use with `input tap x y`.
 */
export class UiDumpFilter implements FilterStrategy {
  readonly name = 'ui-dump';

  apply(input: string, _options: StrategyOptions): string {
    const nodes = extractUiNodes(input);
    const kept = nodes.filter(isActionableUiNode);

    if (kept.length === 0) {
      return '(no actionable elements found in UI tree)';
    }

    const lines = kept.map(formatUiNode);
    return [`${kept.length}/${nodes.length} elements`, ...lines].join('\n');
  }
}
