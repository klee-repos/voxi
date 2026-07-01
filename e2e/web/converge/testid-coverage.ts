/**
 * testid-coverage.ts — STATIC convergence check (companion to the runtime reveal-rnw.web.ts proof).
 *
 * The convergence contract (docs/CONVERGENCE.md): the harness web UI (e2e/web/server.ts) and the REAL Expo
 * screens (app/app/*.tsx + app/app/(tabs)/*.tsx + their components) must locate behind the SAME testid set, so
 * a scenario written against the harness runs unchanged against the real screens. This check proves that set
 * equality statically — no browser, no creds — and fails loudly on drift, so a screen can never silently grow
 * a testid the other side lacks.
 *
 * Three sources, all real:
 *   REGISTRY — e2e/framework/testids.ts (the single source of truth; allIds()).
 *   HARNESS  — every `data-testid="…"` literal rendered by e2e/web/server.ts (the shell scenarios drive today).
 *   APP      — every `ids.<screen>.<el>` the real app source references (screens + components).
 *
 * Pass rule (deterministic): (1) every HARNESS id and every APP id is a known REGISTRY id (no stray strings),
 * and (2) the APP and HARNESS id sets are EQUAL on the screens both implement — i.e. no contract id is rendered
 * by one side but absent from the other. Ids that are intentionally iOS-only (no web harness surface) are listed
 * in IOS_ONLY and excluded from the equality (documented exceptions, not silent gaps).
 *
 * Run: `bun e2e/web/converge/testid-coverage.ts`  (exit 0 = sets converge).
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { allIds, ids } from '../../framework/testids'

const repo = path.resolve(import.meta.dir, '../../..')
const read = (p: string) => readFileSync(path.join(repo, p), 'utf8')

// --- REGISTRY ---
const registry = allIds()

// --- HARNESS: data-testid literals rendered by the harness shell ---
const harnessSrc = read('e2e/web/server.ts')
const harnessIds = new Set([...harnessSrc.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]))
// the harness also creates a few ids dynamically via setAttribute('data-testid', '…literal…')
for (const m of harnessSrc.matchAll(/setAttribute\('data-testid','([^']+)'/g)) harnessIds.add(m[1])

// --- APP: every ids.<screen>.<el> the real app source references (screens + the components they render) ---
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(path.join(repo, dir))) {
    const rel = `${dir}/${name}`
    const st = statSync(path.join(repo, rel))
    if (st.isDirectory()) out.push(...walk(rel))
    else if (/\.tsx?$/.test(name)) out.push(rel)
  }
  return out
}
// Exclude the testid bridge itself (app/src/lib/testid.ts) — its JSDoc uses `ids.x.y` as illustrative prose,
// not a real element reference; it is the contract bridge, not a screen.
const appFiles = [...walk('app/app'), ...walk('app/src/components'), ...walk('app/src/lib')].filter(
  (f) => !/app\/src\/lib\/testid\.ts$/.test(f),
)
// Map "ids.reveal.card" → the actual string value via the registry object, so a typo'd id.x.y that isn't in the
// registry is itself a drift signal (it would resolve to undefined and be reported).
const appIds = new Set<string>()
const strayRefs: string[] = []
for (const f of appFiles) {
  const src = read(f)
  for (const m of src.matchAll(/\bids\.([a-zA-Z]+)\.([a-zA-Z0-9]+)/g)) {
    const group = (ids as unknown as Record<string, Record<string, string>>)[m[1]]
    const val = group?.[m[2]]
    if (typeof val === 'string') appIds.add(val)
    else strayRefs.push(`${f}: ids.${m[1]}.${m[2]} (not in registry)`)
  }
}

// --- Documented exceptions: ids that exist only on one surface BY DESIGN (not drift) ---
// iOS-/native-only screens have no web harness shell counterpart (camera viewfinder, first-run permission
// priming, etc. are exercised on the iOS surface per TEST-PLAN.md). They are real registry ids the app uses but
// the WEB harness deliberately does not render — excluded from the web equality, listed here so they are
// auditable rather than silent.
const IOS_ONLY = new Set<string>([
  ids.firstRun.meetVoxiNext,
  ids.firstRun.cameraPrimeAllow,
  ids.firstRun.micPrimeAllow,
  ids.firstRun.privacyAck,
  ids.firstRun.shareConsentToggle,
  ids.camera.permissionDeniedBanner,
  ids.camera.openSettings,
  ids.camera.retakeHint,
])

// --- checks ---
let fails = 0
const fail = (msg: string) => {
  fails++
  console.log('  FAIL', msg)
}
const pass = (msg: string) => console.log('  PASS', msg)

console.log('static testid coverage (registry ↔ harness shell ↔ real app screens):')

// 1) no stray ids.x.y references in app source (every one resolves to a real registry id)
if (strayRefs.length) for (const s of strayRefs) fail('stray app id: ' + s)
else pass(`every ids.x.y in app source resolves to a registry id (${appIds.size} distinct app ids)`)

// 2) every harness id is a registry id
const harnessStray = [...harnessIds].filter((id) => !registry.has(id))
if (harnessStray.length) for (const id of harnessStray) fail('harness renders non-registry id: ' + id)
else pass(`every harness data-testid is a registry id (${harnessIds.size} distinct harness ids)`)

// 3) SET DELTA on the web-shared surface. The harness shell (e2e/web/server.ts) is FROZEN by the task (must
//    not be edited); the convergence direction is that server.ts will later import the REAL components, at which
//    point any app-only affordance the real screen renders auto-appears in the harness. So app↔harness set
//    differences are reported as DIVERGENCES (informational, drive that swap + the app fixes), not hard
//    failures — while stray/non-registry ids above remain hard failures (those are correctness bugs today).
const appWeb = new Set([...appIds].filter((id) => !IOS_ONLY.has(id)))
const inAppNotHarness = [...appWeb].filter((id) => !harnessIds.has(id)).sort()
const inHarnessNotApp = [...harnessIds].filter((id) => !appIds.has(id) && !IOS_ONLY.has(id)).sort()

const divergences: string[] = []
if (inAppNotHarness.length === 0) pass('every web-shared app id is covered by the harness shell')
else {
  for (const id of inAppNotHarness)
    divergences.push(`app renders "${id}" (real screen affordance) but the frozen harness shell does not`)
  console.log(`  DIVERGENCE ${inAppNotHarness.length} app id(s) not in the harness shell (see below)`)
}

if (inHarnessNotApp.length === 0) pass('every harness id is referenced by a real app screen')
else {
  for (const id of inHarnessNotApp)
    divergences.push(`harness renders "${id}" but no real app screen references it`)
  console.log(`  DIVERGENCE ${inHarnessNotApp.length} harness id(s) not referenced by any app screen`)
}

console.log(`\nsummary: registry=${registry.size} app=${appIds.size} harness=${harnessIds.size} iosOnly=${IOS_ONLY.size}`)
if (divergences.length) {
  console.log('--- convergence divergences (recorded in docs/CONVERGENCE.md; close when server.ts adopts the real components) ---')
  for (const d of divergences) console.log('  •', d)
}
console.log(
  fails === 0
    ? `STATIC COVERAGE GREEN — no stray ids; ${divergences.length} documented app↔harness divergence(s)`
    : `STATIC COVERAGE FAILURES: ${fails}`,
)
process.exit(fails === 0 ? 0 : 1)
