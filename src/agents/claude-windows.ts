// Stub: Task 5 replaces this with the full Windows SSH provisioner.
import type { AgentConfig } from '../contracts/agent-config.ts';

export class WindowsClaudeAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }
  provision(): Record<string, string> {
    return {};
  }
}
