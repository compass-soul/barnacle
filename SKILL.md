---
name: barnacle
version: 0.1.0
description: "Persistent project tracking for AI agents. Attaches to your goals and won't let go. OpenClaw plugin with background auditor, state diffing, and structured planning that survives compaction."
homepage: https://github.com/compass-soul/barnacle
tags: [planning, accountability, projects, tracking, persistence, compaction, plugin]
---

# 🦀 Barnacle

Persistent project tracking for AI agents. An OpenClaw plugin that solves continuity loss after compaction.

## Install

```bash
git clone https://github.com/compass-soul/barnacle.git ~/.openclaw/extensions/barnacle
```

Then add to `openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "barnacle": { "enabled": true }
    }
  }
}
```

Restart the gateway.

## What It Does

- **Structured projects** — goal, hypothesis, next action, results, review dates
- **Background auditor** — catches stale projects, missing actions, zero progress
- **Agent tool** (`barnacle`) — manage projects during conversation
- **`/planner` command** — quick status without AI invocation

See [README](https://github.com/compass-soul/barnacle) for full docs.
