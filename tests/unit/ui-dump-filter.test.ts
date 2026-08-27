import { describe, it, expect } from 'vitest';
import { UiDumpFilter } from '../../src/strategies/ui-dump-filter.js';

describe('UiDumpFilter', () => {
  const filter = new UiDumpFilter();

  it('has name "ui-dump"', () => {
    expect(filter.name).toBe('ui-dump');
  });

  it('discards layout wrappers with no text, id, or clickability', () => {
    const input = [
      '<?xml version="1.0"?><hierarchy rotation="0">',
      '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1280,2856]">',
      '<node index="0" text="" resource-id="" class="android.view.ViewGroup" clickable="false" bounds="[0,0][1280,2856]" />',
      '</node></hierarchy>',
    ].join('');

    const result = filter.apply(input, {});
    expect(result).toBe('(no actionable elements found in UI tree)');
  });

  it('keeps clickable nodes and computes the tap center from bounds', () => {
    const input =
      '<node index="1" text="" resource-id="back-btn" class="android.widget.Button" ' +
      'content-desc="Volver a mis ordenes" clickable="true" bounds="[48,192][1232,250]" />';

    const result = filter.apply(input, {});
    expect(result).toContain('back-btn');
    expect(result).toContain('Button');
    expect(result).toContain('tap');
    expect(result).toContain('center=(640,221)');
    expect(result).toContain('desc="Volver a mis ordenes"');
  });

  it('keeps non-clickable nodes that carry text', () => {
    const input =
      '<node index="2" text="Entregada" resource-id="" class="android.widget.TextView" ' +
      'clickable="false" bounds="[1020,291][1183,340]" />';

    const result = filter.apply(input, {});
    expect(result).toContain('text="Entregada"');
    expect(result.split('\n')[1]).toBe('- | TextView | - | bounds=[1020,291][1183,340] center=(1102,316) | text="Entregada"');
  });

  it('reports a kept/total element count header', () => {
    const input = [
      '<node text="" resource-id="" class="android.view.ViewGroup" clickable="false" bounds="[0,0][10,10]" />',
      '<node text="Hola" resource-id="" class="android.widget.TextView" clickable="false" bounds="[0,0][10,10]" />',
    ].join('');

    const result = filter.apply(input, {});
    expect(result.split('\n')[0]).toBe('1/2 elements');
  });
});
