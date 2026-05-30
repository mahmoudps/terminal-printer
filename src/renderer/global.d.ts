import type { AgentBridge } from '@shared/ipc'

declare global {
  interface Window {
    agent: AgentBridge
  }
}

export {}
