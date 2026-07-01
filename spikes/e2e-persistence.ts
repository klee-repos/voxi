/**
 * PROOF that the PGlite-backed BFF stores are genuinely durable across a process restart (task #20).
 *
 * No cheating: we write real rows through real SQL to a file-backed dataDir, CLOSE the PGlite entirely, then
 * reopen createPgStores() on the SAME dir (simulating a fresh process) and assert every value survived. We
 * also prove the atomic decrement refuses when insufficient and that putToken is idempotent (first token wins).
 *
 * Run: cd /Users/kvnlee/dev/voxi && bun spikes/e2e-persistence.ts
 */
import { rmSync } from 'node:fs'
import { createPgStores } from '../services/voxi-api/src/pg-stores'

const DIR = '/tmp/voxi-pgstore-e2e-' + Date.now()
const U = 'user_persist_A'
const OTHER = 'user_persist_B'

let failures = 0
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

async function main(): Promise<void> {
  // Clean slate.
  rmSync(DIR, { recursive: true, force: true })
  console.log(`dataDir: ${DIR}\n`)

  // ---- Phase 1: write state, then CLOSE (flush to disk). ----
  console.log('--- Phase 1: write + close ---')
  {
    const { store, threads, close } = await createPgStores(DIR)

    const dec = await store.tryDecrement(U, 'scan', 1) // 100000 -> 99999 (lazy row inserted first)
    check('phase1 tryDecrement(scan,1) succeeded', dec === true)
    check('phase1 remaining(scan) === 99999', (await store.remaining(U, 'scan')) === 99999)

    await store.putToken('k1', 'tok1')
    check("phase1 getToken('k1') === 'tok1'", (await store.getToken('k1')) === 'tok1')

    await threads.put({
      threadId: 't1',
      ownerUserId: U,
      title: 'A red enamel Le Creuset',
      createdAt: 1_700_000_000_000,
      continuationToken: 'cont-abc',
    })
    // Second, newer thread + one owned by a DIFFERENT user (ACL scoping proof).
    await threads.put({
      threadId: 't2',
      ownerUserId: U,
      title: 'A brass door handle',
      createdAt: 1_700_000_100_000,
      continuationToken: 'cont-def',
    })
    await threads.put({
      threadId: 't3',
      ownerUserId: OTHER,
      title: "Someone else's mug",
      createdAt: 1_700_000_200_000,
      continuationToken: 'cont-xyz',
    })
    check('phase1 listByOwner(U) has 2 threads', (await threads.listByOwner(U)).length === 2)

    await close()
    console.log('closed pglite\n')
  }

  // ---- Phase 2: REOPEN the same dir (simulated restart) and assert survival. ----
  console.log('--- Phase 2: reopen + assert survival ---')
  {
    const { store, threads, close } = await createPgStores(DIR)

    check('SURVIVED remaining(U,scan) === 99999', (await store.remaining(U, 'scan')) === 99999)
    check("SURVIVED getToken('k1') === 'tok1'", (await store.getToken('k1')) === 'tok1')

    const owned = await threads.listByOwner(U)
    check('SURVIVED listByOwner(U) has 2 threads', owned.length === 2)
    check('SURVIVED newest-first ordering (t2 before t1)', owned[0]?.threadId === 't2' && owned[1]?.threadId === 't1')
    check('SURVIVED thread fields intact (t1 continuationToken)', (await threads.get('t1'))?.continuationToken === 'cont-abc')
    check('ACL: listByOwner(U) excludes other user thread t3', !owned.some((t) => t.threadId === 't3'))
    check('ACL: listByOwner(OTHER) has exactly t3', (await threads.listByOwner(OTHER)).map((t) => t.threadId).join(',') === 't3')

    // Atomic refusal: cannot overdraw. remaining stays 99999.
    const over = await store.tryDecrement(U, 'scan', 999_999)
    check('tryDecrement(scan,999999) returns false (insufficient)', over === false)
    check('remaining(U,scan) unchanged at 99999 after refused decrement', (await store.remaining(U, 'scan')) === 99999)

    // Idempotency: a second putToken on the same key keeps the first token.
    await store.putToken('k1', 'tok2')
    check("putToken idempotent: getToken('k1') still 'tok1'", (await store.getToken('k1')) === 'tok1')

    // voiceMin maps to the voice_min column safely.
    const vdec = await store.tryDecrement(U, 'voiceMin', 5)
    check('tryDecrement(voiceMin,5) succeeded', vdec === true)
    check('remaining(U,voiceMin) === 99995', (await store.remaining(U, 'voiceMin')) === 99995)

    // credit refunds.
    await store.credit(U, 'scan', 1)
    check('credit(scan,1) → remaining 100000', (await store.remaining(U, 'scan')) === 100000)

    await close()
  }

  // Cleanup.
  rmSync(DIR, { recursive: true, force: true })

  console.log('')
  if (failures > 0) {
    console.log(`RESULT: FAILED (${failures} assertion${failures === 1 ? '' : 's'} failed)`)
    process.exit(1)
  }
  console.log('RESULT: ALL ASSERTIONS PASSED')
}

main().catch((err) => {
  console.error('SPIKE ERRORED:', err)
  process.exit(2)
})
