import type { FilterStrategy, StrategyOptions } from '../types.js';

/**
 * TestResultFilter — Parses test runner output into an actionable summary.
 *
 * Detects the test runner (Jest/Vitest, pytest, cargo test, go test) from
 * output markers, extracts failures with location/message/diff/stack,
 * and produces a compact summary.
 *
 * Options:
 * - showPasses (boolean): include individual passing tests in output
 * - showCoverage (boolean): include coverage table if present
 * - maxStackFrames (number, default 5): truncate stack traces
 * - exitCode (number): used for heuristic fallback on non-zero exit
 *
 * Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */
export class TestResultFilter implements FilterStrategy {
  readonly name = 'test-result';

  apply(input: string, options: StrategyOptions): string {
    const showPasses = (options.showPasses as boolean) ?? false;
    const showCoverage = (options.showCoverage as boolean) ?? false;
    const maxStackFrames = (options.maxStackFrames as number) ?? 5;
    const exitCode = (options.exitCode as number) ?? 0;

    const runner = this.detectRunner(input);

    let result: ParsedTestResult;

    switch (runner) {
      case 'jest-vitest':
        result = this.parseJestVitest(input, maxStackFrames);
        break;
      case 'pytest':
        result = this.parsePytest(input, maxStackFrames);
        break;
      case 'cargo':
        result = this.parseCargo(input, maxStackFrames);
        break;
      case 'go':
        result = this.parseGo(input, maxStackFrames);
        break;
      default:
        result = this.parseHeuristic(input, maxStackFrames);
        break;
    }

    // Fallback: if exit code != 0 and no structured failures found, use keepEnd truncate
    if (exitCode !== 0 && result.failures.length === 0 && runner === 'unknown') {
      return this.fallbackKeepEnd(input);
    }

    const output = this.formatOutput(result, showPasses, showCoverage, input);
    return output;
  }

  // ---------------------------------------------------------------------------
  // Runner Detection
  // ---------------------------------------------------------------------------

