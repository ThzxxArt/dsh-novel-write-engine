import { vi } from 'vitest'

export interface RegisteredTool {
  name: string
}

export interface RegisteredCommand {
  name: string
  handler: (invocation: { rawInput: string; signal: AbortSignal }) => Promise<unknown>
}

export interface RegisteredSkill {
  name: string
  content: string
}

export interface FakeHost {
  tools: RegisteredTool[]
  commands: RegisteredCommand[]
  skills: RegisteredSkill[]
  routes: Array<{ kind: string; path: string; handler: (...args: never[]) => unknown }>
  effects: Array<() => void>
  events: Array<{ name: string; payload: unknown }>
  provided: Record<string, unknown>
  ctx: Record<string, unknown>
  dispose: () => void
}

/**
 * A minimal host that satisfies the twelve primitives `apply()` touches.
 * Effects run immediately and their disposers are collected, so lifecycle bugs
 * surface without booting Cordis.
 */
export function fakeHost(
  services: string[] = ['tools', 'commands', 'skills', 'webServer'],
  connectionMode: 'scoped' | 'get' = 'scoped',
): FakeHost {
  const host: FakeHost = {
    tools: [],
    commands: [],
    skills: [],
    routes: [],
    effects: [],
    events: [],
    provided: {},
    dispose: () => undefined,
    ctx: {},
  }
  const connection = {
    admit: vi.fn((request: { headers?: Record<string, string> }) =>
      request.headers?.host === 'evil.example' ? { rejection: 403 } : { peer: { id: 'test' } },
    ),
  }
  const scoped = {
    commands: {
      register: vi.fn((command: RegisteredCommand) => {
        host.commands.push(command)
      }),
    },
    skills: {
      register: vi.fn((skill: RegisteredSkill) => {
        host.skills.push(skill)
      }),
    },
    webServer: {
      register: vi.fn((route: { kind: string; path: string; handler: (...args: never[]) => unknown }) => {
        host.routes.push(route)
      }),
    },
    ...(connectionMode === 'scoped' ? { connection } : {}),
    effect: vi.fn((body: () => (() => void) | undefined) => {
      const disposer = body()
      if (typeof disposer === 'function') host.effects.push(disposer)
    }),
  }
  host.ctx = {
    tools: {
      register: vi.fn((tool: RegisteredTool) => {
        host.tools.push(tool)
      }),
    },
    get: vi.fn((name: string) =>
      connectionMode === 'get' && name === 'connection' ? connection : undefined,
    ),
    inject: vi.fn((wanted: string[], body: (scope: unknown) => void) => {
      if (wanted.every((service) => services.includes(service))) body(scoped)
    }),
    effect: vi.fn((body: () => (() => void) | undefined, label?: string) => {
      void label
      const disposer = body()
      if (typeof disposer === 'function') host.effects.push(disposer)
    }),
    emit: vi.fn((name: string, payload: unknown) => {
      host.events.push({ name, payload })
    }),
    provide: vi.fn((name: string, value: unknown) => {
      host.provided[name] = value
    }),
  }
  host.dispose = () => {
    for (const disposer of host.effects.reverse()) disposer()
  }
  return host
}
