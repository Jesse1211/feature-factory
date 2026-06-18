// E2E test for feature-factory.workflow.js (agent-center / worktree+PR model).
//
// Loads the REAL script source, wraps it the way the Workflow engine does
// (body inside an async function with agent/log/args/budget injected), and runs
// it with a MOCK agent() so we exercise orchestration without spawning agents.
// Asserts the agent-center protocol: per-task worktree → Dev/PR → independent
// Tester (against PR head) → Supervisor §-1 review → Integrator-only merge →
// worktree cleanup; rework on the same branch; DAG ordering; budget guard.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_PATH = join(__dirname, 'feature-factory.workflow.js')

function loadBody() {
  let src = readFileSync(SRC_PATH, 'utf8')
  return src.replace(/^export\s+const\s+meta\s*=/m, 'const meta =')
}

// Sensible default responses for the infra roles so each scenario only has to
// describe the dev/test/review/merge behavior it cares about.
function infraDefault({ label }) {
  const r = roleOf(label)
  if (r === 'wt') return { ok: true, worktreePath: `/tmp/ff-wt/${taskOf(label)}`, branch: `dev/ff-${taskOf(label)}` }
  if (r === 'clean') return { ok: true }
  return undefined
}

async function runScript({ args, agentImpl, budget }) {
  const body = loadBody()
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || '(no-label)'
    const phase = opts.phase || ''
    calls.push({ label, phase, prompt })
    // Scenario impl takes precedence; fall back to infra defaults only when it
    // returns undefined, so a scenario can inject e.g. a worktree failure.
    // Await first so async scenario impls (which return a Promise) are handled.
    const fromScenario = await agentImpl({ prompt, opts, label, phase, calls })
    if (fromScenario !== undefined) return fromScenario
    return infraDefault({ label })
  }
  const log = (m) => logs.push(m)
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (it, i) => {
    let acc = it
    for (const s of stages) acc = await s(acc, it, i)
    return acc
  }))
  const bud = budget || { total: null, spent: () => 0, remaining: () => Infinity }
  const fn = new Function('agent', 'log', 'parallel', 'pipeline', 'args', 'budget',
    `return (async () => { ${body} })()`)
  const result = await fn(agent, log, parallel, pipeline, args, bud)
  return { result, calls, logs }
}

const roleOf = (label) => label.split(':')[0]   // wt|dev|test|review|merge|clean
const taskOf = (label) => (label.split(':')[1] || '').split('#')[0]
const roundOf = (label) => Number((label.split('#')[1]) || 0)
// the core review protocol, excludes infra (worktree create / cleanup)
const CORE = new Set(['dev', 'test', 'review', 'merge'])
const coreSeq = (calls) => calls.filter((c) => CORE.has(roleOf(c.label))).map((c) => roleOf(c.label))

const ok = (label, commit = 'abc123', pr = 'http://pr/1') => {
  const r = roleOf(label)
  if (r === 'dev') return { done: true, summary: '', filesChanged: [], commit, prUrl: pr }
  if (r === 'test') return { pass: true, output: 'ok', checkedGate: 'g', headChecked: commit }
  if (r === 'review') return { approve: true, reason: 'genuine' }
  if (r === 'merge') return { merged: true, trunkHash: 'trunk999' }
}

let passed = 0
const tests = []
const test = (name, fn) => tests.push({ name, fn })

const baseArgs = (tasks) => ({
  repoRoot: '/x', trunk: 'main', worktreeBase: '/tmp/wt',
  testCmd: 'echo t', lintCmd: 'echo l', maxRounds: 3, tasks,
})
const oneTask = [{ id: 'T1', title: 'one', spec: 's', gate: 'g', dependsOn: [] }]

// ── 1. happy path: full agent-center pipeline in order, then worktree cleaned ──
test('happy path: wt → dev → test → review → merge → clean, marks done with trunkHash', async () => {
  const { result, calls } = await runScript({ args: baseArgs(oneTask), agentImpl: ({ label }) => ok(label) })
  assert.deepEqual(coreSeq(calls), ['dev', 'test', 'review', 'merge'], `core seq was ${coreSeq(calls)}`)
  // worktree created before dev, cleaned after merge
  const idx = (l) => calls.findIndex((c) => c.label === l)
  assert.ok(idx('wt:T1') >= 0 && idx('wt:T1') < idx('dev:T1#1'), 'worktree created before Dev')
  assert.ok(idx('clean:T1') > idx('merge:T1'), 'worktree cleaned after merge')
  assert.equal(result.summary.done, 1)
  assert.equal(result.done[0].trunkHash, 'trunk999')
  assert.equal(result.done[0].prUrl, 'http://pr/1')
})

