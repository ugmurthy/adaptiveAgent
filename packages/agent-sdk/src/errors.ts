export class AgentConfigValidationError extends Error {
  constructor(readonly sourcePath: string, readonly issues: string[]) {
    super(`Invalid agent config at ${sourcePath}:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'AgentConfigValidationError';
  }
}

export class AgentSettingsValidationError extends Error {
  constructor(readonly sourcePath: string, readonly issues: string[]) {
    super(`Invalid agent settings at ${sourcePath}:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'AgentSettingsValidationError';
  }
}

export class AgentSdkLookupError extends Error {
  constructor(kind: string, readonly candidates: string[]) {
    super(`No ${kind} file found. Lookup order:\n${candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join('\n')}`);
    this.name = 'AgentSdkLookupError';
  }
}
