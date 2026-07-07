import { defaultExec, type ExecFn } from './cli-adapter.js'

export interface DetectedAgent {
  name: string      // binary name, e.g. "claude"
  adapter: string   // looprail adapter id, e.g. "claude-code"
  command: string   // binary probed on PATH
  available: boolean
  version?: string
  fixHint: string   // install/login one-liner for `looprail doctor`
}

const KNOWN = [
  {
    name: 'claude', adapter: 'claude-code', command: 'claude',
    fixHint: 'npm i -g @anthropic-ai/claude-code, then run `claude` once to log in',
  },
  {
    name: 'codex', adapter: 'codex', command: 'codex',
    fixHint: 'npm i -g @openai/codex, then `codex login`',
  },
  {
    name: 'aider', adapter: 'aider', command: 'aider',
    fixHint: 'install aider (https://aider.chat), set your provider API key env var',
  },
  {
    name: 'gh', adapter: 'copilot-cli', command: 'gh',
    fixHint: 'install GitHub CLI, then `gh auth login` and `gh extension install github/gh-copilot`',
  },
  {
    name: 'gemini', adapter: 'gemini', command: 'gemini',
    fixHint: 'npm i -g @google/gemini-cli, then run `gemini` once to log in (or set GEMINI_API_KEY)',
  },
  {
    name: 'opencode', adapter: 'opencode', command: 'opencode',
    fixHint: 'npm i -g opencode-ai, then `opencode auth login` to add a provider credential',
  },
  {
    name: 'ollama', adapter: 'ollama', command: 'ollama',
    fixHint: 'install ollama from https://ollama.com/download, then `ollama pull <model>` (no login needed)',
  },
] as const

export async function detectAgents(exec: ExecFn = defaultExec): Promise<DetectedAgent[]> {
  return Promise.all(
    KNOWN.map(async (k): Promise<DetectedAgent> => {
      const found = await exec('/bin/sh', ['-c', `command -v ${k.command}`])
      if (found.exitCode !== 0) return { ...k, available: false }
      const ver = await exec(k.command, ['--version'])
      const version = ver.exitCode === 0 ? ver.stdout.trim().split('\n')[0] : undefined
      return { ...k, available: true, ...(version ? { version } : {}) }
    }),
  )
}