// ── 2. only the Integrator merges: Tester/Supervisor never merge ──
test('separation of duties: merge happens only in the Integrator (merge:) role', async () => {
  const { calls } = await runScript({ args: baseArgs(oneTask), agentImpl: ({ label }) => ok(label) })
  // Exactly one merge call, and it is the dedicated role.
  const merges = calls.filter((c) => roleOf(c.label) === 'merge')
  assert.equal(merges.length, 1)
  // The Tester prompt must tell it to check the PR HEAD independently, not trust self-report.
  const testCall = calls.find((c) => roleOf(c.label) === 'test')
  assert.match(testCall.prompt, /INDEPENDENT|Do NOT trust/i)
  assert.match(testCall.prompt, /PR HEAD|own .*worktree/i)
})

// ── 3. Tester fail → rework on SAME branch (no reset --hard) → lands round 2 ──
test('Tester failure reworks on the same PR branch and lands on round 2', async () => {
  let tc = 0
  const { result, calls } = await runScript({
    args: baseArgs(oneTask),
    agentImpl: ({ label }) => {
      const r = roleOf(label)
      if (r === 'test') { tc++; return tc === 1 ? { pass: false, output: 'FAIL x', checkedGate: 'g', failingClauses: ['x'] } : ok(label) }
      return ok(label)
    },
  })
  assert.deepEqual(coreSeq(calls), ['dev', 'test', 'dev', 'test', 'review', 'merge'], `got ${coreSeq(calls)}`)
  // Round-2 Dev prompt carries the failure AND forbids history rewrite.
  const dev2 = calls.find((c) => c.label === 'dev:T1#2')
  assert.match(dev2.prompt, /FAIL x/)
  assert.match(dev2.prompt, /same PR branch/i)
  assert.match(dev2.prompt, /do NOT reset|fixup/i)
  // Only ONE worktree create and ONE cleanup for the whole task (worktree reused across rounds).
  assert.equal(calls.filter((c) => roleOf(c.label) === 'wt').length, 1)
  assert.equal(calls.filter((c) => roleOf(c.label) === 'clean').length, 1)
  assert.equal(result.done[0].rounds, 2)
})

// ── 4. Supervisor §-1 reject blocks merge → rework ──
test('Supervisor §-1 rejection blocks merge and forces rework', async () => {
  let rc = 0
  const { result, calls } = await runScript({
    args: baseArgs(oneTask),
    agentImpl: ({ label }) => {
      const r = roleOf(label)
      if (r === 'review') { rc++; return rc === 1 ? { approve: false, reason: 'tests skipped', selfDeceptionFound: true } : ok(label) }
      return ok(label)
    },
  })
  assert.deepEqual(coreSeq(calls), ['dev', 'test', 'review', 'dev', 'test', 'review', 'merge'], `got ${coreSeq(calls)}`)
  assert.equal(result.summary.done, 1)
})

// ── 5. Integrator can't merge (trunk moved) → rework, eventually needs-human ──
test('merge failure bounces; persistent failure → needs-human, worktree still cleaned', async () => {
  const { result, calls } = await runScript({
    args: { ...baseArgs(oneTask), maxRounds: 2 },
    agentImpl: ({ label }) => {
      const r = roleOf(label)
      if (r === 'merge') return { merged: false, trunkHash: '', note: 'trunk moved, non-ff' }
      return ok(label)
    },
  })
  assert.equal(result.summary.done, 0)
  assert.equal(result.needsHuman[0].id, 'T1')
  assert.match(result.needsHuman[0].reason, /not landed after 2 rounds/)
  // finally{} cleanup must still run even on failure.
  assert.ok(calls.some((c) => c.label === 'clean:T1'), 'worktree must be cleaned even when the task fails')
})

// ── 6. worktree create failure → needs-human, no dev runs ──
test('worktree creation failure aborts the node before any Dev work', async () => {
  const { result, calls } = await runScript({
    args: baseArgs(oneTask),
    agentImpl: ({ label }) => {
      if (roleOf(label) === 'wt') return { ok: false, worktreePath: '', branch: '', note: 'disk full' }
      throw new Error('nothing past worktree should run')
    },
  })
  assert.ok(!calls.some((c) => roleOf(c.label) === 'dev'), 'no Dev should run if worktree failed')
  assert.equal(result.needsHuman[0].id, 'T1')
  assert.match(result.needsHuman[0].reason, /worktree create failed/)
})

