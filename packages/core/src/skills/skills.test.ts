import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadSkillFromDirectory, loadSkillFromFile, parseSkillMarkdown, SkillLoadError } from './load-skill.js';
import { skillToDelegate, skillsToDelegate } from './skill-to-delegate.js';
import type { SkillDefinition } from './types.js';

// ── parseSkillMarkdown ──────────────────────────────────────────────────────

describe('parseSkillMarkdown', () => {
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
