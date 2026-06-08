import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectRubricFlags,
  isVisualEngineConfigured,
  loadVisualConfig,
  PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE,
  resetRubricFlagsCache,
  stage,
  STAGED_DIR_RELATIVE,
  VISUAL_RUBRIC_PATH_RELATIVE,
} from './stage.js';

let host: string;

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), 'stage-test-'));
  resetRubricFlagsCache();
});

afterEach(() => {
  rmSync(host, { recursive: true, force: true });
});

describe('stage()', () => {
  it('copies principles + agent-docs into <cwd>/.sandcastle-drain/staged/', async () => {
    await stage(host);

    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'principles', 'README.md'))).toBe(true);
    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'principles', 'testing.md'))).toBe(true);
    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'agent-docs', 'issue-tracker.md'))).toBe(
      true,
    );
  });

  it('does not write any prompt files into the host .sandcastle-drain/ dir', async () => {
    await stage(host);
    expect(existsSync(join(host, '.sandcastle-drain', 'prompt.md'))).toBe(false);
    expect(existsSync(join(host, '.sandcastle-drain', 'reviewer.md'))).toBe(false);
  });

  it('replaces a stale staged tree on re-stage (library-upgrade scenario)', async () => {
    await stage(host);
    const stalePath = join(host, STAGED_DIR_RELATIVE, 'principles', 'stale-from-prior-run.md');
    writeFileSync(stalePath, 'this file should be gone after re-stage');
    expect(existsSync(stalePath)).toBe(true);

    await stage(host);

    expect(existsSync(stalePath)).toBe(false);
    // Library-bundled content is still present.
    expect(existsSync(join(host, STAGED_DIR_RELATIVE, 'principles', 'README.md'))).toBe(true);
  });
});

describe('detectRubricFlags()', () => {
  it('returns all flags false when no rubric/config files exist', () => {
    expect(detectRubricFlags(host)).toEqual({
      hasContextMd: false,
      hasAdrs: false,
      hasVisualRubric: false,
      hasPreviewAdapterConfig: false,
    });
  });

  it('reports hasContextMd=true when CONTEXT.md exists and is non-empty', () => {
    writeFileSync(join(host, 'CONTEXT.md'), '# Glossary\n\nFoo means bar.\n');
    expect(detectRubricFlags(host).hasContextMd).toBe(true);
  });

  it('reports hasContextMd=false when CONTEXT.md exists but is empty', () => {
    writeFileSync(join(host, 'CONTEXT.md'), '');
    expect(detectRubricFlags(host).hasContextMd).toBe(false);
  });

  it('reports hasAdrs=true when docs/adr/ contains at least one non-README .md', () => {
    mkdirSync(join(host, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(host, 'docs', 'adr', 'README.md'), '# Index\n');
    writeFileSync(join(host, 'docs', 'adr', '0001-pick-db.md'), '# 0001 — Pick a DB\n');
    expect(detectRubricFlags(host).hasAdrs).toBe(true);
  });

  it('reports hasAdrs=false when docs/adr/ only contains README.md', () => {
    mkdirSync(join(host, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(host, 'docs', 'adr', 'README.md'), '# Index\n');
    expect(detectRubricFlags(host).hasAdrs).toBe(false);
  });

  it('reports hasAdrs=false when docs/adr/ does not exist', () => {
    expect(detectRubricFlags(host).hasAdrs).toBe(false);
  });

  it('memoizes results per cwd so repeat calls do not re-probe disk', () => {
    const first = detectRubricFlags(host);
    writeFileSync(join(host, 'CONTEXT.md'), '# Glossary\n');
    // Without the cache this would now report hasContextMd=true. The cache
    // is intentional — flags are sampled once per drain.
    const second = detectRubricFlags(host);
    expect(second).toBe(first);
    expect(second.hasContextMd).toBe(false);

    resetRubricFlagsCache();
    const third = detectRubricFlags(host);
    expect(third.hasContextMd).toBe(true);
  });

  describe('Visual-Iteration Engine config detection', () => {
    function writeVisualRubric(content = '# Visual rubric\n\nNo slop.\n'): void {
      mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
      writeFileSync(join(host, VISUAL_RUBRIC_PATH_RELATIVE), content);
    }
    function writePreviewAdapterConfig(content = '{"startCommand":["npm","run","preview"]}'): void {
      mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
      writeFileSync(join(host, PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE), content);
    }

    it('reports hasVisualRubric=true when the rubric file is present and non-empty', () => {
      writeVisualRubric();
      expect(detectRubricFlags(host).hasVisualRubric).toBe(true);
    });

    it('reports hasVisualRubric=false when the rubric file is empty', () => {
      writeVisualRubric('');
      expect(detectRubricFlags(host).hasVisualRubric).toBe(false);
    });

    it('reports hasPreviewAdapterConfig=true when the config file is present and non-empty', () => {
      writePreviewAdapterConfig();
      expect(detectRubricFlags(host).hasPreviewAdapterConfig).toBe(true);
    });

    it('reports hasPreviewAdapterConfig=false when the config file is empty', () => {
      writePreviewAdapterConfig('');
      expect(detectRubricFlags(host).hasPreviewAdapterConfig).toBe(false);
    });
  });
});

describe('isVisualEngineConfigured()', () => {
  it('is false when neither file is present (engine skipped project-wide)', () => {
    expect(isVisualEngineConfigured(host)).toBe(false);
  });

  it('is false when only the rubric is present', () => {
    mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(host, VISUAL_RUBRIC_PATH_RELATIVE), '# Rubric\n');
    expect(isVisualEngineConfigured(host)).toBe(false);
  });

  it('is false when only the preview-adapter config is present', () => {
    mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(host, PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE), '{"startCommand":["x"]}');
    expect(isVisualEngineConfigured(host)).toBe(false);
  });

  it('is true when both files are present and non-empty', () => {
    mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(host, VISUAL_RUBRIC_PATH_RELATIVE), '# Rubric\n');
    writeFileSync(join(host, PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE), '{"startCommand":["x"]}');
    expect(isVisualEngineConfigured(host)).toBe(true);
  });
});

describe('loadVisualConfig()', () => {
  it('returns null when neither file is present', () => {
    expect(loadVisualConfig(host)).toBeNull();
  });

  it('returns null when only the rubric is present', () => {
    mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(host, VISUAL_RUBRIC_PATH_RELATIVE), '# Rubric\n');
    expect(loadVisualConfig(host)).toBeNull();
  });

  it('returns null when the preview-adapter config is malformed JSON', () => {
    mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(host, VISUAL_RUBRIC_PATH_RELATIVE), '# Rubric\n');
    writeFileSync(join(host, PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE), 'not json');
    expect(loadVisualConfig(host)).toBeNull();
  });

  it('returns the loaded rubric string and parsed config when both files are valid', () => {
    mkdirSync(join(host, '.sandcastle-drain'), { recursive: true });
    writeFileSync(join(host, VISUAL_RUBRIC_PATH_RELATIVE), '# Rubric\n\nNo slop.\n');
    writeFileSync(
      join(host, PREVIEW_ADAPTER_CONFIG_PATH_RELATIVE),
      '{"startCommand":["npm","run","preview"],"readinessProbeUrl":"http://localhost:4321/"}',
    );

    const loaded = loadVisualConfig(host);
    expect(loaded).not.toBeNull();
    expect(loaded?.rubric).toBe('# Rubric\n\nNo slop.\n');
    expect(loaded?.previewAdapterConfig).toEqual({
      startCommand: ['npm', 'run', 'preview'],
      readinessProbeUrl: 'http://localhost:4321/',
    });
  });
});
