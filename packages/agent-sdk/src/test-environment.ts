export function testEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = overrides.HOME ?? process.env.HOME;
  const adaptiveAgentHome = overrides.ADAPTIVE_AGENT_HOME ?? process.env.ADAPTIVE_AGENT_HOME;
  if (!home || !adaptiveAgentHome) {
    throw new Error('Tests must provide isolated HOME and ADAPTIVE_AGENT_HOME values');
  }
  return {
    ...overrides,
    HOME: home,
    ADAPTIVE_AGENT_HOME: adaptiveAgentHome,
  };
}
