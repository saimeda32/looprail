export interface McpToolDeps {
  cwd: string
  // Override for tests - never touches a real $HOME. Matches Plan 3b's own
  // RunDeps.registryPath / UiAllActionOpts.registryPath convention exactly.
  // Only consumed once list_workspaces / list_runs's allWorkspaces mode
  // exists (this task); every other tool ignores it.
  registryPath?: string
}
