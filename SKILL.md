# Barnacle — Behavioral Accountability for AI Agents

## What This Is

Barnacle tracks hypotheses, verifies evidence against reality, and audits whether you're actually making progress or just updating fields. It's your accountability partner, not your task manager.

**For task tracking, use [Beads](https://github.com/steveyegge/beads)** (`bd ready`, `bd list`, `bd create`). Beads handles dependencies, blocking, and ready-work detection. Barnacle handles what Beads doesn't: *are your claims about progress actually true?*

## Quick Reference

### Actions
- `barnacle create` — Start tracking a hypothesis (requires id + data.goal)
- `barnacle update` — Record progress with evidence (requires id + data)
- `barnacle get` — View a hypothesis and its audit status
- `barnacle list` — See all tracked hypotheses

### Evidence Types
When recording a lastAction, include evidence for automatic verification:
- `{kind: "commit", value: "hash", repo: "/path"}` — checks git log
- `{kind: "url", value: "https://..."}` — checks HTTP reachability
- `{kind: "file", value: "/path/to/file"}` — checks file exists
- `{kind: "command", value: "cmd args", expect: "substring"}` — runs command

### Slash Command
`/planner` — Shows Barnacle audit + Beads ready-tasks in one view.

## When to Use Barnacle vs Beads

| Question | Tool |
|----------|------|
| What should I work on next? | `bd ready` |
| What's blocking task X? | `bd show X` |
| Why am I doing this? What's my hypothesis? | `barnacle get` |
| Did I actually do what I claimed? | `barnacle update` (with evidence) |
| Am I making real progress? | `/planner` (audit diffing) |
