import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadSkillFromDirectory, loadSkillFromFile, parseSkillMarkdown, SkillLoadError } from './load-skill.js';
import { skillToDelegate, skillsToDelegate } from './skill-to-delegate.js';
import type { SkillDefinition } from './types.js';
import type { ToolDefinition } from '../types.js';

// ── parseSkillMarkdown ──────────────────────────────────────────────────────

describe('parseSkillMarkdown', () => {
  const originalMeshApiKey = process.env.MESH_API_KEY;

  afterEach(() => {
    if (originalMeshApiKey === undefined) {
      delete process.env.MESH_API_KEY;
    } else {
      process.env.MESH_API_KEY = originalMeshApiKey;
    }
  });

  it('parses a standard SKILL.md with name, description, and body', () => {
    const md = `---
name: researcher
description: Research facts and return structured findings
---

# Researcher

You are a research agent. Use the available tools to find information.

## Guidelines

- Cite sources
- Be thorough
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.name).toBe('researcher');
    expect(skill.description).toBe('Research facts and return structured findings');
    expect(skill.instructions).toContain('# Researcher');
    expect(skill.instructions).toContain('Cite sources');
    expect(skill.allowedTools).toEqual([]);
    expect(skill.triggers).toBeUndefined();
  });

  it('parses triggers as a list', () => {
    const md = `---
name: code-review
description: Perform a code review
triggers:
  - review code
  - code review
  - review this
---

Review the code carefully.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.triggers).toEqual(['review code', 'code review', 'review this']);
  });

  it('parses allowedTools from frontmatter', () => {
    const md = `---
name: file-worker
description: Works with files
allowedTools:
  - read_file
  - write_file
  - list_directory
---

Work with local files.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.allowedTools).toEqual(['read_file', 'write_file', 'list_directory']);
  });

  it('options.allowedTools overrides frontmatter allowedTools', () => {
    const md = `---
name: file-worker
description: Works with files
allowedTools:
  - read_file
---

Work with local files.
`;

    const skill = parseSkillMarkdown(md, 'test', {
      allowedTools: ['read_file', 'write_file'],
    });

    expect(skill.allowedTools).toEqual(['read_file', 'write_file']);
  });

  it('parses model overrides from dotted frontmatter', () => {
    process.env.MESH_API_KEY = 'mesh-test-key';
    const md = `---
name: log-analyser
description: Analyze gateway and runtime logs
model.provider: mesh
model.model: google/gemma-4-26b-a4b-it
model.apiKeyEnv: MESH_API_KEY
allowedTools:
  - read_file
  - list_directory
---

Analyze logs carefully.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.model?.provider).toBe('mesh');
    expect(skill.model?.model).toBe('google/gemma-4-26b-a4b-it');
  });

  it('requires apiKeyEnv to resolve when a provider needs an API key', () => {
    delete process.env.MESH_API_KEY;
    const md = `---
name: log-analyser
description: Analyze gateway and runtime logs
model.provider: mesh
model.model: google/gemma-4-26b-a4b-it
model.apiKeyEnv: MESH_API_KEY
---

Analyze logs carefully.
`;

    expect(() => parseSkillMarkdown(md, 'test')).toThrow(
      "requires environment variable 'MESH_API_KEY' for model.apiKeyEnv",
    );
  });

  it('rejects inline model API keys in skill frontmatter', () => {
    const md = `---
name: log-analyser
description: Analyze gateway and runtime logs
model.provider: mesh
model.model: google/gemma-4-26b-a4b-it
model.apiKey: inline-secret
---

Analyze logs carefully.
`;

    expect(() => parseSkillMarkdown(md, 'test')).toThrow(
      "must use 'model.apiKeyEnv' instead of inline 'model.apiKey'",
    );
  });

  it('loads the bundled log-analyser skill as a Mesh-backed delegate profile', async () => {
    process.env.MESH_API_KEY = 'mesh-test-key';
    const skillDir = fileURLToPath(new URL('../../../../examples/skills/log-analyser', import.meta.url));

    const skill = await loadSkillFromDirectory(skillDir);
    const delegate = skillToDelegate(skill);

    expect(delegate.name).toBe('log-analyser');
    expect(delegate.allowedTools).toEqual(['list_directory', 'read_file', 'write_file']);
    expect(delegate.model?.provider).toBe('mesh');
    expect(delegate.model?.model).toBe('google/gemma-4-26b-a4b-it');
  });

  it('loads the bundled file-converter skill with a handler-backed tool', async () => {
    const skillDir = fileURLToPath(new URL('../../../../examples/skills/file-converter', import.meta.url));

    const skill = await loadSkillFromDirectory(skillDir);
    const delegate = skillToDelegate(skill);

    expect(delegate.name).toBe('file-converter');
    expect(delegate.allowedTools).toEqual([]);
    expect(delegate.handlerTools).toHaveLength(1);
    expect(delegate.handlerTools?.[0]?.name).toBe('convert_document_with_pandoc');
    expect(delegate.handlerTools?.[0]?.description).toContain('pandoc');
  });

  it('handles quoted description values', () => {
    const md = `---
name: prd
description: "Generate a PRD for a new feature."
---

Create a PRD.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.description).toBe('Generate a PRD for a new feature.');
  });

  it('handles single-quoted values', () => {
    const md = `---
name: test
description: 'A single-quoted desc'
---

Body here.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.description).toBe('A single-quoted desc');
  });

  it('throws SkillLoadError when frontmatter is missing', () => {
    const md = `# No Frontmatter

Just a regular markdown file.
`;

    expect(() => parseSkillMarkdown(md, 'test')).toThrow(SkillLoadError);
    expect(() => parseSkillMarkdown(md, 'test')).toThrow('missing YAML frontmatter');
  });

  it('throws SkillLoadError when name is missing', () => {
    const md = `---
description: Something
---

Body.
`;

    expect(() => parseSkillMarkdown(md, 'test')).toThrow(SkillLoadError);
    expect(() => parseSkillMarkdown(md, 'test')).toThrow("missing required field 'name'");
  });

  it('throws SkillLoadError when description is missing', () => {
    const md = `---
name: test
---

Body.
`;

    expect(() => parseSkillMarkdown(md, 'test')).toThrow(SkillLoadError);
    expect(() => parseSkillMarkdown(md, 'test')).toThrow("missing required field 'description'");
  });

  it('throws SkillLoadError when body is empty', () => {
    const md = `---
name: test
description: A test
---
`;

    expect(() => parseSkillMarkdown(md, 'test')).toThrow(SkillLoadError);
    expect(() => parseSkillMarkdown(md, 'test')).toThrow('no instruction body');
  });

  it('handles leading whitespace before frontmatter', () => {
    const md = `
---
name: spaced
description: Has leading space
---

Instructions here.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.name).toBe('spaced');
  });

  it('ignores comment lines in frontmatter', () => {
    const md = `---
name: commented
# This is a comment
description: Has comments
---

Body.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.name).toBe('commented');
    expect(skill.description).toBe('Has comments');
  });

  it('parses handler field from frontmatter', () => {
    const md = `---
name: calculator
description: Calculate things
handler: handler.ts
---

Calculate stuff.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.handler).toBe('handler.ts');
  });

  it('parses delegate defaults from dotted frontmatter keys', () => {
    const md = `---
name: code-executor
description: Execute code
defaults.toolTimeoutMs: 120000
defaults.modelTimeoutMs: 0
defaults.maxSteps: 12
defaults.autoApproveAll: true
defaults.capture: full
---

Execute code carefully.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.defaults).toEqual({
      toolTimeoutMs: 120000,
      modelTimeoutMs: 0,
      maxSteps: 12,
      autoApproveAll: true,
      capture: 'full',
    });
  });

  it('throws for invalid dotted default values', () => {
    const md = `---
name: code-executor
description: Execute code
defaults.toolTimeoutMs: nope
---

Execute code carefully.
`;

    expect(() => parseSkillMarkdown(md, 'test')).toThrow(SkillLoadError);
    expect(() => parseSkillMarkdown(md, 'test')).toThrow("invalid integer for 'defaults.toolTimeoutMs'");
  });

  it('sets handler to undefined when not present', () => {
    const md = `---
name: plain
description: No handler
---

Just instructions.
`;

    const skill = parseSkillMarkdown(md, 'test');

    expect(skill.handler).toBeUndefined();
  });
});

