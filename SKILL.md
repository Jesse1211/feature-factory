---
name: feature-factory
description: Deliver a feature the way the agent-center project did — a human-led design session that produces an unambiguous decision ledger (ADRs + task DAG + acceptance gates), then a hands-off multi-agent build where a Dev agent implements, an INDEPENDENT Tester agent verifies the gates, and a Supervisor agent audits — failures bounce back automatically, no human in the loop. Use when the user wants to design once (1-2h) then let agents implement + check each other without intervention.
---

# Feature Factory

Two phases, two different drivers. **Do not blur them.**

| Phase | Driver | Goal |
|---|---|---|
| **1. Design** (human-led, ~1–2h) | You + the human, conversational | Ground the rules → model the domain → exhaust the boundary cases → produce `DESIGN.md`: a decision ledger so unambiguous that agents never need to ask a human during the build |
| **2. Build** (hands-off) | A **Workflow script** (deterministic) | Per DAG node: Dev implements → independent Tester verifies gates → Supervisor audits → bounce on failure. No human. |

The whole method rests on one principle the source project proved: **the agent that writes code is never the agent that approves it.** Separation of duties is enforced by the workflow's structure, not by hoping an agent behaves.

---

## Phase 1 — Design session (you run this with the human)

Your job is to extract every decision NOW so the build never blocks later. The human's interruptions during a build come from judgment calls left unresolved — your task is to surface and resolve them all up front.

**The method, not just the artifacts.** The source project's design sessions did not jump straight to "list tasks, record ADRs." The human reasoned in a fixed order — *establish how to think → model the domain → exhaust the boundary cases → then* the ADRs/DAG/gates fall out almost mechanically. The steps below preserve that order. The human stays at the **"why" layer** (domain / boundary / semantics / invariants); you translate to the "how." Do not skip Steps 1–3 to get to the deliverables faster — Steps 4–8 are only as good as the modelling that precedes them.

Run these steps in order. **Ask questions ONE AT A TIME, always with your recommended answer + why.** Compress open questions into multiple-choice whenever possible (use AskUserQuestion for clean forks). Read the codebase **first, do not modify anything** during design.

### Step 1 — Establish the grounding rules (do this before any design talk)
The source project's single most-repeated rule. State it back to the human and then hold yourself to it for the rest of the session:

> **"Not built" ≠ "not supported" ≠ "the design assumes the opposite."** When describing the current system, stop at verifiable fact ("X is not yet implemented in the UI", "the model layer supports X but the API doesn't expose it"). Never infer *design intent* ("the architecture assumes X", "X is unsupported by design") **unless** you can cite evidence: a code comment/doc that says so, a structural constraint in the data model (unique constraint, schema limit), or unambiguous API semantics (returns an object, not an array).

This is what stops the whole build from being founded on a confident hallucination. Also lock the conversation contract: **every option you present comes with a recommendation + reason; never an open-ended "what do you want?"**

### Step 2 — Model the domain, not the implementation
Before listing any work, agree on the *concepts*. This is where the "why" lives, and where wrong models get caught cheaply.

**Work through this checklist ONE QUESTION AT A TIME — create a todo per item and do not skip any.** Each maps to one DDD concept; each comes with your recommended answer + why. Ask in the project's existing ubiquitous language.

