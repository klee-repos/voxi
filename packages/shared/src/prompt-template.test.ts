/**
 * Unit coverage for the prompt-template renderer (the mechanism behind prompts-as-md). These prove the small
 * Mustache subset behaves exactly as the extracted `.md` prompts rely on: variable substitution, plain and
 * inverted sections, byte-exact list joins (newline-as-separator), and no stray whitespace when a section drops.
 */
import { test, expect, describe } from 'bun:test'
import { renderTemplate } from './prompt-template'

describe('renderTemplate — variables', () => {
  test('substitutes present vars and blanks missing/null ones', () => {
    expect(renderTemplate('Hi {{name}}, {{missing}}done', { name: 'Voxi' })).toBe('Hi Voxi, done')
    expect(renderTemplate('{{a}}/{{b}}', { a: 0, b: null })).toBe('0/')
  })
  test('does not HTML-escape (prompts are plain text)', () => {
    expect(renderTemplate('{{x}}', { x: '"a" & <b>' })).toBe('"a" & <b>')
  })
})

describe('renderTemplate — sections', () => {
  test('plain section renders only when truthy; inverted is the complement', () => {
    const t = '{{#on}}YES {{v}}{{/on}}{{^on}}NO{{/on}}'
    expect(renderTemplate(t, { on: true, v: 'x' })).toBe('YES x')
    expect(renderTemplate(t, { on: false })).toBe('NO')
  })
  test('side-by-side same-name sections are independent (a #/^ pair)', () => {
    const t = '{{#k}}A{{/k}}{{^k}}B{{/k}}'
    expect(renderTemplate(t, { k: 1 })).toBe('A')
    expect(renderTemplate(t, { k: '' })).toBe('B')
  })
  test('a dropped standalone-ish section leaves no blank line (newline-as-separator)', () => {
    const t = 'one\n{{#mid}}two\n{{/mid}}three'
    expect(renderTemplate(t, { mid: true })).toBe('one\ntwo\nthree')
    expect(renderTemplate(t, { mid: false })).toBe('one\nthree')
  })
})

describe('renderTemplate — list sections', () => {
  test('renders body once per element with element fields in scope', () => {
    const t = 'H:{{#rows}}\n  {{ref}} → {{claim}}{{/rows}}'
    expect(renderTemplate(t, { rows: [{ ref: 'r1', claim: 'c1' }, { ref: 'r2', claim: 'c2' }] })).toBe('H:\n  r1 → c1\n  r2 → c2')
  })
  test('empty array renders nothing; inverted fires on empty array', () => {
    expect(renderTemplate('{{#rows}}x{{/rows}}', { rows: [] })).toBe('')
    expect(renderTemplate('{{^rows}}none{{/rows}}', { rows: [] })).toBe('none')
  })
  test('outer scope still resolves inside a list item', () => {
    expect(renderTemplate('{{#rows}}{{prefix}}{{n}} {{/rows}}', { prefix: '#', rows: [{ n: 1 }, { n: 2 }] })).toBe('#1 #2 ')
  })
})
