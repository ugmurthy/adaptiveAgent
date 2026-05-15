import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectProviderWarnings,
  loadBenchmarkCases,
  loadGaiaBenchmarkCases,
  loadManualTestSpec,
  parseCliArgs,
  renderPrettyString,
} from './adaptive-agent.js';

describe('adaptive-agent spec loading', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-'));
    await mkdir(join(tempDir, 'fixtures'));
    await writeFile(join(tempDir, 'fixtures', 'image.png'), 'image');
    await writeFile(join(tempDir, 'fixtures', 'notes.txt'), 'notes');
    await writeFile(join(tempDir, 'fixtures', 'audio.mp3'), 'audio');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves multimodal asset paths relative to the spec file', async () => {
    const specPath = join(tempDir, 'chat-spec.json');
    await writeFile(
      specPath,
      JSON.stringify({
        mode: 'chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'image', image: { path: './fixtures/image.png' } },
              { type: 'file', file: { source: { kind: 'path', path: './fixtures/notes.txt' } } },
              { type: 'audio', audio: { source: { kind: 'path', path: './fixtures/audio.mp3' }, format: 'mp3' } },
            ],
          },
        ],
      }),
    );

    const spec = await loadManualTestSpec(specPath);
    expect(spec.mode).toBe('chat');
    if (spec.mode !== 'chat') throw new Error('expected chat spec');
    const content = spec.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error('expected array content');
    expect(content[1]).toEqual({ type: 'image', image: { path: join(tempDir, 'fixtures', 'image.png') } });
    expect(content[2]).toEqual({
      type: 'file',
      file: { source: { kind: 'path', path: join(tempDir, 'fixtures', 'notes.txt') } },
    });
    expect(content[3]).toEqual({
      type: 'audio',
      audio: { source: { kind: 'path', path: join(tempDir, 'fixtures', 'audio.mp3') }, format: 'mp3' },
    });
  });

  it('rejects chat messages that mix array content with legacy images', async () => {
    const specPath = join(tempDir, 'invalid-chat-spec.json');
    await writeFile(
      specPath,
      JSON.stringify({
        mode: 'chat',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            images: [{ path: './fixtures/image.png' }],
          },
        ],
      }),
    );

    await expect(loadManualTestSpec(specPath)).rejects.toThrow('messages[0].images is allowed only when messages[0].content is a string');
  });

  it('rejects run specs that include both images and image content parts', async () => {
    const specPath = join(tempDir, 'invalid-run-spec.json');
    await writeFile(
      specPath,
      JSON.stringify({
        mode: 'run',
        goal: 'summarize',
        images: [{ path: './fixtures/image.png' }],
        contentParts: [{ type: 'image', image: { path: './fixtures/image.png' } }],
      }),
    );

    await expect(loadManualTestSpec(specPath)).rejects.toThrow('Run spec must not include both "images" and image entries in "contentParts"');
  });

  it('warns for provider modality mismatches', async () => {
    const specPath = join(tempDir, 'warn-run-spec.json');
    await writeFile(
      specPath,
      JSON.stringify({
        mode: 'run',
        goal: 'summarize',
        contentParts: [
          { type: 'text', text: 'hello' },
          { type: 'file', file: { source: { kind: 'path', path: './fixtures/notes.txt' } } },
          { type: 'audio', audio: { source: { kind: 'path', path: './fixtures/audio.mp3' }, format: 'mp3' } },
        ],
      }),
    );

    const spec = await loadManualTestSpec(specPath);
    expect(collectProviderWarnings(spec, 'ollama')).toEqual([
      'Provider "ollama" does not declare file input support; this request will likely fail.',
      'Provider "ollama" does not declare audio input support; this request will likely fail.',
    ]);
  });
});

