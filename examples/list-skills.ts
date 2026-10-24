#!/usr/bin/env bun
/**
 * List all skills in the examples/skills directory along with their metadata.
 *
 * Usage:
 *   bun run examples/list-skills.ts
 */

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadSkillFromDirectory } from '@adaptive-agent/core';

const SKILLS_DIR = resolve(import.meta.dir, 'skills');

const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

console.log(`\n📂 Skills directory: ${SKILLS_DIR}`);
console.log(`   Found ${skillDirs.length} skill(s)\n`);

for (const dir of skillDirs) {
  const skillPath = resolve(SKILLS_DIR, dir);
  try {
    const skill = await loadSkillFromDirectory(skillPath);

    console.log(`${'─'.repeat(60)}`);
    console.log(`📋 ${skill.name}`);
    console.log(`   Description:   ${skill.description}`);
    console.log(`   Allowed tools: ${skill.allowedTools.length > 0 ? skill.allowedTools.join(', ') : '(none)'}`);

    if (skill.triggers && skill.triggers.length > 0) {
      console.log(`   Triggers:      ${skill.triggers.join(', ')}`);
    }

    if (skill.handler) {
      console.log(`   Handler:       ${skill.handler}`);
    }

    if (skill.handlerTools && skill.handlerTools.length > 0) {
      for (const tool of skill.handlerTools) {
        console.log(`   Handler tool:  ${tool.name}`);
        if (tool.description) {
          console.log(`     Description: ${tool.description}`);
        }
        if (tool.inputSchema && typeof tool.inputSchema === 'object' && 'properties' in tool.inputSchema) {
          const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>;
          const required = (tool.inputSchema as { required?: string[] }).required ?? [];
          const paramNames = Object.keys(props);
          if (paramNames.length > 0) {
            console.log(`     Parameters:`);
            for (const param of paramNames) {
              const p = props[param];
              const req = required.includes(param) ? ' (required)' : '';
              console.log(`       - ${param}: ${p.type ?? 'unknown'}${req}${p.description ? ` — ${p.description}` : ''}`);
            }
          }
        }
      }
    }

    console.log('');
  } catch (error) {
    console.log(`${'─'.repeat(60)}`);
    console.log(`⚠️  ${dir}: failed to load — ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
