export const meta = {
  name: 'feature-factory-build',
  description: 'Hands-off feature build modeled on the agent-center project: each task gets its own git worktree + branch; a Dev implements & opens a PR, an INDEPENDENT Tester verifies the gate against the PR head in its own worktree, a Supervisor reviews (§-1 approve), then a dedicated Integrator merges to trunk (ff main) — the only role allowed to merge. Rework = more commits on the same PR branch (never reset --hard). Worktrees are cleaned after merge.',
  phases: [
    { title: 'Branch', detail: 'Create per-task worktree + branch off trunk' },
    { title: 'Build', detail: 'Dev implements in the worktree and opens a PR' },
    { title: 'Verify', detail: 'Independent Tester runs the gate against PR head' },
    { title: 'Review', detail: 'Supervisor §-1 review (adversarial)' },
    { title: 'Merge', detail: 'Integrator merges PR → ff main, then worktree is cleaned' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the agent-center ("AgentCenter Talks") workflow:
//   Dev → own worktree+branch → commit/push → PR (rebased on trunk)
//   Tester → independent worktree on PR head → run gate
//   Supervisor → adversarial review (§-1 approve)
//   Integrator → ONLY role that merges: merge PR, ff main, report trunk hash
//   cleanup → whoever opened the worktree removes it after merge
//   rework → additional commits on the SAME PR branch (NOT git reset --hard)
//
// INPUT via Workflow `args`:
//   args = {
//     repoRoot: '/abs/path',          // the trunk checkout; main lives here
//     trunk: 'main',                  // branch PRs target & fast-forward into
//     worktreeBase: '/tmp/ff-wt',     // where per-task worktrees are created
//     testCmd: 'npm test', lintCmd: 'npm run lint',   // global fallbacks
//     maxRounds: 3,
//     tasks: [
//       { id:'T1', title:'...', adr:['ADR-0040'], dependsOn:[],
//         spec:'precise build instruction',
//         gate:'go build green + vitest all green + endpoint returns wrapped response',
//         branch:'dev/v28-p1-foo',     // optional; derived from id if omitted
//         testCmd:'npx vitest run', lintCmd:'tsc -b' },
//       { id:'T2', ..., dependsOn:['T1'] },
//     ]
//   }
// ─────────────────────────────────────────────────────────────────────────────
// args may arrive as a JSON string (some harness paths stringify it)
// or as a parsed object — accept either.
const cfg = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const TASKS = cfg.tasks || []
const MAX_ROUNDS = cfg.maxRounds || 3
const G_TEST = cfg.testCmd || 'echo "no testCmd set"'
const G_LINT = cfg.lintCmd || 'echo "no lintCmd set"'
const ROOT = cfg.repoRoot || '.'
const TRUNK = cfg.trunk || 'main'
const WT_BASE = cfg.worktreeBase || '/tmp/ff-wt'
// ROOT-CAUSE fix for worktree env: a fresh worktree is a bare git checkout that
// LACKS non-git-tracked environment — Python editable-install .pth points at the
// MAIN repo (so `import thepaper_backend` loads stale code → ImportError), and
// Node has NO node_modules (so `vitest`/`eslint` → command not found). Any test
// run inside a worktree must first restore that environment. This string is
// injected into BOTH the Dev and Tester prompts so neither tests stale/missing env.
const SETUP = cfg.setupNote || `ENVIRONMENT SETUP — MANDATORY before running ANY test/lint/build inside a worktree (a worktree is a bare checkout missing non-git env):
  1. Python: this repo uses an editable install whose .pth is pinned to the MAIN repo. To test the WORKTREE's code, run pytest from the package dir with PYTHONPATH set to the worktree src, e.g. \`cd backend && PYTHONPATH="$(pwd)/src" python3 -m pytest ...\` (same for \`tools\`). Without this you load the main repo's stale code → ImportError.
  2. Node/UI: the worktree has NO node_modules. Before any \`npm run test:run|lint|build\`, first \`cd ui && npm ci\` (lockfile present). Without this → \`vitest: command not found\`.
Do these in the worktree FIRST, then run the gate. Report actual env-setup + gate output.`

if (!TASKS.length) {
  log('No tasks supplied in args.tasks — nothing to build. Pass the DAG from DESIGN.md.')
  return { error: 'no-tasks' }
}

// ── Schemas (force structured returns; no parsing) ──
const WT_SCHEMA = {
  type: 'object',
  required: ['ok', 'worktreePath', 'branch'],
  properties: {
    ok: { type: 'boolean' },
    worktreePath: { type: 'string' },
    branch: { type: 'string' },
    note: { type: 'string' },
  },
}
const DEV_SCHEMA = {
  type: 'object',
  required: ['done', 'summary', 'commit', 'prUrl'],
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    commit: { type: 'string', description: 'PR head commit hash on the task branch' },
    prUrl: { type: 'string', description: 'opened/updated PR url, or empty if it could not be opened' },
    adrCited: { type: 'array', items: { type: 'string' } },
    conflictsWithAdr: { type: 'boolean', description: 'true if the task contradicts a cited ADR — stop and flag' },
    note: { type: 'string' },
  },
}
const TEST_SCHEMA = {
  type: 'object',
  required: ['pass', 'output', 'checkedGate'],
  properties: {
    pass: { type: 'boolean', description: 'true ONLY if every gate clause passed, verified by running commands yourself on the PR head' },
    output: { type: 'string', description: 'actual command output / failures — never the Dev\'s claims' },
    checkedGate: { type: 'string' },
    headChecked: { type: 'string', description: 'the commit hash you actually checked out and tested' },
    failingClauses: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['approve', 'reason'],
  properties: {
    approve: { type: 'boolean', description: '§-1 approve: true only if you independently believe it genuinely passed and matches the ADRs' },
    reason: { type: 'string' },
    selfDeceptionFound: { type: 'boolean' },
    adrDrift: { type: 'boolean' },
  },
}
const MERGE_SCHEMA = {
  type: 'object',
  required: ['merged', 'trunkHash'],
  properties: {
    merged: { type: 'boolean' },
    trunkHash: { type: 'string', description: 'new trunk HEAD after ff merge' },
    note: { type: 'string' },
  },
}

// ── DAG scheduling: run a node only after its deps are confirmed go ──
const result = {}          // id -> {status, commit, prUrl, trunkHash, rounds, reason}
const inflight = new Map() // id -> Promise

// Token-budget guard: if the user set a target (e.g. "+500k"), stop launching
// new nodes once we're near it so a runaway retry loop can't burn the pool.
// budget.remaining() is Infinity when no target was set, so this is a no-op then.
const BUDGET_FLOOR = 60_000
function budgetExhausted() {
  return budget && budget.total && budget.remaining() < BUDGET_FLOOR
}

function depsSatisfied(t) {
  return (t.dependsOn || []).every(d => result[d] && result[d].status === 'done')
}
function depsDead(t) {
  return (t.dependsOn || []).some(d => result[d] && result[d].status !== 'done')
}

const slug = (t) => (t.branch || `dev/ff-${t.id}`).toLowerCase().replace(/[^a-z0-9/_-]+/g, '-')

// ── Single merge authority ──────────────────────────────────────────────────
// The real project has ONE IntegrationDev that merges PRs one at a time so the
// shared trunk never has two concurrent fast-forwards racing. We model that with
// a serial promise chain: every node's approved PR is enqueued and merged in
// turn. The Integrator rebases each PR onto the latest trunk before a --ff-only
// merge, then pushes origin so downstream tasks (which branch off origin/TRUNK)
// see the new commit. mergeLock serializes; only one merge agent runs at a time.
let mergeLock = Promise.resolve()
function enqueueMerge(job) {
  const run = mergeLock.then(job, job)   // run after the previous merge settles
  // keep the chain alive even if a job throws, without unhandled rejections
  mergeLock = run.then(() => {}, () => {})
  return run
}

// Merge one approved PR. Runs only while holding the serial lock.
async function integrate(t, branch, prUrl, head) {
  const merge = await agent(
    `You are the Integrator — the SINGLE merge authority. No other merge runs concurrently with you.
In repoRoot=${ROOT}, land approved PR ${prUrl} (branch ${branch}, head ${head}) onto ${TRUNK}:
  1. \`git -C ${ROOT} fetch origin\` and REBASE branch ${branch} onto the latest origin/${TRUNK} (resolve trivially or fail out).
  2. Fast-forward merge into ${TRUNK} (\`git -C ${ROOT} merge --ff-only\` flow, or \`gh pr merge --rebase\`).
  3. \`git -C ${ROOT} push origin ${TRUNK}\` so downstream tasks branching off origin/${TRUNK} see this commit.
  4. Verify ${TRUNK} contains the change. Report the new trunk HEAD as trunkHash.
If the rebase has real conflicts you cannot resolve safely, set merged=false with a note (the task will rework).`,
    { label: `merge:${t.id}`, phase: 'Merge', schema: MERGE_SCHEMA, agentType: 'general-purpose' }
  )
  return merge
}

// Clean up a task's Dev worktree + any throwaway Tester worktrees, leaving the
// branch (its history is the audit trail).
async function cleanWorktree(t, wtPath, branch, extraWorktrees = []) {
  const paths = [wtPath, ...extraWorktrees].filter(Boolean)
  if (!paths.length) return
  await agent(
    `You are the worktree janitor. In repoRoot=${ROOT}, remove these worktrees (force) and prune: ${paths.join(', ')}. For each run \`git -C ${ROOT} worktree remove <path> --force\`, then \`git -C ${ROOT} worktree prune\`. A path that no longer exists is fine — skip it. Do NOT delete branch ${branch} — its history is the audit trail. Return ok=true.`,
    { label: `clean:${t.id}`, phase: 'Merge', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, agentType: 'general-purpose' }
  )
}

// One node = branch → (Dev → Tester → Supervisor, rework loop) → Integrator merge → clean.
async function runNode(t) {
  const testCmd = t.testCmd || G_TEST
  const lintCmd = t.lintCmd || G_LINT
  const branch = slug(t)
  const wtPath = `${WT_BASE}/${t.id}`

  // ── Branch: create the per-task worktree off fresh trunk (physical isolation) ──
  const wt = await agent(
    `You are the Worktree manager. In repoRoot=${ROOT}: fetch trunk, then create an isolated git worktree for task ${t.id} at path ${wtPath} on a NEW branch ${branch} based on the latest ${TRUNK}. Commands roughly: \`git -C ${ROOT} fetch origin\`, \`git -C ${ROOT} worktree add -b ${branch} ${wtPath} origin/${TRUNK}\`. Return the worktreePath and branch. Make no code changes.`,
    { label: `wt:${t.id}`, phase: 'Branch', schema: WT_SCHEMA, agentType: 'general-purpose' }
  )
  if (!wt || !wt.ok) { return { status: 'needs-human', rounds: 0, reason: `worktree create failed: ${wt && wt.note}` } }
  const cwd = wt.worktreePath || wtPath

  let lastFail = ''
  let lastPr = ''
  let lastCommit = ''
  const testWorktrees = []   // throwaway Tester worktrees to sweep on exit
  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      // 1. DEV implements IN ITS OWN WORKTREE and opens/updates a PR.
      //    Rework = additional commits on the SAME branch — never reset --hard.
      const dev = await agent(
        `You are the Dev agent. Work ONLY inside the worktree cwd=${cwd} on branch ${branch}. Do NOT touch ${ROOT} or other worktrees.
Implement task ${t.id}: ${t.title}.
${SETUP}
Spec: ${t.spec}
Cite & follow these ADRs: ${(t.adr || []).join(', ') || '(none)'}.
Rules: additive / backward-compatible; feature-flag risky paths; commit your work; push branch ${branch}; open (or update) a PR targeting ${TRUNK}, rebased on the latest trunk. Report the PR head commit + PR url.
If the task CONTRADICTS a cited ADR, set conflictsWithAdr=true and STOP — do not improvise architecture.
${round > 1
  ? `This is rework round ${round} on the SAME PR branch (do NOT reset/rewrite history — add fixup commits). First \`git fetch origin\` and rebase your worktree branch ${branch} onto the latest origin/${TRUNK} (trunk may have advanced since you branched). Then fix the failure below and update the PR.\nThe gate FAILED last round:\n${lastFail}`
  : ''}`,
        { label: `dev:${t.id}#${round}`, phase: 'Build', schema: DEV_SCHEMA, agentType: 'general-purpose' }
      )
      if (!dev) { return { status: 'needs-human', rounds: round, reason: 'dev agent died', prUrl: lastPr } }
      if (dev.conflictsWithAdr) { return { status: 'needs-human', rounds: round, reason: `ADR conflict: ${dev.note}`, prUrl: lastPr } }
      lastPr = dev.prUrl || lastPr
      lastCommit = dev.commit || lastCommit

      // 2. TESTER (independent) checks out the PR head in ITS OWN worktree and runs the gate.
      //    The script assigns a UNIQUE throwaway path per task+round so concurrent
      //    Testers never collide on `git worktree add`.
      const testWt = `${WT_BASE}/test-${t.id}-r${round}`
      testWorktrees.push(testWt)
      const test = await agent(
        `You are the Tester agent — INDEPENDENT of the Dev. Do NOT trust any self-report.
Verify task ${t.id} against the PR HEAD ${dev.commit} on branch ${branch}. Create a throwaway worktree at EXACTLY this path: \`git -C ${ROOT} worktree add --detach ${testWt} ${dev.commit}\`.
${SETUP}
Then RUN the gate inside ${testWt}:
  - run: ${testCmd}
  - run: ${lintCmd}
  - behavioral gate: ${t.gate}
Set pass=true ONLY if every clause passes. Put ACTUAL output in output and the commit you checked in headChecked. Always remove your worktree when done: \`git -C ${ROOT} worktree remove ${testWt} --force\`.`,
        { label: `test:${t.id}#${round}`, phase: 'Verify', schema: TEST_SCHEMA, agentType: 'general-purpose' }
      )
      if (!test) { return { status: 'needs-human', rounds: round, reason: 'tester agent died', prUrl: lastPr } }

      if (!test.pass) {
        lastFail = test.output + '\nfailing: ' + (test.failingClauses || []).join('; ')
        continue // rework on the same PR branch
      }

      // 3. SUPERVISOR §-1 review (adversarial) — gate before merge.
      const review = await agent(
        `You are the Supervisor. Do an adversarial §-1 review of PR ${lastPr} (head ${dev.commit}) for task ${t.id}.
Tester output:\n${test.output}
Question everything: did the gate REALLY pass on the PR head, or is there self-deception (skipped tests, weakened asserts, gate not actually run against ${dev.commit})? Does the change drift from ADRs ${(t.adr || []).join(', ')}?
approve=true only if you independently believe it genuinely passed and matches the ADRs.`,
        { label: `review:${t.id}#${round}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'general-purpose' }
      )
      if (!review) { return { status: 'needs-human', rounds: round, reason: 'supervisor died', prUrl: lastPr } }

      if (!review.approve) {
        lastFail = `Supervisor §-1 rejected: ${review.reason}`
        continue // rework on the same PR branch
      }

      // 4. INTEGRATOR — enqueue to the SINGLE serial merge authority. Only one
      //    merge touches trunk at a time (rebase → ff → push origin).
      const merge = await enqueueMerge(() => integrate(t, branch, lastPr, dev.commit))
      if (!merge || !merge.merged) {
        lastFail = `Integrator could not merge: ${merge && merge.note}`
        continue // e.g. trunk moved with real conflicts — Dev reworks and we retry
      }

      return { status: 'done', commit: dev.commit, prUrl: lastPr, trunkHash: merge.trunkHash, rounds: round, reason: 'gate + §-1 review + merged' }
    }
    return { status: 'needs-human', rounds: MAX_ROUNDS, reason: `not landed after ${MAX_ROUNDS} rounds:\n${lastFail}`, prUrl: lastPr, commit: lastCommit }
  } finally {
    // Clean the Dev worktree + every throwaway Tester worktree, whether we merged
    // or gave up (covers the case where a Tester died before removing its own).
    // The branch + PR stay as the audit trail.
    await cleanWorktree(t, cwd, branch, testWorktrees)
  }
}

// ── Drive the DAG: kick off ready nodes, never block independent branches ──
log(`Building ${TASKS.length} tasks (maxRounds=${MAX_ROUNDS}). agent-center model: per-task worktree+branch → Dev/PR → independent Tester → §-1 review → Integrator-only merge.`)
while (Object.keys(result).length < TASKS.length) {
  let launchedThisPass = false

  // Token-budget kill-switch: stop launching new work, let in-flight finish.
  if (budgetExhausted()) {
    for (const t of TASKS) if (!result[t.id] && !inflight.has(t.id)) {
      result[t.id] = { status: 'needs-human', reason: 'token budget exhausted before this node started' }
    }
    if (inflight.size > 0) { await Promise.race([...inflight.values()]); continue }
    break
  }

  for (const t of TASKS) {
    if (result[t.id] || inflight.has(t.id)) continue
    if (depsDead(t)) {
      result[t.id] = { status: 'skipped', reason: 'an upstream dependency did not complete' }
      launchedThisPass = true
      continue
    }
    if (depsSatisfied(t)) {
      // onRejected is critical: if runNode throws (e.g. an agent dies with a
      // terminal error), we MUST still record a result and free the inflight
      // slot — otherwise the while-loop never terminates (deadlock).
      inflight.set(t.id, runNode(t).then(
        r => { result[t.id] = r; inflight.delete(t.id) },
        e => { result[t.id] = { status: 'needs-human', reason: `node crashed: ${e && e.message || e}` }; inflight.delete(t.id) },
      ))
      launchedThisPass = true
    }
  }
  if (inflight.size > 0) {
    await Promise.race([...inflight.values()])
  } else if (!launchedThisPass) {
    for (const t of TASKS) if (!result[t.id]) result[t.id] = { status: 'skipped', reason: 'deadlocked deps' }
  }
}

// ── Report ──
const done = Object.entries(result).filter(([, r]) => r.status === 'done')
const blocked = Object.entries(result).filter(([, r]) => r.status !== 'done')
log(`Landed: ${done.length}/${TASKS.length} merged to ${TRUNK}. Needs-human/blocked: ${blocked.length}.`)
return {
  summary: { total: TASKS.length, done: done.length, blocked: blocked.length },
  done: done.map(([id, r]) => ({ id, commit: r.commit, prUrl: r.prUrl, trunkHash: r.trunkHash, rounds: r.rounds })),
  needsHuman: blocked.map(([id, r]) => ({ id, status: r.status, reason: r.reason, prUrl: r.prUrl })),
}
