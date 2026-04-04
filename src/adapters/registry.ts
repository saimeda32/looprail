import type { Adapter } from '../core/types.js'

export interface AdapterRegistry {
  register(adapter: Adapter): void
  get(name: string): Adapter
}

export function createRegistry(): AdapterRegistry {
  const adapters = new Map<string, Adapter>()
  return {
    register(adapter) { adapters.set(adapter.name, adapter) },
    get(name) {
      const a = adapters.get(name)
      if (!a) throw new Error(`unknown adapter "${name}" — is it registered?`)
      return a
    },
  }
}