// ── 7. DAG: dependent task waits for its dependency to land ──
test('DAG: T2 (depends on T1) starts only after T1 fully lands', async () => {
  const tasks = [
    { id: 'T1', title: 'first', spec: 's', gate: 'g', dependsOn: [] },
    { id: 'T2', title: 'second', spec: 's', gate: 'g', dependsOn: ['T1'] },
  ]
  const { result, calls } = await runScript({ args: baseArgs(tasks), agentImpl: ({ label }) => ok(label) })
  const firstT2 = calls.findIndex((c) => taskOf(c.label) === 'T2')
  const lastT1 = calls.map((c) => taskOf(c.label)).lastIndexOf('T1')
  assert.ok(firstT2 > lastT1, `T2 (idx ${firstT2}) must start after all T1 calls (last ${lastT1})`)
  assert.equal(result.summary.done, 2)
})

// ── 8. DAG: dead dependency → dependent skipped, never executed ──
test('DAG: when a dependency fails, dependent task is skipped (not executed)', async () => {
  const tasks = [
    { id: 'T1', title: 'first', spec: 's', gate: 'g', dependsOn: [] },
    { id: 'T2', title: 'second', spec: 's', gate: 'g', dependsOn: ['T1'] },
  ]
  const { result, calls } = await runScript({
    args: { ...baseArgs(tasks), maxRounds: 1 },
    agentImpl: ({ label }) => {
      if (taskOf(label) === 'T2') throw new Error('T2 must never run')
      if (roleOf(label) === 'test') return { pass: false, output: 'broken', checkedGate: 'g', failingClauses: ['z'] }
      return ok(label)
    },
  })
  assert.ok(!calls.some((c) => taskOf(c.label) === 'T2'), 'T2 must not run')
  assert.equal(result.summary.blocked, 2)
})

// ── 9. budget guard: exhausted → node marked needs-human, nothing runs ──
test('budget guard stops launching nodes when the token budget is exhausted', async () => {
  const budget = { total: 1_000_000, spent: () => 999_000, remaining: () => 1_000 }
  const { result, calls } = await runScript({
    args: baseArgs(oneTask),
    budget,
    agentImpl: () => { throw new Error('no agent should run when budget is exhausted') },
  })
  assert.equal(calls.length, 0)
  assert.match(result.needsHuman[0].reason, /budget exhausted/)
})

// ── 10. SINGLE merge authority: merges are serialized even with concurrent tasks ──
// Two independent tasks run concurrently. The merge agent is made async and we
// track how many merges are in-flight at once; it must never exceed 1.
test('merges are serialized (single merge authority) across concurrent tasks', async () => {
  const tasks = [
    { id: 'T1', title: 'a', spec: 's', gate: 'g', dependsOn: [] },
    { id: 'T2', title: 'b', spec: 's', gate: 'g', dependsOn: [] },
  ]
  let mergeActive = 0
  let maxConcurrentMerge = 0
  const tick = () => new Promise((r) => setTimeout(r, 5))
  const { result } = await runScript({
    args: baseArgs(tasks),
    agentImpl: async ({ label }) => {
      if (roleOf(label) === 'merge') {
        mergeActive++
        maxConcurrentMerge = Math.max(maxConcurrentMerge, mergeActive)
        await tick()                 // hold the lock briefly to expose any overlap
        mergeActive--
        return { merged: true, trunkHash: 'trunk-' + taskOf(label) }
      }
      return ok(label)
    },
  })
  assert.equal(maxConcurrentMerge, 1, `at most 1 merge should run at a time, saw ${maxConcurrentMerge}`)
  assert.equal(result.summary.done, 2, 'both tasks should still land')
})

// ── 11. Integrator prompt enforces rebase + push origin (downstream visibility) ──
test('Integrator rebases onto latest trunk and pushes origin', async () => {
  const { calls } = await runScript({ args: baseArgs(oneTask), agentImpl: ({ label }) => ok(label) })
  const mergeCall = calls.find((c) => roleOf(c.label) === 'merge')
  assert.match(mergeCall.prompt, /rebase/i, 'merge must rebase onto latest trunk')
  assert.match(mergeCall.prompt, /push origin/i, 'merge must push origin so downstream tasks see the commit')
  assert.match(mergeCall.prompt, /SINGLE merge authority/i)
})

