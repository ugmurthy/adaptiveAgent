import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectProviderWarnings,
  selectBenchmarkCases,
  loadBenchmarkCases,
  loadGaiaBenchmarkCases,
  loadManualTestSpec,
  main,
  parseCliArgs,
  formatCoordinatorDecompositionFailure,
  formatSwarmRunStatuses,
  formatSwarmExecutionPlan,
  formatSwarmSubtasks,
  renderStyledPrettyMessage,
  renderPrettyString,
  summarizeGaiaDryRunTasks,
} from './adaptive-agent.js';
import type { BenchmarkAttachmentType, BenchmarkCase, ManualTestCliOptions } from './adaptive-agent.js';

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
      '--progress',
      '--events',
      '--inspect',
      '--show-lines', '5',
      '--wrap-width', '72',
      '--dry-run',
      '--output', 'json',
    ]);

    expect(parsed).toEqual({
      command: 'spec',
      specPath: './tmp/spec.json',
      goalArgs: [],
      imagePaths: [],
      audioPaths: [],
      fileAttachmentPaths: [],
      orchestrate: false,
      agentCatalogPaths: [],
      workerCatalogPaths: [],
      evalResume: false,
      evalFailFast: false,
      evalSwarm: 1,
      evalOffset: 0,
      minimal: false,
      bundles: [],
      installAgents: [],
      installSkills: [],
      installManifests: [],
      mode: 'chat',
      runtimeMode: 'memory',
      provider: 'ollama',
      model: 'qwen3.5',
      approvalMode: 'manual',
      clarificationMode: 'fail',
      yes: false,
      force: false,
      network: false,
      providerCheck: false,
      strict: false,
      updateCheck: false,
      updateChannel: 'stable',
      progress: true,
      events: true,
      inspect: true,
      showLines: 5,
      wrapWidth: 72,
      dryRun: true,
      output: 'json',
      help: false,
    });
  });

  it('parses run subcommand prompt and attachments', () => {
    const parsed = parseCliArgs([
      'run',
      '--image', './chart.png',
      '--audio', './call.mp3',
      '--file-attachment', './notes.pdf',
      '--orchestrate',
      '--catalog', './vision-agent.json',
      '--input-json', '{"level":2}',
      'answer',
      'this',
    ]);

    expect(parsed).toMatchObject({
      command: 'run',
      specPath: '',
      goalArgs: ['answer', 'this'],
      imagePaths: ['./chart.png'],
      audioPaths: ['./call.mp3'],
      fileAttachmentPaths: ['./notes.pdf'],
      orchestrate: true,
      agentCatalogPaths: ['./vision-agent.json'],
      inputJson: { level: 2 },
      progress: false,
      events: false,
      inspect: false,
      dryRun: false,
      output: 'pretty',
      help: false,
    });
  });

  it('parses catalog command flags', () => {
    expect(parseCliArgs(['catalog', '--agent', 'reviewer', '--output', 'json'])).toMatchObject({
      command: 'catalog',
      agentConfigPath: 'reviewer',
      output: 'json',
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
      '--swarm', '3',
      '--limit', '5',
      '--offset', '2',
      '--ids', 'a,b',
      '--type', 'image',
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
      evalSwarm: 3,
      evalLimit: 5,
      evalOffset: 2,
      evalIds: ['a', 'b'],
      evalType: 'image',
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

  it('allows eval dry-run without an output path', () => {
    expect(parseCliArgs(['eval', 'cases', '--input', './cases.jsonl', '--dry-run'])).toMatchObject({
      command: 'eval',
      evalDataset: 'cases',
      evalInputPath: './cases.jsonl',
      dryRun: true,
    });
    expect(parseCliArgs(['eval', 'gaia', '--input', './gaia.jsonl', '--dry-run'])).toMatchObject({
      command: 'eval',
      evalDataset: 'gaia',
      evalInputPath: './gaia.jsonl',
      dryRun: true,
    });
  });

  it('parses swarm-run flags without overloading eval --swarm', () => {
    const parsed = parseCliArgs([
      'swarm-run',
      '--agent', './coordinator.json',
      '--worker-catalog', './market.json,./pricing.json',
      '--quality-agent', './quality.json',
      '--synthesizer-agent', './synth.json',
      '--max-workers', '3',
      '--session-id', 'session-1',
      'build',
      'strategy',
    ]);

    expect(parsed).toMatchObject({
      command: 'swarm-run',
      agentConfigPath: './coordinator.json',
      workerCatalogPaths: ['./market.json', './pricing.json'],
      qualityAgentPath: './quality.json',
      synthesizerAgentPath: './synth.json',
      maxWorkers: 3,
      sessionId: 'session-1',
      goalArgs: ['build', 'strategy'],
    });
  });

  it('rejects swarm-run without an explicit worker catalog or with ambiguous task input', () => {
    expect(() => parseCliArgs(['swarm-run', '--agent', './coordinator.json', 'task'])).toThrow('requires --worker-catalog');
    expect(() => parseCliArgs([
      'swarm-run',
      '--agent', './coordinator.json',
      '--worker-catalog', './worker.json',
      '--file', './task.txt',
      'task',
    ])).toThrow('not both');
  });

  it('rejects --swarm outside eval', () => {
    expect(() => parseCliArgs(['run', '--swarm', '2', 'hello'])).toThrow('--swarm is supported for eval requests');
  });

  it('parses install workflow commands', () => {
    expect(parseCliArgs(['--version'])).toMatchObject({ command: 'version' });
    expect(parseCliArgs([
      'init',
      '--provider', 'mesh',
      '--model', 'qwen/qwen3.5-27b',
      '--profile', 'coding',
      '--api-key-env', 'MESH_API_KEY',
      '--bundle', 'coding',
      '--install-agent', './agents/reviewer.json',
      '--install-skill', './skills/researcher',
      '--install-manifest', './adaptive-agent.install.json',
      '--yes',
      '--force',
    ])).toMatchObject({
      command: 'init',
      provider: 'mesh',
      model: 'qwen/qwen3.5-27b',
      profile: 'coding',
      apiKeyEnv: 'MESH_API_KEY',
      bundles: ['coding'],
      installAgents: ['./agents/reviewer.json'],
      installSkills: ['./skills/researcher'],
      installManifests: ['./adaptive-agent.install.json'],
      yes: true,
      force: true,
    });
    expect(parseCliArgs(['init', '--minimal'])).toMatchObject({ command: 'init', minimal: true });
    expect(() => parseCliArgs(['init', '--minimal', '--bundle', 'coding'])).toThrow('not both');
    expect(parseCliArgs(['doctor', '--network', '--provider-check', '--strict'])).toMatchObject({
      command: 'doctor',
      network: true,
      providerCheck: true,
      strict: true,
    });
    expect(parseCliArgs(['update', '--check', '--version', '0.2.0', '--channel', 'preview', '--repo', 'owner/repo', '--base-url', 'https://example.test/releases/{tag}'])).toMatchObject({
      command: 'update',
      updateCheck: true,
      updateVersion: '0.2.0',
      updateChannel: 'preview',
      updateRepo: 'owner/repo',
      updateBaseUrl: 'https://example.test/releases/{tag}',
    });
    expect(parseCliArgs(['uninstall', '--dry-run', '--output', 'json'])).toMatchObject({
      command: 'uninstall',
      dryRun: true,
      output: 'json',
    });
  });

  it('returns success for init when bundled defaults already exist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-init-'));
    const homeDir = join(tempDir, 'home');
    const originalHome = process.env.ADAPTIVE_AGENT_HOME;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      process.env.ADAPTIVE_AGENT_HOME = homeDir;
      await main(['init', '--yes', '--cwd', tempDir]);
      log.mockClear();

      const exitCode = await main(['init', '--yes', '--cwd', tempDir]);
      const rendered = String(log.mock.calls[0]?.[0]);

      expect(exitCode).toBe(0);
      expect(rendered).toContain('Installed bundled assets: core');
      expect(rendered).toContain('agents/default-agent.json');
      expect(rendered).toContain('-- exists');
    } finally {
      log.mockRestore();
      if (originalHome === undefined) {
        delete process.env.ADAPTIVE_AGENT_HOME;
      } else {
        process.env.ADAPTIVE_AGENT_HOME = originalHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('parses agent-create flags and description text', () => {
    expect(parseCliArgs([
      'agent-create',
      '--generator-agent', 'default-agent',
      '--id', 'api-reviewer',
      '--provider', 'openrouter',
      '--model', 'openai/gpt-5-mini',
      '--yes',
      'Create',
      'an',
      'API',
      'reviewer',
    ])).toMatchObject({
      command: 'agent-create',
      generatorAgentPath: 'default-agent',
      agentCreateId: 'api-reviewer',
      provider: 'openrouter',
      model: 'openai/gpt-5-mini',
      yes: true,
      goalArgs: ['Create', 'an', 'API', 'reviewer'],
    });
  });

  it('rejects ambiguous agent-create inputs and --agent alias', () => {
    expect(() => parseCliArgs(['agent-create', '--file', './brief.md', 'description'])).toThrow('not both');
    expect(() => parseCliArgs(['agent-create', '--agent', 'default-agent', 'description'])).toThrow('uses --generator-agent');
    expect(() => parseCliArgs(['run', '--generator-agent', 'default-agent', 'hello'])).toThrow('--generator-agent is supported for agent-create');
  });
});

describe('adaptive-agent catalog command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-catalog-'));
    await mkdir(join(tempDir, 'agents'), { recursive: true });
    await mkdir(join(tempDir, 'skills', 'researcher'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeCatalogFixtures(): Promise<void> {
    await writeFile(
      join(tempDir, 'agent.json'),
      JSON.stringify({
        id: 'agent',
        name: 'Agent',
        invocationModes: ['chat', 'run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'qwen3.5' },
        tools: ['read_file'],
        delegates: ['researcher'],
      }),
    );
    await writeFile(
      join(tempDir, 'agents', 'reviewer.json'),
      JSON.stringify({
        id: 'reviewer',
        name: 'Reviewer',
        description: 'Reviews source changes.',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'qwen3.5' },
        tools: ['read_file', 'web_search'],
        capabilities: { modalitiesSupported: ['text'], subjectsPreferred: ['code review'] },
      }),
    );
    await writeFile(
      join(tempDir, 'agent.settings.json'),
      JSON.stringify({
        agents: { dirs: ['./agents'] },
        skills: { dirs: ['./skills'] },
        runtime: { mode: 'memory' },
      }),
    );
    await writeFile(
      join(tempDir, 'skills', 'researcher', 'SKILL.md'),
      [
        '---',
        'name: researcher',
        'description: Research facts from local files.',
        'allowedTools:',
        '  - read_file',
        'triggers:',
        '  - research',
        '---',
        'Use local files to research focused questions.',
      ].join('\n'),
    );
  }

  it('lists agents, registered tools, and delegate skills as json', async () => {
    await writeCatalogFixtures();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main(['catalog', '--cwd', tempDir, '--output', 'json']);
      const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        agents: Array<{ id: string; active: boolean }>;
        tools: Array<{ name: string; configured: boolean; requiresApproval: boolean; inputFields: string[] }>;
        delegates: Array<{ name: string; configured: boolean; allowedTools: string[]; triggers?: string[] }>;
      };

      expect(exitCode).toBe(0);
      expect(output.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'agent', active: true }),
        expect.objectContaining({ id: 'reviewer', active: false }),
      ]));
      expect(output.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'read_file', configured: true, requiresApproval: false, inputFields: expect.arrayContaining(['path']) }),
        expect.objectContaining({ name: 'write_file', configured: false, requiresApproval: true }),
      ]));
      expect(output.delegates).toEqual([
        expect.objectContaining({ name: 'researcher', configured: true, allowedTools: ['read_file'], triggers: ['research'] }),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('renders agents, tools, and delegate skills with markdown for pretty output', async () => {
    await writeCatalogFixtures();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main(['catalog', '--cwd', tempDir]);
      const rendered = stripAnsi(String(log.mock.calls[0]?.[0]));

      expect(exitCode).toBe(0);
      expect(rendered).toContain('Agent Catalog');
      expect(rendered).toContain('Active Agent');
      expect(rendered).toContain('Agents (2)');
      expect(rendered).toContain('agent');
      expect(rendered).toContain('active');
      expect(rendered).toContain('Tools');
      expect(rendered).toContain('read_file');
      expect(rendered).toContain('configured');
      expect(rendered).toContain('approval: not required');
      expect(rendered).toContain('Delegate Skills (1)');
      expect(rendered).toContain('researcher');
      expect(rendered).toContain('allowedTools:');
      expect(rendered).not.toContain('catalog:\n');
    } finally {
      log.mockRestore();
    }
  });
});