  private detectRunner(input: string): TestRunner {
    // Jest/Vitest markers: PASS/FAIL prefixes, ● character, "Test Suites:", "Tests:"
    if (
      /^(PASS|FAIL)\s/m.test(input) ||
      input.includes('●') ||
      /Test Suites:/m.test(input) ||
      /Tests:\s+\d+/m.test(input)
    ) {
      return 'jest-vitest';
    }

    // pytest markers: "PASSED"/"FAILED", "=====" separators, "short test summary"
    if (
      /={5,}\s*(FAILURES|short test summary|ERRORS)/m.test(input) ||
      (/\bPASSED\b/.test(input) && /={5,}/.test(input)) ||
      (/\bFAILED\b/.test(input) && /={5,}/.test(input))
    ) {
      return 'pytest';
    }

    // cargo test markers: "test result:", "ok", "FAILED"
    if (/test result:/.test(input) && (/\bok\b/.test(input) || /\bFAILED\b/.test(input))) {
      return 'cargo';
    }

    // go test markers: "--- FAIL", "ok", "FAIL"
    if (/^--- FAIL/m.test(input) || (/^ok\s+/m.test(input) && /^FAIL\s+/m.test(input))) {
      return 'go';
    }

    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Jest/Vitest Parser
  // ---------------------------------------------------------------------------

  private parseJestVitest(input: string, maxStackFrames: number): ParsedTestResult {
    const lines = input.split('\n');
    const failures: TestFailure[] = [];
    const passes: string[] = [];
    let totalTests = 0;
    let passedTests = 0;
    let duration = '';

    // Extract summary from "Tests:" line
    const testsLine = lines.find((l) => /^\s*Tests:/.test(l));
    if (testsLine) {
      const failedMatch = testsLine.match(/(\d+)\s+failed/);
      const passedMatch = testsLine.match(/(\d+)\s+passed/);
      const totalMatch = testsLine.match(/(\d+)\s+total/);
      if (totalMatch) totalTests = parseInt(totalMatch[1], 10);
      if (passedMatch) passedTests = parseInt(passedMatch[1], 10);
      if (failedMatch && !totalMatch) {
        totalTests = passedTests + parseInt(failedMatch[1], 10);
      }
    }

    // Extract duration
    const timeLine = lines.find((l) => /Time:/.test(l));
    if (timeLine) {
      const timeMatch = timeLine.match(/Time:\s*(.+)/);
      if (timeMatch) duration = timeMatch[1].trim();
    }

    // Extract passing tests (lines with ✓ or PASS prefix on file lines)
    for (const line of lines) {
      if (/^\s*(✓|√|✔)\s/.test(line)) {
        passes.push(line.trim());
      }
    }

    // Extract failures: look for ● markers
    let i = 0;
    while (i < lines.length) {
      if (lines[i].includes('●')) {
        const failure = this.extractJestFailure(lines, i, maxStackFrames);
        if (failure) {
          failures.push(failure);
          i = failure._endIndex ?? i + 1;
          continue;
        }
      }
      i++;
    }

    // If no "Tests:" line but we have pass/fail markers from PASS/FAIL prefixes
    if (totalTests === 0) {
      const passFiles = lines.filter((l) => /^PASS\s/.test(l)).length;
      const failFiles = lines.filter((l) => /^FAIL\s/.test(l)).length;
      totalTests = passedTests || passFiles + failFiles;
      if (passedTests === 0) passedTests = passFiles;
    }

    return { totalTests, passedTests, failures, passes, duration, coverageStart: -1 };
  }

  private extractJestFailure(
    lines: string[],
    startIdx: number,
    maxStackFrames: number,
  ): (TestFailure & { _endIndex?: number }) | null {
    const headerLine = lines[startIdx];
    // ● TestName or ● Suite > TestName
    const nameMatch = headerLine.match(/●\s+(.+)/);
    if (!nameMatch) return null;

    const testName = nameMatch[1].trim();
    let file = '';
    let line = 0;
    let message = '';
    let expected = '';
    let received = '';
    const stackLines: string[] = [];

    let i = startIdx + 1;
    let inStack = false;

    while (i < lines.length) {
      const currentLine = lines[i];

      // Next failure starts
      if (currentLine.includes('●') && i > startIdx + 1) break;
      // End of failures section
      if (/^(Test Suites:|Tests:)/.test(currentLine)) break;

      if (inStack) {
        if (/^\s+at\s/.test(currentLine)) {
          stackLines.push(currentLine.trim());
        } else {
          break;
        }
      } else {
        // Look for expected/received
        if (/Expected:?\s*/i.test(currentLine) && !expected) {
          expected = currentLine.replace(/.*Expected:?\s*/i, '').trim();
        } else if (/Received:?\s*/i.test(currentLine) && !received) {
          received = currentLine.replace(/.*Received:?\s*/i, '').trim();
        } else if (/^\s+at\s/.test(currentLine)) {
          inStack = true;
          stackLines.push(currentLine.trim());
          // Try to extract file:line from first stack frame
          const locMatch = currentLine.match(/\((.+?):(\d+):\d+\)/);
          if (locMatch && !file) {
            file = locMatch[1];
            line = parseInt(locMatch[2], 10);
          }
        } else if (!message && currentLine.trim() && !expected && !received) {
          message = currentLine.trim();
        }
      }

      i++;
    }

    return {
      testName,
      file,
      line,
      message: message || (expected && received ? `Expected: ${expected}, Received: ${received}` : ''),
      expected,
      received,
      stack: stackLines.slice(0, maxStackFrames),
      _endIndex: i,
    };
  }

  // ---------------------------------------------------------------------------
  // pytest Parser
  // ---------------------------------------------------------------------------

  private parsePytest(input: string, maxStackFrames: number): ParsedTestResult {
    const lines = input.split('\n');
    const failures: TestFailure[] = [];
    const passes: string[] = [];
    let totalTests = 0;
    let passedTests = 0;
    let duration = '';

    // Extract summary line: "X passed, Y failed in Zs"
    const summaryLine = lines.find((l) => /\d+\s+passed/.test(l) || /\d+\s+failed/.test(l));
    if (summaryLine) {
      const passedMatch = summaryLine.match(/(\d+)\s+passed/);
      const failedMatch = summaryLine.match(/(\d+)\s+failed/);
      const timeMatch = summaryLine.match(/in\s+([\d.]+s)/);
      if (passedMatch) passedTests = parseInt(passedMatch[1], 10);
      const failedCount = failedMatch ? parseInt(failedMatch[1], 10) : 0;
      totalTests = passedTests + failedCount;
      if (timeMatch) duration = timeMatch[1];
    }

    // Extract passes
    for (const line of lines) {
      if (/PASSED/.test(line) && !/::\s*PASSED/.test(line)) {
        passes.push(line.trim());
      } else if (/::.*PASSED/.test(line)) {
        passes.push(line.trim());
      }
    }

    // Extract failures from FAILURES section
    const failuresStart = lines.findIndex((l) => /^={5,}\s*FAILURES\s*={5,}$/.test(l));
    if (failuresStart !== -1) {
      let i = failuresStart + 1;
      while (i < lines.length) {
        // Each failure starts with ___ test_name ___
        if (/^_{5,}\s+(.+?)\s+_{5,}$/.test(lines[i])) {
          const failure = this.extractPytestFailure(lines, i, maxStackFrames);
          if (failure) {
            failures.push(failure);
            i = failure._endIndex ?? i + 1;
            continue;
          }
        }
        // End of failures section
        if (/^={5,}/.test(lines[i]) && i > failuresStart + 1) break;
        i++;
      }
    }

    // Also parse short test summary
    if (failures.length === 0) {
      const shortSummaryStart = lines.findIndex((l) => /short test summary/.test(l));
      if (shortSummaryStart !== -1) {
        for (let i = shortSummaryStart + 1; i < lines.length; i++) {
          if (/^={5,}/.test(lines[i])) break;
          const failMatch = lines[i].match(/FAILED\s+(.+?)(?:\s+-\s+(.+))?$/);
          if (failMatch) {
            const location = failMatch[1];
            const msg = failMatch[2] || '';
            const fileMatch = location.match(/(.+?)::(.+)/);
            failures.push({
              testName: fileMatch ? fileMatch[2] : location,
              file: fileMatch ? fileMatch[1] : '',
              line: 0,
              message: msg,
              expected: '',
              received: '',
              stack: [],
            });
          }
        }
      }
    }

    return { totalTests, passedTests, failures, passes, duration, coverageStart: -1 };
  }

  private extractPytestFailure(
    lines: string[],
    startIdx: number,
    maxStackFrames: number,
  ): (TestFailure & { _endIndex?: number }) | null {
    const headerMatch = lines[startIdx].match(/^_{5,}\s+(.+?)\s+_{5,}$/);
    if (!headerMatch) return null;

    const testName = headerMatch[1];
    let file = '';
    let line = 0;
    let message = '';
    let expected = '';
    let received = '';
    const stackLines: string[] = [];

    let i = startIdx + 1;
    while (i < lines.length) {
      if (/^_{5,}/.test(lines[i]) || /^={5,}/.test(lines[i])) break;

      const currentLine = lines[i];

      // File location
      const locMatch = currentLine.match(/^(.+?):(\d+):/);
      if (locMatch && !file) {
        file = locMatch[1];
        line = parseInt(locMatch[2], 10);
      }

      // Expected/Received (assert patterns)
      if (/assert/i.test(currentLine) || /AssertionError/i.test(currentLine)) {
        message = currentLine.trim();
      }
      if (/Expected|expected/i.test(currentLine) && !expected) {
        expected = currentLine.trim();
      }
      if (/Received|actual|got/i.test(currentLine) && !received) {
        received = currentLine.trim();
      }

      // Stack frames (lines starting with file references)
      if (/^\s+File\s+"/.test(currentLine) || /^\s{2,}/.test(currentLine)) {
        stackLines.push(currentLine.trim());
      }

      i++;
    }

    return {
      testName,
      file,
      line,
      message,
      expected,
      received,
      stack: stackLines.slice(0, maxStackFrames),
      _endIndex: i,
    };
  }

  // ---------------------------------------------------------------------------
  // Cargo Test Parser
  // ---------------------------------------------------------------------------

  private parseCargo(input: string, maxStackFrames: number): ParsedTestResult {
    const lines = input.split('\n');
    const failures: TestFailure[] = [];
    const passes: string[] = [];
    let totalTests = 0;
    let passedTests = 0;
    let duration = '';

    // Extract summary: "test result: ok. X passed; Y failed; ..."
    const resultLine = lines.find((l) => /^test result:/.test(l));
    if (resultLine) {
      const passedMatch = resultLine.match(/(\d+)\s+passed/);
      const failedMatch = resultLine.match(/(\d+)\s+failed/);
      if (passedMatch) passedTests = parseInt(passedMatch[1], 10);
      const failedCount = failedMatch ? parseInt(failedMatch[1], 10) : 0;
      totalTests = passedTests + failedCount;
      const timeMatch = resultLine.match(/finished in\s+([\d.]+s)/);
      if (timeMatch) duration = timeMatch[1];
    }

    // Extract passes
    for (const line of lines) {
      if (/^test\s+.+\.\.\.\s+ok$/.test(line)) {
        passes.push(line.trim());
      }
    }

    // Extract failures section
    const failuresStart = lines.findIndex((l) => /^failures:$/i.test(l.trim()));
    if (failuresStart !== -1) {
      let i = failuresStart + 1;
      // Skip the "failures:" header that lists names
      const failureNamesEnd = lines.findIndex(
        (l, idx) => idx > failuresStart && /^failures:$/i.test(l.trim()),
      );

      // Look for "---- test_name stdout ----" blocks
      while (i < lines.length) {
        const blockMatch = lines[i].match(/^-{4,}\s+(.+?)\s+stdout\s+-{4,}$/);
        if (blockMatch) {
          const testName = blockMatch[1];
          const stackFrames: string[] = [];
          let msg = '';
          let j = i + 1;

          while (j < lines.length && !/^-{4,}/.test(lines[j]) && !/^failures:$/i.test(lines[j].trim())) {
            const frameLine = lines[j].trim();
            if (frameLine.startsWith('thread') && frameLine.includes('panicked')) {
              msg = frameLine;
            } else if (frameLine && !msg) {
              msg = frameLine;
            }
            if (frameLine) stackFrames.push(frameLine);
            j++;
          }

          failures.push({
            testName,
            file: '',
            line: 0,
            message: msg,
            expected: '',
            received: '',
            stack: stackFrames.slice(0, maxStackFrames),
          });
          i = j;
          continue;
        }

        // Stop at the failure names list section or test result
        if (/^test result:/.test(lines[i]) || (failureNamesEnd !== -1 && i >= failureNamesEnd)) break;
        i++;
      }
    }

    return { totalTests, passedTests, failures, passes, duration, coverageStart: -1 };
  }

  // ---------------------------------------------------------------------------
  // Go Test Parser
  // ---------------------------------------------------------------------------

  private parseGo(input: string, maxStackFrames: number): ParsedTestResult {
    const lines = input.split('\n');
    const failures: TestFailure[] = [];
    const passes: string[] = [];
    let totalTests = 0;
    let passedTests = 0;
    let duration = '';

    // Count passes: "--- PASS: TestName (Xs)"
    for (const line of lines) {
      if (/^--- PASS:/.test(line)) {
        passedTests++;
        passes.push(line.trim());
      }
    }

    // Extract failures: "--- FAIL: TestName (Xs)"
    let i = 0;
    while (i < lines.length) {
      const failMatch = lines[i].match(/^--- FAIL:\s+(\S+)\s+\((.+?)\)/);
      if (failMatch) {
        const testName = failMatch[1];
        const testDuration = failMatch[2];
        let message = '';
        let file = '';
        let line2 = 0;
        let expected = '';
        let received = '';
        const stackFrames: string[] = [];

        // Look backwards for the failure details (go test prints details before --- FAIL)
        let j = i - 1;
        while (j >= 0 && !(/^---\s+(PASS|FAIL):/.test(lines[j])) && !(/^=== RUN/.test(lines[j]))) {
          const frameLine = lines[j].trim();
          if (frameLine) {
            const locMatch = frameLine.match(/^\s*(.+?\.go):(\d+):/);
            if (locMatch && !file) {
              file = locMatch[1];
              line2 = parseInt(locMatch[2], 10);
            }
            if (/expected/i.test(frameLine) && !expected) expected = frameLine;
            if (/got|actual/i.test(frameLine) && !received) received = frameLine;
            if (!message) message = frameLine;
            stackFrames.unshift(frameLine);
          }
          j--;
        }

        failures.push({
          testName,
          file,
          line: line2,
          message,
          expected,
          received,
          stack: stackFrames.slice(0, maxStackFrames),
        });

        if (!duration) duration = testDuration;
      }
      i++;
    }

    totalTests = passedTests + failures.length;

    // Extract overall duration from "ok" or "FAIL" package lines
    const pkgLine = lines.find((l) => /^(ok|FAIL)\s+\S+\s+[\d.]+s/.test(l));
    if (pkgLine) {
      const timeMatch = pkgLine.match(/([\d.]+s)/);
      if (timeMatch) duration = timeMatch[1];
    }

    return { totalTests, passedTests, failures, passes, duration, coverageStart: -1 };
  }

  // ---------------------------------------------------------------------------
  // Heuristic Fallback Parser
  // ---------------------------------------------------------------------------

  private parseHeuristic(input: string, maxStackFrames: number): ParsedTestResult {
    const lines = input.split('\n');
    const failures: TestFailure[] = [];
    const passes: string[] = [];

    // Heuristic: detect failures by keywords
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/\bFAIL\b/i.test(line) || /\bError\b/.test(line) || /\bExpected\b/i.test(line)) {
        const contextLines: string[] = [line];
        // Grab a few lines of context
        let j = i + 1;
        while (j < lines.length && j < i + maxStackFrames + 1) {
          if (/^\s*$/.test(lines[j])) break;
          contextLines.push(lines[j]);
          j++;
        }

        failures.push({
          testName: line.trim().slice(0, 80),
          file: '',
          line: 0,
          message: line.trim(),
          expected: '',
          received: '',
          stack: contextLines.slice(1, maxStackFrames + 1),
        });
        i = j;
        continue;
      }
      i++;
    }

