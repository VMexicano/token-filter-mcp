import { describe, it, expect } from 'vitest';
import { LinterFilter } from '../../src/strategies/linter-filter.js';

describe('LinterFilter', () => {
  const filter = new LinterFilter();
  const apply = (input: string) => filter.apply(input, {});

  describe('mypy', () => {
    it('keeps only error/warning/note lines, grouped by file', () => {
      const input = [
        'Success: no issues found in 1 source file', // unrelated noise from a prior run, should not leak through
        'app/models.py:12: error: Incompatible return value type (got "int", expected "str")  [return-value]',
        'app/models.py:20: note: Revealed type is "builtins.int"',
        'app/views.py:5: error: Name "foo" is not defined  [name-defined]',
        'Found 2 errors in 2 files (checked 10 source files)',
      ].join('\n');

      const result = apply(input);

      expect(result).toContain('Found 2 errors');
      expect(result).toContain('app/models.py');
      expect(result).toContain('app/views.py');
      expect(result).toContain('Incompatible return value type');
      expect(result).toContain('Name "foo" is not defined');
    });

    it('reports a clean summary when mypy finds nothing', () => {
      const input = 'Success: no issues found in 12 source files';

      const result = apply(input);

      expect(result).toContain('[LINT OK]');
    });

    it('is not misdetected as ruff/pylint/flake8 (no rule code, uses literal error:/note:)', () => {
      const input = 'pkg/mod.py:3: error: Argument 1 has incompatible type "int"; expected "str"  [arg-type]';

      const result = apply(input);

      expect(result).toContain('Found 1 error');
      expect(result).toContain('Argument 1 has incompatible type');
    });
  });

  describe('ruff/pylint/flake8 (existing behavior, unaffected by mypy detection)', () => {
    it('groups ruff output by file', () => {
      const input = [
        'app/utils.py:8:1: E501 line too long (92 > 88 characters)',
        'app/utils.py:15:5: F401 \'os\' imported but unused',
      ].join('\n');

      const result = apply(input);

      expect(result).toContain('app/utils.py');
      expect(result).toContain('E501');
      expect(result).toContain('F401');
    });
  });

  describe('tsc (existing behavior, unaffected)', () => {
    it('groups tsc errors by file', () => {
      const input = 'src/index.ts(10,5): error TS2322: Type \'string\' is not assignable to type \'number\'.';

      const result = apply(input);

      expect(result).toContain('Found 1 error');
      expect(result).toContain('src/index.ts');
    });
  });
});
