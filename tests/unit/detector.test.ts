import { describe, it, expect } from 'vitest';
import { CommandDetector } from '../../src/detector.js';

describe('CommandDetector', () => {
  const detector = new CommandDetector();

  describe('test runners — parity across package managers', () => {
    const testCases = [
      { cmd: 'npm test', type: 'test_runner', confidence: 1 },
      { cmd: 'pnpm test', type: 'test_runner', confidence: 1 },
      { cmd: 'yarn test', type: 'test_runner', confidence: 1 },
      { cmd: 'bun test', type: 'test_runner', confidence: 1 },
      { cmd: 'npm run test:unit', type: 'test_runner', confidence: 0.85 },
      { cmd: 'pnpm run test:unit', type: 'test_runner', confidence: 0.85 },
      { cmd: 'yarn run test:e2e', type: 'test_runner', confidence: 0.85 },
      { cmd: 'bun run test:integration', type: 'test_runner', confidence: 0.85 },
    ];

    for (const { cmd, type, confidence } of testCases) {
      it(`detects "${cmd}" as ${type} (confidence ${confidence})`, () => {
        const result = detector.detect(cmd);
        expect(result.type).toBe(type);
        expect(result.confidence).toBe(confidence);
      });
    }
  });

  describe('build tools — package manager scripts', () => {
    const buildScripts = [
      { cmd: 'npm run build', type: 'build_tool', confidence: 0.85 },
      { cmd: 'pnpm run build', type: 'build_tool', confidence: 0.85 },
      { cmd: 'yarn run build', type: 'build_tool', confidence: 0.85 },
      { cmd: 'bun run build', type: 'build_tool', confidence: 0.85 },
      { cmd: 'pnpm run build:prod', type: 'build_tool', confidence: 0.85 },
      { cmd: 'npm run rebuild', type: 'build_tool', confidence: 0.85 },
      { cmd: 'pnpm build', type: 'build_tool', confidence: 0.8 },
      { cmd: 'yarn build', type: 'build_tool', confidence: 0.8 },
      { cmd: 'bun build', type: 'build_tool', confidence: 0.8 },
    ];

    for (const { cmd, type, confidence } of buildScripts) {
      it(`detects "${cmd}" as ${type} (confidence ${confidence})`, () => {
        const result = detector.detect(cmd);
        expect(result.type).toBe(type);
        expect(result.confidence).toBe(confidence);
      });
    }
  });

  describe('build tools — native compilers and bundlers', () => {
    const nativeBuilds = [
      { cmd: 'vite build', type: 'build_tool', confidence: 0.85 },
      { cmd: 'rollup build', type: 'build_tool', confidence: 0.85 },
      { cmd: 'esbuild build', type: 'build_tool', confidence: 0.85 },
      { cmd: 'webpack', type: 'build_tool', confidence: 0.85 },
      { cmd: 'cargo build', type: 'build_tool', confidence: 0.9 },
      { cmd: 'go build', type: 'build_tool', confidence: 0.9 },
      { cmd: 'make', type: 'build_tool', confidence: 0.75 },
      { cmd: 'cmake ..', type: 'build_tool', confidence: 0.75 },
      { cmd: 'gradle build', type: 'build_tool', confidence: 0.75 },
      { cmd: './gradlew assemble', type: 'build_tool', confidence: 0.75 },
      { cmd: 'mvn package', type: 'build_tool', confidence: 0.75 },
    ];

    for (const { cmd, type, confidence } of nativeBuilds) {
      it(`detects "${cmd}" as ${type} (confidence ${confidence})`, () => {
        const result = detector.detect(cmd);
        expect(result.type).toBe(type);
        expect(result.confidence).toBe(confidence);
      });
    }
  });

  describe('build_tool routes to LinterFilter strategy', () => {
    it('strategy is LinterFilter for all build_tool detections', () => {
      const commands = ['pnpm run build', 'webpack', 'cargo build', 'make'];
      for (const cmd of commands) {
        const result = detector.detect(cmd);
        expect(result.strategy).toBe('LinterFilter');
      }
    });
  });

  describe('normalization — prefixes are stripped', () => {
    it('strips npx prefix', () => {
      const result = detector.detect('npx vitest');
      expect(result.type).toBe('test_runner');
    });

    it('strips pnpm exec prefix', () => {
      const result = detector.detect('pnpm exec vitest');
      expect(result.type).toBe('test_runner');
    });

    it('strips env vars', () => {
      const result = detector.detect('NODE_ENV=production pnpm run build');
      expect(result.type).toBe('build_tool');
    });

    it('strips `python -m ` prefix', () => {
      expect(detector.detect('python -m pytest').type).toBe('test_runner');
      expect(detector.detect('python -m ruff check .').type).toBe('linter');
      expect(detector.detect('python -m mypy .').type).toBe('linter');
    });

    it('strips `python3 -m ` prefix', () => {
      expect(detector.detect('python3 -m pytest').type).toBe('test_runner');
    });

    it('strips `uv run ` prefix', () => {
      expect(detector.detect('uv run pytest').type).toBe('test_runner');
      expect(detector.detect('uv run ruff check .').type).toBe('linter');
    });

    it('strips `poetry run ` prefix', () => {
      expect(detector.detect('poetry run pytest').type).toBe('test_runner');
    });

    it('strips `pipenv run ` prefix', () => {
      expect(detector.detect('pipenv run mypy .').type).toBe('linter');
    });
  });

  describe('existing detections remain stable', () => {
    it('git status → git_status', () => {
      expect(detector.detect('git status').type).toBe('git_status');
    });

    it('git diff → git_diff', () => {
      expect(detector.detect('git diff').type).toBe('git_diff');
    });

    it('git log → git_log', () => {
      expect(detector.detect('git log').type).toBe('git_log');
    });

    it('git push → git_action', () => {
      expect(detector.detect('git push').type).toBe('git_action');
    });

    it('eslint → linter', () => {
      expect(detector.detect('eslint src/').type).toBe('linter');
    });

    it('mypy → linter', () => {
      expect(detector.detect('mypy .').type).toBe('linter');
    });

    it('npm install → package_install', () => {
      expect(detector.detect('npm install').type).toBe('package_install');
    });

    it('pnpm add react → package_install', () => {
      expect(detector.detect('pnpm add react').type).toBe('package_install');
    });

    it('unknown command → unknown', () => {
      expect(detector.detect('echo hello').type).toBe('unknown');
    });
  });
});
