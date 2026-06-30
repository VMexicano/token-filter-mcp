import { describe, it, expect } from 'vitest';
import { GroupStrategy } from '../../src/strategies/group.js';

describe('GroupStrategy', () => {
  const strategy = new GroupStrategy();

  it('has name "group"', () => {
    expect(strategy.name).toBe('group');
  });

  it('returns input unmodified when no groupKey is provided', () => {
    const input = 'line1\nline2\nline3';
    expect(strategy.apply(input, {})).toBe(input);
  });

  it('groups lines by regex capture group', () => {
    const input = [
      'src/utils.ts: error TS123',
      'src/utils.ts: error TS456',
      'src/index.ts: error TS789',
    ].join('\n');

    const result = strategy.apply(input, { groupKey: /^([^:]+):/ });

    expect(result).toContain('[src/utils.ts] (2 items):');
    expect(result).toContain('[src/index.ts] (1 items):');
  });

  it('places non-matching lines in "misc" group', () => {
    const input = [
      'src/a.ts: warning',
      'no match here',
      'src/a.ts: error',
    ].join('\n');

    const result = strategy.apply(input, { groupKey: /^(src\/[^:]+):/ });

    expect(result).toContain('[src/a.ts] (2 items):');
    expect(result).toContain('[misc] (1 items):');
    expect(result).toContain('  no match here');
  });

  it('sorts groups by item count descending', () => {
    const input = [
      'B: one',
      'A: one',
      'A: two',
      'A: three',
      'B: two',
      'C: one',
    ].join('\n');

    const result = strategy.apply(input, { groupKey: /^(\w+):/ });
    const lines = result.split('\n');

    // A has 3, B has 2, C has 1
    expect(lines[0]).toBe('[A] (3 items):');
    expect(lines.findIndex(l => l.startsWith('[B]'))).toBeGreaterThan(
      lines.findIndex(l => l.startsWith('[A]'))
    );
    expect(lines.findIndex(l => l.startsWith('[C]'))).toBeGreaterThan(
      lines.findIndex(l => l.startsWith('[B]'))
    );
  });

  it('limits output to 20 groups maximum', () => {
    // Create 25 distinct groups
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(`group${i}: item`);
    }
    const input = lines.join('\n');

    const result = strategy.apply(input, { groupKey: /^(group\d+):/ });

    const groupHeaders = result.split('\n').filter(l => l.match(/^\[.+\] \(\d+ items\):$/));
    expect(groupHeaders.length).toBe(20);
  });

  it('indents items with two spaces under group header', () => {
    const input = 'file.ts: error\nfile.ts: warning';
    const result = strategy.apply(input, { groupKey: /^([^:]+):/ });

    const lines = result.split('\n');
    expect(lines[0]).toBe('[file.ts] (2 items):');
    expect(lines[1]).toBe('  file.ts: error');
    expect(lines[2]).toBe('  file.ts: warning');
  });

  it('handles empty input', () => {
    const result = strategy.apply('', { groupKey: /^(\w+)/ });
    // Single empty line goes to misc
    expect(result).toContain('[misc] (1 items):');
  });
});