describe('adaptive-agent cli parsing', () => {
  it('parses common flags', () => {
    const parsed = parseCliArgs([
      '--spec', './tmp/spec.json',
      '--mode', 'chat',
      '--runtime', 'memory',
      '--provider', 'ollama',
      '--model', 'qwen3.5',
      '--approval', 'manual',
      '--clarification', 'fail',
      '--events',
      '--inspect',
      '--output', 'json',
    ]);

    expect(parsed).toEqual({
      command: 'spec',
      specPath: './tmp/spec.json',
      goalArgs: [],
      imagePaths: [],
      evalResume: false,
      evalFailFast: false,
      evalOffset: 0,
      mode: 'chat',
      runtimeMode: 'memory',
      provider: 'ollama',
      model: 'qwen3.5',
      approvalMode: 'manual',
      clarificationMode: 'fail',
      events: true,
      inspect: true,
      output: 'json',
      help: false,
    });
  });

  it('parses run subcommand prompt and attachments', () => {
    const parsed = parseCliArgs([
      'run',
      '--image', './chart.png',
      '--input-json', '{"level":2}',
      'answer',
      'this',
    ]);

    expect(parsed).toMatchObject({
      command: 'run',
      specPath: '',
      goalArgs: ['answer', 'this'],
      imagePaths: ['./chart.png'],
      inputJson: { level: 2 },
      events: false,
      inspect: false,
      output: 'pretty',
      help: false,
    });
  });

  it('parses eval cases benchmark flags', () => {
    const parsed = parseCliArgs([
      'eval', 'cases',
      '--input', './cases.jsonl',
      '--out', './results.jsonl',
      '--artifacts', './artifacts',
      '--resume',
      '--fail-fast',
      '--limit', '5',
      '--offset', '2',
      '--ids', 'a,b',
      '--output', 'jsonl',
    ]);

    expect(parsed).toMatchObject({
      command: 'eval',
      evalDataset: 'cases',
      evalInputPath: './cases.jsonl',
      evalOutputPath: './results.jsonl',
      evalArtifactsDir: './artifacts',
      evalResume: true,
      evalFailFast: true,
      evalLimit: 5,
      evalOffset: 2,
      evalIds: ['a', 'b'],
      output: 'jsonl',
    });
  });

  it('parses eval gaia benchmark flags', () => {
    const parsed = parseCliArgs([
      'eval', 'gaia',
      '--input', './gaia.jsonl',
      '--files-dir', './files',
      '--out', './results.jsonl',
      '--level', '1',
      '--split', 'validation',
    ]);

    expect(parsed).toMatchObject({
      command: 'eval',
      evalDataset: 'gaia',
      evalInputPath: './gaia.jsonl',
      evalFilesDir: './files',
      evalOutputPath: './results.jsonl',
      evalLevel: '1',
      evalSplit: 'validation',
    });
  });
});

describe('adaptive-agent benchmark cases', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-bench-'));
    await mkdir(join(tempDir, 'fixtures'));
    await writeFile(join(tempDir, 'fixtures', 'image.png'), 'image');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads generic benchmark cases from jsonl and resolves assets', async () => {
    const inputPath = join(tempDir, 'cases.jsonl');
    await writeFile(inputPath, [
      JSON.stringify({ id: 'case-1', dataset: 'custom', question: 'What is shown?', images: [{ path: './fixtures/image.png' }], expectedAnswer: 'image' }),
      JSON.stringify({ task_id: 'case-2', question: 'No asset' }),
    ].join('\n'));

    const cases = await loadBenchmarkCases(inputPath);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({
      id: 'case-1',
      dataset: 'custom',
      question: 'What is shown?',
      expectedAnswer: 'image',
      images: [{ path: join(tempDir, 'fixtures', 'image.png') }],
    });
    expect(cases[1]?.id).toBe('case-2');
  });

  it('loads a single pretty-printed benchmark case object', async () => {
    const inputPath = join(tempDir, 'case.json');
    await writeFile(inputPath, JSON.stringify({ id: 'case-1', question: 'What is 2+2?' }, null, 2));

    const cases = await loadBenchmarkCases(inputPath);
    expect(cases).toEqual([{ id: 'case-1', question: 'What is 2+2?' }]);
  });

  it('normalizes GAIA rows and resolves attachments from files dir', async () => {
    const inputPath = join(tempDir, 'gaia.jsonl');
    await writeFile(inputPath, JSON.stringify({
      task_id: 'gaia-1',
      Question: 'What is in the image?',
      file_name: 'image.png',
      Level: '1',
      'Final answer': 'coin',
    }));

    const cases = await loadGaiaBenchmarkCases(inputPath, tempDir, 'fixtures', 'validation');
    expect(cases).toEqual([{
      id: 'gaia-1',
      dataset: 'gaia',
      split: 'validation',
      level: '1',
      question: 'What is in the image?',
      images: [{ path: join(tempDir, 'fixtures', 'image.png'), name: 'image.png' }],
      expectedAnswer: 'coin',
      metadata: { source: 'gaia', fileName: 'image.png', level: '1', split: 'validation' },
    }]);
  });
});

describe('adaptive-agent pretty rendering', () => {
  it('renders markdown strings for pretty output', () => {
    const rendered = renderPrettyString('# Heading\n\n- one\n- two');
    expect(rendered).toContain('Heading');
    expect(rendered).toContain('one');
    expect(rendered).toContain('two');
  });
});
