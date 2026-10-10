import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';

export async function promptYesNo(question: string): Promise<boolean> {
  return ['y', 'yes'].includes((await promptText(question)).trim().toLowerCase());
}

export async function promptText(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
