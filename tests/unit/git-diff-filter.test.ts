import { describe, it, expect } from 'vitest';
import { GitDiffFilter } from '../../src/strategies/git-diff-filter.js';

describe('GitDiffFilter', () => {
  const filter = new GitDiffFilter();

  it('has name "git-diff"', () => {
    expect(filter.name).toBe('git-diff');
  });

  it('strips diff --git, index, --- and +++ headers', () => {
    const input = [
      'diff --git a/src/file.ts b/src/file.ts',
      'index abc1234..def5678 100644',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '+new line',
      ' line3',
    ].join('\n');

    const result = filter.apply(input, {});

    expect(result).not.toContain('diff --git');
    expect(result).not.toContain('index abc1234');
    expect(result).not.toContain('--- a/src/file.ts');
    expect(result).not.toContain('+++ b/src/file.ts');
    expect(result).toContain('@@ -1,3 +1,4 @@');
    expect(result).toContain('+new line');
  });

  it('retains hunk headers and changed lines', () => {
    const input = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -10,5 +10,7 @@',
      ' context line 1',
      '-removed line',
      '+added line',
      ' context line 2',
    ].join('\n');

    const result = filter.apply(input, {});

    expect(result).toContain('@@ -10,5 +10,7 @@');
    expect(result).toContain('-removed line');
    expect(result).toContain('+added line');
    expect(result).toContain(' context line 1');
    expect(result).toContain(' context line 2');
  });

  it('limits context lines around changes to options.contextLines (default 3)', () => {
    const input = [
      'diff --git a/src/file.ts b/src/file.ts',
      'index abc..def 100644',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,10 +1,11 @@',
      ' ctx1',
      ' ctx2',
      ' ctx3',
      ' ctx4',
      ' ctx5',
      '+added',
      ' ctx6',
      ' ctx7',
      ' ctx8',
      ' ctx9',
      ' ctx10',
    ].join('\n');

    // Default contextLines = 3
    const result = filter.apply(input, {});

    // Should keep 3 lines before and 3 lines after the change
    expect(result).toContain(' ctx3');
    expect(result).toContain(' ctx4');
    expect(result).toContain(' ctx5');
    expect(result).toContain('+added');
    expect(result).toContain(' ctx6');
    expect(result).toContain(' ctx7');
    expect(result).toContain(' ctx8');
    // Should NOT keep lines too far from the change
    expect(result).not.toContain(' ctx1');
    expect(result).not.toContain(' ctx2');
    expect(result).not.toContain(' ctx9');
    expect(result).not.toContain(' ctx10');
  });

  it('respects custom contextLines option', () => {
    const input = [
      'diff --git a/src/file.ts b/src/file.ts',
      'index abc..def 100644',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,8 +1,9 @@',
      ' ctx1',
      ' ctx2',
      ' ctx3',
      ' ctx4',
      '+added',
      ' ctx5',
      ' ctx6',
      ' ctx7',
      ' ctx8',
    ].join('\n');

    const result = filter.apply(input, { contextLines: 1 });

    // Only 1 line before and 1 line after
    expect(result).toContain(' ctx4');
    expect(result).toContain('+added');
    expect(result).toContain(' ctx5');
    expect(result).not.toContain(' ctx1');
    expect(result).not.toContain(' ctx2');
    expect(result).not.toContain(' ctx3');
    expect(result).not.toContain(' ctx6');
  });

  it('preserves rename from/to lines', () => {
    const input = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 95%',
      'rename from old-name.ts',
      'rename to new-name.ts',
      'index abc..def 100644',
      '--- a/old-name.ts',
      '+++ b/new-name.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-old',
      '+new',
      ' line3',
    ].join('\n');

    const result = filter.apply(input, {});

    expect(result).toContain('rename from old-name.ts');
    expect(result).toContain('rename to new-name.ts');
  });

  it('preserves Binary files differ lines', () => {
    const input = [
      'diff --git a/image.png b/image.png',
      'index abc..def 100644',
      'Binary files a/image.png and b/image.png differ',
    ].join('\n');

    const result = filter.apply(input, {});

    expect(result).toContain('Binary files a/image.png and b/image.png differ');
  });

  it('includes per-file summary of insertions/deletions', () => {
    const input = [
      'diff --git a/src/file.ts b/src/file.ts',
      'index abc..def 100644',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,3 +1,5 @@',
      ' line1',
      '+added1',
      '+added2',
      '-removed1',
      ' line3',
    ].join('\n');

    const result = filter.apply(input, {});

    expect(result).toContain('src/file.ts: +2 -1');
  });

  it('handles multiple files in one diff', () => {
    const input = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '+added in a',
      'diff --git a/src/b.ts b/src/b.ts',
      'index 333..444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,3 +1,2 @@',
      ' line1',
      '-removed from b',
      ' line3',
    ].join('\n');

    const result = filter.apply(input, {});

    expect(result).toContain('src/a.ts: +1 -0');
    expect(result).toContain('src/b.ts: +0 -1');
    expect(result).toContain('+added in a');
    expect(result).toContain('-removed from b');
  });

  it('handles empty input', () => {
    const result = filter.apply('', {});
    expect(result).toBe('');
  });

  it('handles diff with no actual changes in hunks', () => {
    const input = [
      'diff --git a/src/file.ts b/src/file.ts',
      'index abc..def 100644',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
    ].join('\n');

    const result = filter.apply(input, {});

    expect(result).toContain('src/file.ts: +0 -0');
  });
});
