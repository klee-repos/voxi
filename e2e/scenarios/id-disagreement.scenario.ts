/**
 * id-03 / proc-02 — catalog↔web disagreement resolves to a non-mutating "confident maybe".
 *
 * Demonstrates the deterministic↔agentic balance:
 *  - AGENTIC: get from the camera to a settled reveal for a deliberately ambiguous object (the agent decides
 *    the taps; resilient to layout). It may NOT decide the outcome.
 *  - DETERMINISTIC: every value that matters is pinned — the chip must be PROBABLE, BOTH candidates must be
 *    offered, the title must NOT silently change after the card settles, and the confidence chip must be
 *    visually distinct from a safety refusal.
 *
 * Vendor responses come from a recorded tape (`ambiguous-roadbike`) so the disagreement is reproducible in
 * CI; the same scenario runs `--live` to re-record and prove the real cascade still disagrees on this image.
 */
import { scenario } from '../framework/driver'
import { ids } from '../framework/testids'

export default scenario({
  id: 'id-03',
  title: 'catalog↔web disagreement → PROBABLE, both candidates, no silent mutation',
  pure: 'hybrid',
  surfaces: ['web', 'ios'],
  modes: ['replay', 'live'],
  tags: ['identification', 'honesty', 'confidence'],

  async run({ driver, agent, expect, world }) {
    // --- Arrange: seed a catalog entry that the vector stage will match, while the web stage will pick a
    // different year. The fixture image + tape encode the disagreement deterministically. ---
    await world.reset('seed-ambiguous')
    await world.seedCatalogItem({
      name: '2008 Cannondale SuperSix EVO',
      visibility: 'global',
      imageFixture: 'roadbike-supersix-2008.jpg',
    })
    const { token } = await world.asUser({ plan: 'free' })
    void token // used by the driver's authed session boot

    // --- Act (AGENTIC navigation): reach a settled reveal for the ambiguous capture. ---
    await driver.waitFor(ids.camera.screen)
    await agent.achieve('photograph the road bike and wait until the Guide settles on an answer', {
      maxSteps: 8,
    })

    // --- Assert (DETERMINISTIC): the outcome is honest and stable. ---
    await expect.visible(ids.reveal.card)

    // 1) It must hedge, not assert: band is PROBABLE and the chip says a "confident maybe", not a hard claim.
    await expect.chipBand(ids.reveal.confidenceChip, 'PROBABLE')
    await expect.oneOf(ids.reveal.title, [/confident maybe/i, /Cannondale/i])

    // 2) Both candidates from the disagreement are offered to the user (which doubles as a labeling signal).
    const candidates = ids.reveal.candidateOption
    await expect.visible(candidates)
    await expect.attr(candidates, 'count', /^[2-9]$/) // at least two candidates rendered

    // 3) The "How sure?" affordance auto-elevated (PROBABLE), and the evidence reads as Voxi showing its work.
    await expect.visible(ids.reveal.howSure)
    await driver.tap(ids.reveal.howSure)
    await expect.visible(ids.reveal.evidencePanel)

    // 4) No silent mutation: capture the title, wait past any late web refinement, assert it is unchanged
    //    (a refinement must arrive as an explicit "I've confirmed it", never a silent swap).
    const before = (await driver.state(ids.reveal.title)).text
    await driver.waitFor(ids.reveal.title, { timeoutMs: 6000 })
    const after = (await driver.state(ids.reveal.title)).text
    if (before !== after) {
      // allowed ONLY if an explicit confirmation banner accompanied the change
      await expect.visible(ids.reveal.confidenceChip)
      await expect.text(ids.reveal.quip, /confirmed|I'll commit/i)
    }

    // 5) The confidence treatment must NOT look like a safety refusal (warm gold vs caution).
    await expect.notVisible(ids.global.safetyRefusal)

    // 6) Server invariant: the cascade never surfaced an unverified Stage-1 claim as fact.
    const threadId = (await driver.state(ids.reveal.card)).attrs['thread.id']
    await expect.server({ kind: 'noUnverifiedClaim', threadId })
  },
})
