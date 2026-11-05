import { useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { constrainNumber, parseNumberDraft } from './number-input'
import type { NumberConstraints } from './number-input'

type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step'
> & NumberConstraints & {
  value: number
  onValueChange: (value: number) => void
}

export function NumberInput({
  value, onValueChange, min, max, step = 1, onBlur, onKeyDown, ...props
}: NumberInputProps) {
  const [draft, setDraft] = useState({ text: null as string | null, value, min, max, step })
  const constraints = { min, max, step }

  // Own numeric updates preserve the draft. External changes (Clear, redo,
  // provider limits) replace it, without an effect or a stale extra render.
  if (draft.value !== value || draft.min !== min || draft.max !== max || draft.step !== step) {
    setDraft({ text: null, value, min, max, step })
  }

  function update(text: string) {
    const parsed = parseNumberDraft(text)
    const next = parsed === undefined ? value : constrainNumber(parsed, constraints)
    setDraft({ text, value: next, min, max, step })
    if (next !== value) onValueChange(next)
  }

  function commit() {
    const parsed = draft.text === null ? value : parseNumberDraft(draft.text) ?? value
    const next = constrainNumber(parsed, constraints)
    setDraft({ text: null, value: next, min, max, step })
    if (next !== value) onValueChange(next)
  }

  return (
    <input
      {...props}
      type="text"
      role="spinbutton"
      inputMode={props.inputMode ?? (Number.isInteger(step) ? 'numeric' : 'decimal')}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      value={draft.text ?? String(value)}
      onChange={e => update(e.target.value)}
      onBlur={e => { commit(); onBlur?.(e) }}
      onKeyDown={e => {
        onKeyDown?.(e)
        if (e.defaultPrevented) return
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const next = constrainNumber(value + (e.key === 'ArrowUp' ? step : -step), constraints)
          update(String(next))
        }
      }}
    />
  )
}
