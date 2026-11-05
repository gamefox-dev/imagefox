import assert from 'node:assert/strict'
import { test } from 'node:test'
import { constrainNumber, parseNumberDraft } from '../src/number-input.ts'

test('allows clearing and intermediate drafts without treating them as zero', () => {
  for (const draft of ['', ' ', '-', '+', '.', '-.', '1e', '1e-', 'invalid', 'Infinity', 'NaN', '1e999']) {
    assert.equal(parseNumberDraft(draft), undefined, draft)
  }
})

test('parses complete drafts without rewriting their text', () => {
  for (const [draft, value] of [['1', 1], ['20', 20], ['200', 200], ['0200', 200], ['1.', 1], ['.5', 0.5], ['-2', -2], ['1e2', 100]] as const) {
    assert.equal(parseNumberDraft(draft), value)
  }
})

test('keeps underlying numbers in range and snaps to the configured step', () => {
  const frames = { min: 2, max: 64 }
  assert.equal(constrainNumber(1, frames), 2)
  assert.equal(constrainNumber(12, frames), 12)
  assert.equal(constrainNumber(999, frames), 64)
  assert.equal(constrainNumber(5.7, frames), 6)
  const duration = { min: 20, max: 2000, step: 10 }
  assert.equal(constrainNumber(2, duration), 20)
  assert.equal(constrainNumber(203, duration), 200)
  assert.equal(constrainNumber(206, duration), 210)
  assert.equal(constrainNumber(3000, duration), 2000)
})

test('supports decimal steps and a non-zero minimum', () => {
  assert.equal(constrainNumber(0.26, { min: 0, max: 1, step: 0.1 }), 0.3)
  assert.equal(constrainNumber(8, { min: 3, max: 20, step: 4 }), 7)
  assert.equal(constrainNumber(-3.6, {}), -4)
})

test('typing a duration one digit at a time keeps the draft intact and state valid', () => {
  const constraints = { min: 20, max: 2000, step: 10 }
  let value = 200
  for (const [draft, expected] of [['', 200], ['3', 20], ['35', 40], ['350', 350]] as const) {
    const parsed = parseNumberDraft(draft)
    if (parsed !== undefined) value = constrainNumber(parsed, constraints)
    assert.equal(value, expected)
  }
})