// ── 12. Tester gets a UNIQUE worktree path (no concurrent collision) ──
test('Tester is given a unique, script-assigned throwaway worktree path', async () => {
  let tc = 0
  const { calls } = await runScript({
    args: baseArgs(oneTask),
    agentImpl: ({ label }) => {
      const r = roleOf(label)
      if (r === 'test') { tc++; return tc === 1 ? { pass: false, output: 'f', checkedGate: 'g', failingClauses: ['x'] } : ok(label) }
      return ok(label)
    },
  })
  const testCalls = calls.filter((c) => roleOf(c.label) === 'test')
  // Path is script-given (not left to the model) and differs per round.
  assert.match(testCalls[0].prompt, /worktree add --detach \/tmp\/wt\/test-T1-r1/)
  assert.match(testCalls[1].prompt, /test-T1-r2/)
  assert.notEqual(
    testCalls[0].prompt.match(/test-T1-r\d/)[0],
    testCalls[1].prompt.match(/test-T1-r\d/)[0],
    'each round must get a distinct worktree path',
  )
})

// ── 13. DEADLOCK GUARD: a node that THROWS must not hang the while-loop ──
// If an agent dies with a terminal error (real throw, not merged:false), the
// main loop's onRejected must still record a result + free the inflight slot,
// or the run never terminates. We assert the script returns (doesn't hang) and
// the crashed node is marked needs-human.
test('a node that throws is recorded as needs-human (no deadlock)', async () => {
  const tasks = [
    { id: 'T1', title: 'crashes', spec: 's', gate: 'g', dependsOn: [] },
    { id: 'T2', title: 'fine', spec: 's', gate: 'g', dependsOn: [] },
  ]
  // T1's Dev throws a terminal error; T2 proceeds normally.
  const finished = runScript({
    args: baseArgs(tasks),
    agentImpl: ({ label }) => {
      if (taskOf(label) === 'T1' && roleOf(label) === 'dev') throw new Error('terminal API error')
      return ok(label)
    },
  })
  // Guard against an actual hang: lose to a timeout if the loop never ends.
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK: script did not terminate')), 2000))
  const { result } = await Promise.race([finished, timeout])
  const t1 = result.needsHuman.find((n) => n.id === 'T1')
  assert.ok(t1, 'T1 must be recorded (not lost to a hang)')
  assert.match(t1.reason, /crashed/)
  assert.equal(result.summary.done, 1, 'T2 should still land despite T1 crashing')
})

// ── 14. Rework Dev is told to rebase onto latest trunk (Bug 1) ──
test('rework Dev rebases its worktree onto latest trunk before fixing', async () => {
  let tc = 0
  const { calls } = await runScript({
    args: baseArgs(oneTask),
    agentImpl: ({ label }) => {
      const r = roleOf(label)
      if (r === 'test') { tc++; return tc === 1 ? { pass: false, output: 'f', checkedGate: 'g', failingClauses: ['x'] } : ok(label) }
      return ok(label)
    },
  })
  const dev2 = calls.find((c) => c.label === 'dev:T1#2')
  assert.match(dev2.prompt, /fetch origin/i)
  assert.match(dev2.prompt, /rebase your worktree/i)
})

// ── 15. Tester worktrees are swept on exit even if a Tester died (#4) ──
test('cleanup sweeps throwaway Tester worktrees (covers a died Tester)', async () => {
  // Tester dies (returns null) → node ends needs-human, but the throwaway
  // worktree path must still be handed to the janitor for removal.
  const { calls, result } = await runScript({
    args: { ...baseArgs(oneTask), maxRounds: 1 },
    agentImpl: ({ label }) => {
      const r = roleOf(label)
      if (r === 'test') return null            // Tester died after creating its worktree
      return ok(label)
    },
  })
  const cleanCall = calls.find((c) => c.label === 'clean:T1')
  assert.ok(cleanCall, 'janitor must run')
  // The janitor prompt must include the throwaway Tester worktree path.
  assert.match(cleanCall.prompt, /test-T1-r1/, 'cleanup must include the Tester throwaway worktree')
  assert.equal(result.needsHuman[0].id, 'T1')
})

// ── runner ──
const run = async () => {
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e) { console.log(`  ✗ ${name}`); console.log(`      ${e.message}`) }
  }
  console.log(`\n${passed}/${tests.length} passed`)
  process.exit(passed === tests.length ? 0 : 1)
}
run()
