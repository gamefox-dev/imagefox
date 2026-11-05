export type NumberConstraints = { min?: number; max?: number; step?: number }

// Empty and intermediate drafts ("-", ".", "1e", etc.) are not zero.
// Leave the last valid numeric state alone until there is a complete number.
export function parseNumberDraft(draft: string): number | undefined {
  const text = draft.trim()
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

export function constrainNumber(value: number, { min, max, step = 1 }: NumberConstraints): number {
  const lower = min ?? -Infinity
  const upper = max ?? Infinity
  let result = Math.min(upper, Math.max(lower, value))
  if (Number.isFinite(step) && step > 0) {
    const base = min ?? 0
    result = base + Math.round((result - base) / step) * step
    // Avoid showing floating-point artifacts for decimal step sizes.
    result = Number(result.toFixed(12))
  }
  return Math.min(upper, Math.max(lower, result))
}