// ── loadSkillFromDirectory / loadSkillFromFile ───────────────────────────────

describe('loadSkillFromDirectory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-load-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads a skill from a directory containing SKILL.md', async () => {
    const skillDir = join(tempDir, 'researcher');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: researcher
description: Research a topic
allowedTools:
  - web_search
  - read_web_page
---

# Researcher

You research topics thoroughly.
`,
    );

    const skill = await loadSkillFromDirectory(skillDir);

    expect(skill.name).toBe('researcher');
    expect(skill.description).toBe('Research a topic');
    expect(skill.allowedTools).toEqual(['web_search', 'read_web_page']);
    expect(skill.instructions).toContain('# Researcher');
  });

  it('throws when SKILL.md does not exist', async () => {
    await expect(loadSkillFromDirectory(tempDir)).rejects.toThrow();
  });

  it('accepts allowedTools override via options', async () => {
    const skillDir = join(tempDir, 'writer');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: writer
description: Write documents
---

Write well.
`,
    );

    const skill = await loadSkillFromDirectory(skillDir, {
      allowedTools: ['write_file', 'read_file'],
    });

    expect(skill.allowedTools).toEqual(['write_file', 'read_file']);
  });

  it('loads a handler module and populates handlerTools', async () => {
    const skillDir = join(tempDir, 'calc');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: calc
description: A calculator
handler: handler.ts
---

Calculate things.
`,
    );
    await writeFile(
      join(skillDir, 'handler.ts'),
      `
export const name = 'calc_add';
export const description = 'Add two numbers';
export const inputSchema = {
  type: 'object',
  required: ['a', 'b'],
  properties: { a: { type: 'number' }, b: { type: 'number' } },
};
export async function execute(input) {
  return { result: input.a + input.b };
}
`,
    );

    const skill = await loadSkillFromDirectory(skillDir);

    expect(skill.handler).toBe('handler.ts');
    expect(skill.handlerTools).toHaveLength(1);

    const tool = skill.handlerTools![0];
    expect(tool.name).toBe('calc_add');
    expect(tool.description).toBe('Add two numbers');

    const output = await tool.execute({ a: 2, b: 3 } as any, {} as any);
    expect(output).toEqual({ result: 5 });
  });

  it('uses default tool name when handler does not export name', async () => {
    const skillDir = join(tempDir, 'anon');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: anon-skill
description: Anonymous handler
handler: handler.ts
---

Do things.
`,
    );
    await writeFile(
      join(skillDir, 'handler.ts'),
      `
export async function execute(input) {
  return { ok: true };
}
`,
    );

    const skill = await loadSkillFromDirectory(skillDir);

    expect(skill.handlerTools).toHaveLength(1);
    expect(skill.handlerTools![0].name).toBe('skill.anon-skill.handler');
  });

  it('throws when handler module does not exist', async () => {
    const skillDir = join(tempDir, 'missing');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: missing
description: Missing handler
handler: not-here.ts
---

Instructions.
`,
    );

    await expect(loadSkillFromDirectory(skillDir)).rejects.toThrow(SkillLoadError);
    await expect(loadSkillFromDirectory(skillDir)).rejects.toThrow('not found');
  });

  it('throws when handler module does not export execute', async () => {
    const skillDir = join(tempDir, 'no-exec');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: no-exec
description: No execute export
handler: handler.ts
---

Instructions.
`,
    );
    await writeFile(
      join(skillDir, 'handler.ts'),
      `export const name = 'broken';`,
    );

    await expect(loadSkillFromDirectory(skillDir)).rejects.toThrow(SkillLoadError);
    await expect(loadSkillFromDirectory(skillDir)).rejects.toThrow('must export an execute');
  });

  it('does not populate handlerTools when handler is absent', async () => {
    const skillDir = join(tempDir, 'no-handler');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: no-handler
description: Context only
---

Just instructions.
`,
    );

    const skill = await loadSkillFromDirectory(skillDir);

    expect(skill.handler).toBeUndefined();
    expect(skill.handlerTools).toBeUndefined();
  });
});

describe('loadSkillFromFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-file-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads a skill directly from a file path', async () => {
    const filePath = join(tempDir, 'MY_SKILL.md');
    await writeFile(
      filePath,
      `---
name: direct-load
description: Loaded from file
---

Instructions for direct load.
`,
    );

    const skill = await loadSkillFromFile(filePath);

    expect(skill.name).toBe('direct-load');
    expect(skill.instructions).toContain('Instructions for direct load');
  });
});

// ── skillToDelegate / skillsToDelegate ──────────────────────────────────────

describe('skillToDelegate', () => {
  const baseSkill: SkillDefinition = {
    name: 'researcher',
    description: 'Research topics using web tools',
    instructions: '# Researcher\n\nYou research topics thoroughly.',
    allowedTools: ['web_search', 'read_web_page'],
  };

  it('converts a skill to a delegate definition', () => {
    const delegate = skillToDelegate(baseSkill);

    expect(delegate.name).toBe('researcher');
    expect(delegate.description).toBe('Research topics using web tools');
    expect(delegate.instructions).toBe('# Researcher\n\nYou research topics thoroughly.');
    expect(delegate.allowedTools).toEqual(['web_search', 'read_web_page']);
    expect(delegate.model).toBeUndefined();
    expect(delegate.defaults).toBeUndefined();
  });

  it('carries through optional model and defaults', () => {
    const skill: SkillDefinition = {
      ...baseSkill,
      model: {
        provider: 'ollama',
        model: 'llama3.2',
        capabilities: { toolCalling: true, jsonOutput: true, streaming: false, usage: false },
        generate: async () => ({ finishReason: 'stop' }),
      },
      defaults: { maxSteps: 10, toolTimeoutMs: 30_000 },
    };

    const delegate = skillToDelegate(skill);

    expect(delegate.model?.provider).toBe('ollama');
    expect(delegate.defaults?.maxSteps).toBe(10);
  });

  it('does not include skill-only fields (triggers, schemas) in the delegate', () => {
    const skill: SkillDefinition = {
      ...baseSkill,
      triggers: ['research', 'look up'],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };

    const delegate = skillToDelegate(skill);

    expect(delegate).not.toHaveProperty('triggers');
    expect(delegate).not.toHaveProperty('inputSchema');
    expect(delegate).not.toHaveProperty('outputSchema');
  });

  it('carries handlerTools through to the delegate', () => {
    const handlerTool: ToolDefinition = {
      name: 'skill.researcher.handler',
      description: 'Handler tool',
      inputSchema: { type: 'object' },
      execute: async () => ({ ok: true }),
    };

    const skill: SkillDefinition = {
      ...baseSkill,
      handlerTools: [handlerTool],
    };

    const delegate = skillToDelegate(skill);

    expect(delegate.handlerTools).toHaveLength(1);
    expect(delegate.handlerTools![0].name).toBe('skill.researcher.handler');
  });

  it('sets handlerTools to undefined when skill has no handler', () => {
    const delegate = skillToDelegate(baseSkill);

    expect(delegate.handlerTools).toBeUndefined();
  });
});

describe('skillsToDelegate', () => {
  it('converts multiple skills at once', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'researcher',
        description: 'Research things',
        instructions: 'Research carefully.',
        allowedTools: ['web_search'],
      },
      {
        name: 'writer',
        description: 'Write things',
        instructions: 'Write clearly.',
        allowedTools: ['write_file'],
      },
    ];

    const delegates = skillsToDelegate(skills);

    expect(delegates).toHaveLength(2);
    expect(delegates[0].name).toBe('researcher');
    expect(delegates[1].name).toBe('writer');
  });
});
