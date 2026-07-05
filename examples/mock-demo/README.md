# mock-demo

The smallest possible looprail loop, using the built-in `mock` adapter
instead of a real agent CLI - no API keys, no installed tools, nothing to
configure.

**What it demonstrates:** the full plan → execute → test → critique shape
end to end (`plan → do → check/crit`) with zero external dependencies. This
is the fastest way to see what a loop's console output, journal, and
dashboard look like before wiring up a real agent.

**Run it:**

```bash
cp examples/mock-demo/looprail.yaml .
looprail run --ui
```

**Adapt it:** this one isn't meant to be adapted - swap `adapter: mock` for
a real adapter (`copilot-cli`, `claude-code`, `codex`, ...) once you're
ready to see it drive an actual agent, or start from one of the other
examples instead.