    return {
      totalTests: 0,
      passedTests: 0,
      failures,
      passes,
      duration: '',
      coverageStart: -1,
    };
  }

  // ---------------------------------------------------------------------------
  // Fallback: keepEnd truncate for unparseable non-zero exit
  // ---------------------------------------------------------------------------

  private fallbackKeepEnd(input: string): string {
    const maxLines = 100;
    const lines = input.split('\n');
    if (lines.length <= maxLines) return input;
    return lines.slice(lines.length - maxLines).join('\n');
  }

  // ---------------------------------------------------------------------------
  // Output Formatter
  // ---------------------------------------------------------------------------

  private formatOutput(
    result: ParsedTestResult,
    showPasses: boolean,
    showCoverage: boolean,
    rawInput: string,
  ): string {
    const parts: string[] = [];
    const { totalTests, passedTests, failures, passes, duration } = result;

    // Summary header
    const failCount = failures.length;
    const displayTotal = totalTests || passedTests + failCount;
    const displayPassed = passedTests || (displayTotal - failCount);
    const durationSuffix = duration ? ` (${duration})` : '';

    if (failCount === 0) {
      parts.push(`[PASS] ${displayPassed}/${displayTotal} tests passed${durationSuffix}`);
    } else {
      parts.push(`[PASS] ${displayPassed}/${displayTotal} tests passed${durationSuffix}`);
      parts.push(`[FAIL] ${failCount} failure${failCount > 1 ? 's' : ''}:`);
      parts.push('');

      for (let idx = 0; idx < failures.length; idx++) {
        const f = failures[idx];
        const location = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '';
        const header = location
          ? `${idx + 1}. ${location} — "${f.testName}"`
          : `${idx + 1}. "${f.testName}"`;
        parts.push(header);

        if (f.expected && f.received) {
          parts.push(`   Expected: ${f.expected}`);
          parts.push(`   Received: ${f.received}`);
        } else if (f.message) {
          parts.push(`   ${f.message}`);
        }

        if (f.stack.length > 0) {
          parts.push(`   Stack:`);
          for (const frame of f.stack) {
            parts.push(`     ${frame}`);
          }
        }

        parts.push('');
      }
    }

    // Show individual passes if requested
    if (showPasses && passes.length > 0) {
      parts.push('');
      parts.push('Passed tests:');
      for (const p of passes) {
        parts.push(`  ✓ ${p}`);
      }
    }

    // Show coverage table if requested
    if (showCoverage) {
      const coverageTable = this.extractCoverageTable(rawInput);
      if (coverageTable) {
        parts.push('');
        parts.push('Coverage:');
        parts.push(coverageTable);
      }
    }

    return parts.join('\n').trim();
  }

  // ---------------------------------------------------------------------------
  // Coverage Table Extraction
  // ---------------------------------------------------------------------------

  private extractCoverageTable(input: string): string | null {
    const lines = input.split('\n');

    // Jest/Vitest coverage: starts with a line containing "%" and separators like ---|---
    // Look for coverage header patterns
    const coveragePatterns = [
      /^\s*-{2,}\|/,            // --|--|--|--| separator
      /^\s*File\s+.*%/i,        // File | % Stmts | ...
      /^(All files|TOTAL)/,     // Summary row
      /coverage/i,              // "Coverage summary" header
      /^\s*%\s*(Stmts|Branch|Funcs|Lines)/i,
    ];

    let coverageStart = -1;
    let coverageEnd = -1;

    for (let i = 0; i < lines.length; i++) {
      if (coveragePatterns.some((p) => p.test(lines[i]))) {
        if (coverageStart === -1) coverageStart = i;
        coverageEnd = i;
      } else if (coverageStart !== -1 && coverageEnd !== -1) {
        // Allow blank lines within the coverage block
        if (lines[i].trim() === '' && i - coverageEnd <= 1) {
          continue;
        }
        // If we already have lines and hit a non-coverage line, stop
        if (coverageEnd - coverageStart > 1) break;
      }
    }

    // Also try detecting by "-------" table separators near "% "
    if (coverageStart === -1) {
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*-+\s*$/.test(lines[i]) || /\|\s*-+\s*\|/.test(lines[i])) {
          // Check if nearby lines have %
          const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 5));
          if (nearby.some((l) => /%/.test(l) && /\d/.test(l))) {
            if (coverageStart === -1) coverageStart = Math.max(0, i - 2);
            coverageEnd = Math.min(lines.length - 1, i + 5);
          }
        }
      }
    }

    if (coverageStart !== -1 && coverageEnd !== -1) {
      return lines.slice(coverageStart, coverageEnd + 1).join('\n');
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

type TestRunner = 'jest-vitest' | 'pytest' | 'cargo' | 'go' | 'unknown';

interface TestFailure {
  testName: string;
  file: string;
  line: number;
  message: string;
  expected: string;
  received: string;
  stack: string[];
}

interface ParsedTestResult {
  totalTests: number;
  passedTests: number;
  failures: TestFailure[];
  passes: string[];
  duration: string;
  coverageStart: number;
}