describe('adaptive-agent config command', () => {
  let tempDir: string;
  let originalWebSearchProvider: string | undefined;
  let originalBraveApiKey: string | undefined;
  let originalSerperApiKey: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-config-'));
    originalWebSearchProvider = process.env.WEB_SEARCH_PROVIDER;
    originalBraveApiKey = process.env.BRAVE_SEARCH_API_KEY;
    originalSerperApiKey = process.env.SERPER_API_KEY;
    delete process.env.WEB_SEARCH_PROVIDER;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.SERPER_API_KEY;
    await writeAgentConfig(join(tempDir, 'agent.json'));
  });

  afterEach(async () => {
    if (originalWebSearchProvider === undefined) {
      delete process.env.WEB_SEARCH_PROVIDER;
    } else {
      process.env.WEB_SEARCH_PROVIDER = originalWebSearchProvider;
    }
    if (originalBraveApiKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = originalBraveApiKey;
    }
    if (originalSerperApiKey === undefined) {
      delete process.env.SERPER_API_KEY;
    } else {
      process.env.SERPER_API_KEY = originalSerperApiKey;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints the resolved web search provider in pretty output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main(['config', '--cwd', tempDir]);
      const rendered = log.mock.calls.map((call) => String(call[0])).join('\n');

      expect(exitCode).toBe(0);
      expect(rendered).toContain('model: ollama/qwen3.5');
      expect(rendered).toContain('webSearchProvider: duckduckgo');
    } finally {
      log.mockRestore();
    }
  });

  it('reports the API-backed web search provider when it will be used', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'brave';
    process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main(['config', '--cwd', tempDir, '--output', 'json']);
      const output = JSON.parse(String(log.mock.calls[0]?.[0])) as { webSearch?: { provider?: string } };

      expect(exitCode).toBe(0);
      expect(output.webSearch?.provider).toBe('brave');
    } finally {
      log.mockRestore();
    }
  });

  it('prints the resolved web search provider in pretty dry-run output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main(['run', '--dry-run', '--cwd', tempDir, 'hello']);
      const rendered = stripAnsi(log.mock.calls.map((call) => String(call[0])).join('\n'));

      expect(exitCode).toBe(0);
      expect(rendered).toContain('webSearchProvider');
      expect(rendered).toContain('duckduckgo');
    } finally {
      log.mockRestore();
    }
  });

  it('reports the resolved web search provider in json dry-run output', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'brave';
    process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main(['run', '--dry-run', '--cwd', tempDir, '--output', 'json', 'hello']);
      const output = JSON.parse(String(log.mock.calls[0]?.[0])) as { webSearch?: { provider?: string } };

      expect(exitCode).toBe(0);
      expect(output.webSearch?.provider).toBe('brave');
    } finally {
      log.mockRestore();
    }
  });
});

