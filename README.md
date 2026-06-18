# feature-factory

A Claude Code skill that delivers a feature the way the [agent-center](https://github.com/oopslink/agent-center) project did: **design once, then let a team of agents build and check each other with no human in the loop.**

Two phases, two drivers:

| Phase | Driver | Output |
|---|---|---|
| **1. Design** (human-led, ~1–2h) | You + Claude, conversational | `DESIGN.md` — an unambiguous decision ledger (ADRs + task DAG + acceptance gates) so agents never need to ask a human mid-build |
| **2. Build** (hands-off) | A deterministic Workflow script | Per task: own git worktree → Dev opens a PR → independent Tester verifies the gate → Supervisor §-1 review → a single Integrator merges to trunk. Failures rework on the same branch; persistent failures mark `needs-human` without blocking other branches. |

The core principle, proven by the source project: **the agent that writes code is never the agent that approves it.** Separation of duties is enforced by the workflow's structure — physical isolation via git worktrees, PRs, and a single merge authority — not by hoping an agent behaves.

## Files

- `SKILL.md` — the skill: how Claude runs the design session and launches the build.
- `feature-factory.workflow.js` — the hands-off build pipeline (worktree → Dev/PR → Tester → §-1 review → Integrator-only merge).
- `feature-factory.workflow.test.mjs` — E2E orchestration tests (run with `node feature-factory.workflow.test.mjs`).

## Install

Copy this directory into `~/.claude/skills/feature-factory/`, then invoke with `/feature-factory`.

## Status

The orchestration logic is covered by 15 passing E2E tests (mocked agents, real script). Not yet validated against a real git repo + live agents end-to-end — that's the next step.

## License

MIT — see [LICENSE](LICENSE).
