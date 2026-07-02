/**
 * Loading copy — pins that a REVISIT never borrows fresh-analysis phrasing (the whole point of the feature:
 * loading a saved entry must not look like re-analysis) and that the two modes never collide.
 */
import { test, expect, describe } from 'bun:test'
import { loadingLines, firstLine, settledReveal, longWaitAck, revealLoadingPill, revealEmptyState } from './loadingCopy'

describe('loadingCopy', () => {
  test('revisit and analyze select DIFFERENT line sets', () => {
    expect(loadingLines('analyze')).not.toEqual(loadingLines('revisit'))
    expect(firstLine('analyze')).toBe('Consulting the Guide…')
    expect(firstLine('revisit')).toBe('Opening your entry…')
  })

  test('[CRIT] revisit copy contains NO fresh-analysis phrasing (never "cross-referencing" / "narrowing")', () => {
    const revisit = [...loadingLines('revisit'), settledReveal('revisit', 'X'), longWaitAck('revisit'), revealLoadingPill('revisit').title, revealLoadingPill('revisit').sub].join(' | ').toLowerCase()
    expect(revisit).not.toContain('cross-referenc')
    expect(revisit).not.toContain('narrow')
    expect(revisit).not.toContain('consulting the guide')
  })

  test('settledReveal: analyze celebrates a new find; revisit re-presents', () => {
    expect(settledReveal('analyze', 'A 1976 Canon AE-1')).toBe("I've got it: A 1976 Canon AE-1.")
    expect(settledReveal('revisit', 'A 1976 Canon AE-1')).toBe('Here it is: A 1976 Canon AE-1.')
  })

  test('longWaitAck + revealLoadingPill differ by mode', () => {
    expect(longWaitAck('analyze')).not.toBe(longWaitAck('revisit'))
    expect(revealLoadingPill('analyze').title).not.toBe(revealLoadingPill('revisit').title)
  })

  test('[CRIT] revealEmptyState is a warm invitation, never an error ("nothing"/"empty"/"no ")', () => {
    const e = revealEmptyState()
    expect(e.title).toBeTruthy()
    expect(e.body).toBeTruthy()
    expect(e.cta).toBeTruthy()
    const blob = `${e.title} ${e.body} ${e.cta}`.toLowerCase()
    // the whole point of the redesign: it must not read as an empty/error state
    expect(blob).not.toContain('nothing')
    expect(blob).not.toContain('empty')
    expect(blob).not.toMatch(/\bno\b/)
    // a single clear next action that points at the camera
    expect(e.cta.toLowerCase()).toContain('camera')
  })
})