describe('adaptive-agent benchmark cases', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-bench-'));
    await mkdir(join(tempDir, 'fixtures'));
    await writeFile(join(tempDir, 'fixtures', 'image.png'), 'image');
    await writeFile(join(tempDir, 'fixtures', 'audio.mp3'), 'audio');
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

  it('normalizes GAIA audio attachments as audio content parts', async () => {
    const inputPath = join(tempDir, 'gaia-audio.jsonl');
    await writeFile(inputPath, JSON.stringify({
      task_id: 'gaia-audio-1',
      Question: 'What is said in the audio?',
      file_name: 'audio.mp3',
      'Final answer': 'hello',
    }));

    const cases = await loadGaiaBenchmarkCases(inputPath, tempDir, 'fixtures', 'validation');
    expect(cases).toEqual([{
      id: 'gaia-audio-1',
      dataset: 'gaia',
      split: 'validation',
      question: 'What is said in the audio?',
      contentParts: [{ type: 'audio', audio: { source: { kind: 'path', path: join(tempDir, 'fixtures', 'audio.mp3') }, format: 'mp3', name: 'audio.mp3' } }],
      expectedAnswer: 'hello',
      metadata: { source: 'gaia', fileName: 'audio.mp3', split: 'validation' },
    }]);
  });

  it('filters benchmark cases by attachment type', () => {
    const cases: BenchmarkCase[] = [
      { id: 'image', question: 'image?', images: [{ path: '/tmp/image.png' }] },
      { id: 'audio', question: 'audio?', contentParts: [{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.mp3' }, format: 'mp3' } }] },
      { id: 'video', question: 'video?', contentParts: [{ type: 'file', file: { source: { kind: 'path', path: '/tmp/video.mp4' } } }] },
      { id: 'other', question: 'file?', contentParts: [{ type: 'file', file: { source: { kind: 'path', path: '/tmp/notes.pdf' } } }] },
      { id: 'mixed', question: 'mixed?', images: [{ path: '/tmp/image.png' }], contentParts: [{ type: 'file', file: { source: { kind: 'path', path: '/tmp/notes.pdf' } } }] },
      { id: 'none', question: 'no attachment?' },
    ];

    expect(selectIdsByType(cases, 'image')).toEqual(['image', 'mixed']);
    expect(selectIdsByType(cases, 'audio')).toEqual(['audio']);
    expect(selectIdsByType(cases, 'video')).toEqual(['video']);
    expect(selectIdsByType(cases, 'other')).toEqual(['other', 'mixed']);
  });

  it('summarizes GAIA dry-run task attachment details', async () => {
    const inputPath = join(tempDir, 'gaia-dry-run.jsonl');
    await writeFile(inputPath, [
      JSON.stringify({ task_id: 'gaia-image', Question: 'What is in the image?', file_name: 'image.png', Level: '1' }),
      JSON.stringify({ task_id: 'gaia-none', Question: 'No attachment' }),
    ].join('\n'));

    const cases = await loadGaiaBenchmarkCases(inputPath, tempDir, 'fixtures', 'validation');

    expect(summarizeGaiaDryRunTasks(cases)).toEqual([
      {
        taskId: 'gaia-image',
        attachmentType: 'image',
        fileName: 'image.png',
        path: join(tempDir, 'fixtures', 'image.png'),
        level: '1',
        split: 'validation',
      },
      {
        taskId: 'gaia-none',
        attachmentType: 'none',
        split: 'validation',
      },
    ]);
  });

  it('dry-runs eval cases without requiring an output path', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    const inputPath = join(tempDir, 'cases-dry-run.jsonl');
    await writeFile(inputPath, JSON.stringify({ id: 'case-1', question: 'What is 2+2?' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main(['eval', 'cases', '--input', inputPath, '--cwd', tempDir, '--swarm', '2', '--dry-run', '--output', 'json']);
      const output = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;

      expect(exitCode).toBe(0);
      expect(output.dryRun).toBe(true);
      expect(output).not.toHaveProperty('gaiaTasks');
      expect(output.benchmark).toMatchObject({ dataset: 'cases', selectedCases: 1, totalCases: 1, requests: 0, swarm: 2 });
      expect(output.tools).toEqual(['read_file']);
    } finally {
      log.mockRestore();
    }
  });

  it('dry-runs eval gaia and lists task attachment details', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    const inputPath = join(tempDir, 'gaia-dry-run-main.jsonl');
    await writeFile(inputPath, JSON.stringify({
      task_id: 'gaia-1',
      Question: 'What is in the image?',
      file_name: 'image.png',
      Level: '1',
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main([
        'eval', 'gaia',
        '--input', inputPath,
        '--files-dir', 'fixtures',
        '--split', 'validation',
        '--cwd', tempDir,
        '--dry-run',
        '--output', 'json',
      ]);
      const output = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;

      expect(exitCode).toBe(0);
      expect(output.benchmark).toMatchObject({ dataset: 'gaia', selectedCases: 1, totalCases: 1, requests: 0 });
      expect(output.gaiaTaskCount).toBe(1);
      expect(output.gaiaTasks).toEqual([{
        taskId: 'gaia-1',
        attachmentType: 'image',
        fileName: 'image.png',
        path: join(tempDir, 'fixtures', 'image.png'),
        level: '1',
        split: 'validation',
      }]);
    } finally {
      log.mockRestore();
    }
  });

  it('preserves settings env for eval gaia dry-run when interaction flags override settings', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({
      env: {
        WEB_SEARCH_PROVIDER: 'serper',
        SERPER_API_KEY: 'serper-key',
      },
    }));
    const inputPath = join(tempDir, 'gaia-dry-run-serper.jsonl');
    await writeFile(inputPath, JSON.stringify({
      task_id: 'gaia-1',
      Question: 'What is 2+2?',
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const exitCode = await main([
        'eval', 'gaia',
        '--input', inputPath,
        '--cwd', tempDir,
        '--dry-run',
        '--output', 'json',
        '--approval', 'auto',
        '--clarification', 'fail',
      ]);
      const output = JSON.parse(String(log.mock.calls[0]?.[0])) as { webSearch?: { provider?: string } };

      expect(exitCode).toBe(0);
      expect(output.webSearch?.provider).toBe('serper');
    } finally {
      log.mockRestore();
    }
  });

  it('rejects swarm eval runs with interactive settings', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    const inputPath = join(tempDir, 'cases-swarm-interactive.jsonl');
    await writeFile(inputPath, JSON.stringify({ id: 'case-1', question: 'What is 2+2?' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(main([
        'eval', 'cases',
        '--input', inputPath,
        '--out', join(tempDir, 'results.jsonl'),
        '--cwd', tempDir,
        '--swarm', '2',
      ])).rejects.toThrow('--swarm > 1 requires non-interactive eval settings');
    } finally {
      log.mockRestore();
    }
  });
});

function selectIdsByType(cases: BenchmarkCase[], evalType: BenchmarkAttachmentType): string[] {
  return selectBenchmarkCases(cases, { evalOffset: 0, evalType } as ManualTestCliOptions, new Set()).map((benchmarkCase) => benchmarkCase.id);
}

async function writeAgentConfig(path: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      id: 'agent',
      name: 'Agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: ['read_file'],
    }),
  );
}

describe('adaptive-agent pretty rendering', () => {
  it('formats decomposed swarm subtasks for CLI output', () => {
    const rendered = formatSwarmSubtasks([
      { id: 'subtask-1', subObjective: 'Research the market.', targetAgentId: 'market' },
      { id: 'subtask-2', subObjective: 'Draft the pricing model.', targetAgentId: 'pricing' },
    ]);

    expect(rendered).toBe([
      'subtasks:',
      '  1. subtask-1 -> market: Research the market.',
      '  2. subtask-2 -> pricing: Draft the pricing model.',
    ].join('\n'));
  });

  it('wraps long swarm subtasks under the objective column', () => {
    const rendered = formatSwarmSubtasks([
      {
        id: 'subtask-1',
        subObjective: 'Step 1 - Core Architectural Paradigms: Conduct a comprehensive survey of agent systems and compare patterns.',
        targetAgentId: 'default-agent',
      },
    ], 72);

    expect(rendered).toBe([
      'subtasks:',
      '  1. subtask-1 -> default-agent: Step 1 - Core Architectural Paradigms:',
      '                                 Conduct a comprehensive survey of agent',
      '                                 systems and compare patterns.',
    ].join('\n'));
  });

  it('formats the swarm execution plan with session, coordinator, and subtasks', () => {
    const rendered = formatSwarmExecutionPlan('session-1', 'coordinator-run-1', [
      { id: 'subtask-1', subObjective: 'Research the market.', targetAgentId: 'market' },
      { id: 'subtask-2', subObjective: 'Draft the pricing model.', targetAgentId: 'pricing' },
    ]);

    expect(rendered).toBe([
      'orchestration: session=session-1 coordinator=coordinator-run-1',
      'subtasks:',
      '  1. subtask-1 -> market: Research the market.',
      '  2. subtask-2 -> pricing: Draft the pricing model.',
    ].join('\n'));
  });

  it('formats swarm run statuses with one worker per line', () => {
    const rendered = formatSwarmRunStatuses({
      subtaskResults: [
        { subtaskId: 'subtask-1', runId: 'run-1', status: 'succeeded' },
        { subtaskId: 'subtask-2', runId: 'run-2', status: 'failed', errorCode: 'MODEL_ERROR' },
      ],
      qualityRunId: 'quality-run-1',
      synthesizerRunId: 'synth-run-1',
    });

    expect(rendered).toBe([
      'runs:',
      '  workers:',
      '    - subtask-1: run=run-1 status=succeeded',
      '    - subtask-2: run=run-2 status=failed error=MODEL_ERROR',
      '  quality: run=quality-run-1',
      '  synthesizer: run=synth-run-1',
    ].join('\n'));
  });

  it('renders object summaries for coordinator decomposition failures', () => {
    const rendered = formatCoordinatorDecompositionFailure({
      status: 'failure',
      runId: 'coordinator-run-1',
      code: 'MODEL_ERROR',
      error: 'Upstream provider returned an error.',
      stepsUsed: 1,
      usage: {
        promptTokens: 10,
        completionTokens: 0,
        estimatedCostUSD: 0,
        provider: 'mesh',
        model: 'qwen/qwen3.5',
      },
    });

    expect(rendered).toContain('Coordinator decomposition failed:');
    expect(rendered).toContain('"status": "failure"');
    expect(rendered).toContain('"code": "MODEL_ERROR"');
    expect(rendered).toContain('"error": "Upstream provider returned an error."');
    expect(rendered).not.toContain('[object Object]');
  });

  it('renders markdown strings for pretty output', () => {
    const rendered = renderPrettyString('# Heading\n\n- one\n- two');
    expect(rendered).toContain('Heading');
    expect(rendered).toContain('one');
    expect(rendered).toContain('two');
  });

  it('does not wrap markdown list items in reset-only ANSI sequences', () => {
    const rendered = renderPrettyString([
      '### Important Notes',
      '',
      '* Simon Willison has **967 repositories** on GitHub',
      '* He has published **354 projects** on PyPI',
    ].join('\n'));

    expect(rendered).not.toContain('\x1B[0m');
    expect(stripAnsi(rendered)).not.toContain('0mSimon Willison');
    expect(stripAnsi(rendered)).not.toContain('GitHub0m');
  });

  it('styles CLI assistant output using tui message settings', () => {
    const rendered = stripAnsi(renderStyledPrettyMessage('assistant', '# Heading', {
      messages: {
        assistant: {
          prefix: 'magenta',
          body: 'cyan',
        },
      },
    }));

    expect(rendered).toContain('assistant>');
    expect(rendered).toContain('Heading');
  });

  it('omits the prefix when the configured message style disables it', () => {
    const rendered = stripAnsi(renderStyledPrettyMessage('progress', 'Checking available data', {
      messages: {
        progress: {
          showPrefix: false,
          body: 'green',
        },
      },
    }));

    expect(rendered.trim()).toBe('\u29bf Checking available data');
  });

  it('keeps the prefix and first content line together when the content starts with a newline', () => {
    const rendered = stripAnsi(renderStyledPrettyMessage('assistant', '\nLeading line', {
      messages: {
        assistant: {
          prefix: 'green',
        },
      },
    }));

    expect(rendered.startsWith('assistant> Leading line')).toBe(true);
  });

  it('trims trailing blank lines from rendered CLI messages', () => {
    const rendered = stripAnsi(renderStyledPrettyMessage('progress', 'Checking available data', {
      messages: {
        progress: {
          prefix: 'green',
        },
      },
    }));

    expect(rendered.endsWith('\n')).toBe(false);
    expect(rendered).toBe('progress> Checking available data');
  });
});

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
