export class ConfigValidationError extends Error {
  readonly issues: string[];
  readonly configType: 'gateway' | 'agent';
  readonly sourcePath: string;

  constructor(configType: 'gateway' | 'agent', sourcePath: string, issues: string[]) {
    super(`Invalid ${configType} config at ${sourcePath}:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
    this.configType = configType;
    this.sourcePath = sourcePath;
  }
}

export class RegistryResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryResolutionError';
  }
}
