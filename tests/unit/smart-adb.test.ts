import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { handleSmartAdb } from '../../src/tools/smart-adb.js';
import { execAdb } from '../../src/adb-exec.js';

vi.mock('../../src/adb-exec.js', () => ({
  execAdb: vi.fn(),
}));

const mockExecAdb = vi.mocked(execAdb);

const FIXTURE_XML =
  '<hierarchy>' +
  '<node index="0" text="" resource-id="" class="android.view.ViewGroup" clickable="false" bounds="[0,0][1280,2856]" />' +
  '<node index="1" text="" resource-id="back-btn" class="android.widget.Button" content-desc="Volver" ' +
  'clickable="true" bounds="[48,192][1232,250]" />' +
  '<node index="2" text="Entregada" resource-id="" class="android.widget.TextView" clickable="false" bounds="[1020,291][1183,340]" />' +
  '</hierarchy>';

const OK = { stdout: '', stderr: '', exitCode: 0 };

/** Simulate `uiautomator dump` + `adb pull` by writing the fixture to the requested local path. */
function mockDumpAndPull(xml: string = FIXTURE_XML) {
  mockExecAdb.mockImplementation(async (args: string[]) => {
    if (args.includes('uiautomator')) return { ...OK };
    if (args.includes('pull')) {
      writeFileSync(args[args.length - 1], xml, 'utf-8');
      return { ...OK };
    }
    return { ...OK };
  });
}

describe('smart_adb', () => {
  beforeEach(() => {
    mockExecAdb.mockReset();
  });

  describe('dump', () => {
    it('returns the filtered accessibility tree', async () => {
      mockDumpAndPull();

      const result = await handleSmartAdb({ operation: 'dump' });

      expect(result.content[0].text).toContain('back-btn');
      expect(result.content[0].text).toContain('text="Entregada"');
      expect(result.content[0].text).not.toContain('ViewGroup');
    });

    it('propagates a dump failure as an error message', async () => {
      mockExecAdb.mockResolvedValue({ stdout: '', stderr: 'device offline', exitCode: 1 });

      const result = await handleSmartAdb({ operation: 'dump' });

      expect(result.content[0].text).toContain('device offline');
    });

    it('prefixes commands with "-s <device>" when a device is given', async () => {
      mockDumpAndPull();

      await handleSmartAdb({ operation: 'dump', device: 'emulator-5554' });

      const dumpCall = mockExecAdb.mock.calls.find((call) => call[0].includes('uiautomator'));
      expect(dumpCall?.[0].slice(0, 2)).toEqual(['-s', 'emulator-5554']);
    });
  });

  describe('tap', () => {
    it('resolves resource_id to its bounds center and taps it', async () => {
      mockDumpAndPull();

      const result = await handleSmartAdb({ operation: 'tap', resource_id: 'back-btn' });

      expect(result.content[0].text).toBe('Tapped resource_id="back-btn" at (640,221)');
      const tapCall = mockExecAdb.mock.calls.find((call) => call[0].includes('tap'));
      expect(tapCall?.[0]).toEqual(['shell', 'input', 'tap', '640', '221']);
    });

    it('resolves by exact text when resource_id is absent', async () => {
      mockDumpAndPull();

      const result = await handleSmartAdb({ operation: 'tap', text: 'Entregada' });

      expect(result.content[0].text).toContain('Tapped text="Entregada" at (1102,316)');
    });

    it('reports available elements when no locator matches', async () => {
      mockDumpAndPull();

      const result = await handleSmartAdb({ operation: 'tap', resource_id: 'does-not-exist' });

      expect(result.content[0].text).toContain('No element matched resource_id="does-not-exist"');
      expect(result.content[0].text).toContain('back-btn');
    });

    it('requires at least one locator', async () => {
      const result = await handleSmartAdb({ operation: 'tap' });

      expect(result.content[0].text).toContain('requires one of resource_id, text, or content_desc');
      expect(mockExecAdb).not.toHaveBeenCalled();
    });
  });

  describe('tap_xy', () => {
    it('taps raw coordinates directly', async () => {
      mockExecAdb.mockResolvedValue({ ...OK });

      const result = await handleSmartAdb({ operation: 'tap_xy', x: 100, y: 200 });

      expect(result.content[0].text).toBe('Tapped (100,200)');
      expect(mockExecAdb).toHaveBeenCalledWith(['shell', 'input', 'tap', '100', '200'], 15000);
    });
  });

  describe('key', () => {
    it('rejects a raw numeric keycode', async () => {
      const result = await handleSmartAdb({ operation: 'key', keycode: '6' });

      expect(result.content[0].text).toContain('not an allowed keycode');
      expect(result.content[0].text).toContain('KEYCODE_ENDCALL');
      expect(mockExecAdb).not.toHaveBeenCalled();
    });

    it('rejects a symbolic keycode not on the allow-list', async () => {
      const result = await handleSmartAdb({ operation: 'key', keycode: 'KEYCODE_ENDCALL' });

      expect(result.content[0].text).toContain('not an allowed keycode');
      expect(mockExecAdb).not.toHaveBeenCalled();
    });

    it('sends an allow-listed symbolic keycode', async () => {
      mockExecAdb.mockResolvedValue({ ...OK });

      const result = await handleSmartAdb({ operation: 'key', keycode: 'KEYCODE_BACK' });

      expect(result.content[0].text).toBe('Sent KEYCODE_BACK');
      expect(mockExecAdb).toHaveBeenCalledWith(['shell', 'input', 'keyevent', 'KEYCODE_BACK'], 15000);
    });
  });

  describe('type', () => {
    it('encodes spaces as %s before sending', async () => {
      mockExecAdb.mockResolvedValue({ ...OK });

      const result = await handleSmartAdb({ operation: 'type', input_text: 'hello world' });

      expect(result.content[0].text).toBe('Typed: hello world');
      expect(mockExecAdb).toHaveBeenCalledWith(['shell', 'input', 'text', 'hello%sworld'], 15000);
    });
  });
});