1. **Bounded Context (BC / 域)** — Does this feature live in an existing BC or a new one? Name it. *(A BC is a subsystem with its own self-consistent language.)*
2. **Boundary (边界)** — Where exactly is the line? What is in-scope for this BC to own, and what belongs to other BCs? *(Inside the line you model freely; across it you may only reference, never reach in and mutate.)*
3. **Aggregate Root (聚合根)** — Is there a new aggregate root, or does this hang off an existing one? *(The single entry point that owns a cluster of objects and guards their consistency; outsiders operate only through it. It is also the transaction boundary.)*
4. **Entity vs Value Object (实体 / 值对象)** — For each piece of state: does it have an identity that persists across attribute changes (**Entity**, compared by ID), or is it defined purely by its value (**Value Object**, compared by value, e.g. a cron expression, a money amount)? *(Getting this wrong is a top source of model rot.)*
5. **Invariants (不变式)** — What rules must ALWAYS hold for this aggregate? (uniqueness, terminal states, "can't run twice concurrently", "next-fire must be after last-fire") *(The aggregate root's whole job is to enforce these. Each becomes an ADR + an acceptance check.)*
6. **Entity lifecycle (生命周期)** — What states does the entity move through, and which transitions are legal vs illegal? (e.g. `created→active→paused→deleted`, and `deleted` is terminal) *(Illegal transitions are themselves invariants.)*
7. **References / refs (引用关系)** — What does this aggregate point at in other aggregates/BCs? Confirm it holds only the **ID** (a ref), not the embedded object. *(Same aggregate → hold the object; cross-aggregate / cross-BC → hold the ID only.)*
8. **Semantics / ubiquitous language (语义 / 统一语言)** — Pin the exact meaning of every key term; flag any word used with two meanings (a "semantic fork" to resolve in Step 3). Name things in domain terms, not technical ones, so code == business vocabulary.

If the project documents a domain model (CONTEXT.md, ADRs, a DDD design page), reconcile against it — and consider invoking `grill-with-docs` to stress-test the model against the documented language. **Output: a short domain sketch** — the BC + its boundary, the aggregate root, its entities/value objects, invariants, lifecycle, and cross-BC refs — that the human signs off on before you list any tasks.

### Step 3 — Exhaust the boundary cases ("semantic forks")
This is the human's signature move and the engine that *generates* the decisions worth deciding. Take each fuzzy part of the model and split it into discrete cases; for every case mark ✅ (settled) / ⚠️ (a semantic fork the human must resolve) / ❌ (excluded). For each ⚠️, ask the fork explicitly. The cases that recur and bite:
- **Concurrency / re-entrancy**: what if it's triggered again while the previous run is still in flight — skip / queue / run-in-parallel?
- **Missed / catch-up semantics**: after downtime that skipped N occurrences, on recovery do you back-fill all N, or only the latest, or none?
- **Idempotency**: is a repeated operation safe? what's the dedup key?
- **Time / timezone / ordering**: whose clock, what order, what happens at boundaries.
- **Failure & retry**: retried how many times, then what? where does each attempt's result land, and how do you query "did the last run succeed?"
- **Lifecycle**: pause / reconfigure / delete — and what happens to an in-flight instance when you delete its definition.

Don't accept a one-line answer to a ⚠️ — pull on the fork until the semantics are unambiguous. Every resolved ⚠️ becomes an ADR (Step 4); every invariant + resolved fork becomes an acceptance check (Step 6). This is the step that makes the build never need a human.

### Step 4 — List the work, then record each locked decision as an ADR
Now that the model and its forks are settled, list EVERY piece of work the feature implies — grouped by theme, breadth-first, each tagged with its source and a rough priority (⭐). Then turn every decision settled in Steps 2–3 into a numbered entry: `ADR-NNN: <decision> — <rationale> — supersedes <prev?>`. This is what build agents cite instead of re-litigating. Decisions are traceable and reversible.

### Step 5 — Track unresolved as OQ (Open Questions)
Anything not yet decided gets a numbered `OQ-NN`. A build node may say "per OQ-12, leave X untouched." Nothing gets lost in conversation.

### Step 6 — Define the task DAG
Break the work into tasks with explicit `depends_on`. Each task = one buildable unit assignable to one Dev agent. This DAG is the build order — it IS the plan. Group into stages if helpful.

### Step 7 — Define acceptance gates (Definition of Done, quantified)
Per task, write the **executable** gate the Tester will run — generic placeholders the human fills with their real stack:
- `TEST_CMD` (e.g. the project's test runner) and the bar (e.g. "all green", coverage ≥ N%)
- `LINT_CMD` / typecheck
- behavioral checks — **derive these directly from the invariants (Step 2) and resolved semantic forks (Step 3)**, e.g. "a second concurrent trigger is rejected, not double-run", "after 2h downtime only the latest occurrence back-fills (per ADR-NN)", "deleting a definition cancels its in-flight run".
A task is done ONLY when its gate passes — not when the Dev says so.

### Step 8 — Write `DESIGN.md` and lock it
Write `DESIGN.md` at repo root with: ADR ledger, OQ list, task DAG (with `depends_on` + acceptance gate per task), and the global commands (`TEST_CMD`, `LINT_CMD`, build/deploy). Then:

1. **De-fang interruptions BEFORE the build.** The #1 cause of mid-build stalls is permission prompts and judgment calls. Use the `update-config` skill to add the build's routine commands to `.claude/settings.json` permissions allow-list so the workflow doesn't stall on approvals: the test runner, linter, file ops, **`git` (incl. `worktree add/remove/prune`, `fetch`, `commit`, `push`, `rebase`, `merge --ff-only`)**, and **`gh pr create/merge`** if PRs go through GitHub. Tell the human exactly what you're allow-listing.
2. Confirm the DESIGN.md with the human one last time. **This is the last human checkpoint.** After this, the build runs unattended.

---

## Phase 2 — Hands-off build (the workflow does this)

Once `DESIGN.md` is locked, launch the build. The build is a **Workflow** — a deterministic script so the worktree→Dev/PR→Tester→§-1 review→Integrator-merge pipeline is enforced even with no human watching. A skill's prose cannot guarantee that; a workflow can. **This mirrors the agent-center ("AgentCenter Talks") project's actual workflow** — physical isolation via git worktrees + PRs + a single merge authority, not in-place edits.

The build script template lives next to this skill at `feature-factory.workflow.js`.

**The build requires the user to have opted into workflows** (ultracode on, or they said "use a workflow" / "run the build"). If they haven't, say so and ask — do not silently spawn dozens of agents.

### How to launch it (exact recipe)
The script reads its task DAG from the `args` you pass to the `Workflow` tool — you do NOT edit the script. Translate `DESIGN.md` into the `args` object, then point `Workflow` at the script via `scriptPath`:

```
Workflow({
  scriptPath: "<this skill dir>/feature-factory.workflow.js",
  args: {
    repoRoot: "<abs repo path>",       // the trunk checkout where main lives
    trunk: "main",                     // branch PRs target & fast-forward into
    worktreeBase: "/tmp/ff-wt",        // per-task worktrees are created here
    testCmd:  "<global test cmd>",      // task-level testCmd/lintCmd override these
    lintCmd:  "<global lint cmd>",
    maxRounds: 3,
    tasks: [
      { id:"T1", title:"...", adr:["ADR-0040"], dependsOn:[],
        spec:"precise build instruction from DESIGN.md",
        gate:"executable acceptance gate — prefer a command, not prose",
        branch:"dev/v28-p1-foo",       // optional; derived from id if omitted
        testCmd:"<override>", lintCmd:"<override>" },
      { id:"T2", ..., dependsOn:["T1"] }
    ]
  }
})
```

Each `tasks[]` entry is one row of the DESIGN.md DAG. The `args.tasks` value must be a real JSON array, not a stringified one. To iterate on the script itself, edit the file and re-launch with the same `scriptPath`.

### Budget control
If the user gave a token target this turn (e.g. "+500k"), the script's budget guard stops launching new nodes near the ceiling and marks the rest `needs-human` — a runaway retry loop can't drain the pool. With no target set, it runs to completion.

### Isolation model (the agent-center way — NOT in-place reset)
Each task gets its **own git worktree + branch** off the latest trunk, created before any code is touched. The Dev works only inside that worktree. This is *physical* isolation: parallel tasks never collide, and the Tester verifies in a separate checkout. **Rework = additional fixup commits on the same PR branch — never `git reset --hard` / history rewrite.** After a task merges (or is abandoned), its worktree is removed; the **branch + PR stay as the audit trail**. Worktrees live under `worktreeBase` and the trunk checkout at `repoRoot` is never mutated by a Dev — so this is safe to run while trunk sits on `main`. The script also needs `git`/`gh` worktree + PR commands allow-listed (handled in Step 8).

### The five roles (separation of duties — the core mechanism)
Per DAG node (independent nodes run concurrently):

1. **Worktree manager** — fetches trunk, creates the per-task worktree + branch. No code changes.
2. **Dev agent** — implements inside its worktree, commits, pushes, opens/updates a **PR** targeting trunk (rebased on trunk). Returns PR head commit + PR url. *Self-reports are not trusted.*
3. **Tester agent (INDEPENDENT)** — checks out the **PR head in its own throwaway worktree** and runs the gate (`TEST_CMD`, `LINT_CMD`, behavioral checks) **itself**. Hard pass/fail with actual output. Never reuses the Dev's claims.
4. **Supervisor agent** — adversarial **§-1 review** of the PR: did the gate REALLY pass on the PR head, any self-deception, any ADR drift? approve / reject.
5. **Integrator agent** — the **single merge authority** (the project's `IntegrationDev`). Approved PRs are enqueued and merged **one at a time, serially** — never two concurrent fast-forwards racing on trunk. For each: rebase the branch onto the latest trunk → `--ff-only` merge → **push origin** (so downstream tasks, which branch off `origin/trunk`, see the new commit). Reports the new trunk hash. If a merge can't fast-forward (real conflict), the task reworks.

### Failure handling (why it never stalls)
- Tester fails, Supervisor rejects, or merge can't fast-forward (trunk moved) → **rework on the same PR branch**, up to `MAX_ROUNDS` (e.g. 3).
- Still not landed after MAX_ROUNDS → **don't block the whole build.** Mark the node `needs-human` (its PR + branch remain for inspection), and let independent DAG branches keep going. Surface blocked nodes asynchronously at the end (never a synchronous wait).
- This mirrors the source project's rule: *failure notifies, it does not gate.*

### Build discipline the agents must follow
Baked into the role prompts:
- **Additive / backward-compatible** changes; feature-flag risky paths.
- Every delivery reports its **PR head commit hash**; every merge reports the **trunk hash**.
- Cite the ADR being implemented; if the task conflicts with an ADR, stop that node and flag it (don't improvise architecture).
- Respect OQs ("per OQ-N, do not touch X").
- Rework adds commits; it never rewrites or resets history.

---

## Output to the human at the end
A short report: which DAG nodes passed (with commits), which hit `needs-human` and why, total rounds spent. Then offer next steps. Keep the file dumps out — relay the conclusions.

## When NOT to use this
- Trivial one-file changes — just do them.
- Anything where the human WANTS to review each step — this skill's whole point is removing them from the loop after design.
