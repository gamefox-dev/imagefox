export type ImageResolution = '0.5K' | '1K' | '2K' | '4K'

export function openAiSize(ar: string, resolution: ImageResolution) {
  if (ar === 'auto') return 'auto'
  const [w, h] = ar.split(':').map(Number)
  const ratio = w && h ? w / h : 1
  const targetLongEdge: Record<ImageResolution, number> = { '0.5K': 512, '1K': 1024, '2K': 2048, '4K': 3840 }
  const maxEdge = 3840
  const minPixels = 655_360
  const maxPixels = 8_294_400
  const round = (value: number) => Math.max(16, Math.round(value / 16) * 16)

  const longEdge = Math.min(targetLongEdge[resolution], maxEdge)
  let width = round(ratio >= 1 ? longEdge : longEdge * ratio)
  let height = round(ratio >= 1 ? longEdge / ratio : longEdge)

  // GPT Image dimensions must be multiples of 16 and within its pixel budget.
  while (width * height < minPixels && Math.max(width, height) < maxEdge) {
    width = round(width * 1.05)
    height = round(height * 1.05)
  }
  while (width * height > maxPixels || Math.max(width, height) > maxEdge) {
    width = round(width * 0.98)
    height = round(height * 0.98)
  }
  return `${width}x${height}`
}

export function falImageSize(ar: string, resolution: ImageResolution) {
  const size = openAiSize(ar, resolution)
  if (size === 'auto') return 'auto'
  const [width, height] = size.split('x').map(Number)
  return { width, height }
}

// Omit sizing in Auto mode so providers without a literal "auto" capability
// (including Gemini) retain their defaults. Images API tiers use "512", not "0.5K".
export function openRouterImageConfig(ar: string, resolution: ImageResolution) {
  return ar === 'auto' ? {} : { aspect_ratio: ar, resolution: resolution === '0.5K' ? '512' : resolution }
}

export function backgroundOptions(transparency?: boolean): { background?: 'transparent' | 'opaque'; output_format?: 'png' } {
  if (transparency === undefined) return {}
  return transparency ? { background: 'transparent', output_format: 'png' } : { background: 'opaque' }
}

// Gemini's documented default matches input dimensions (or chooses a square
// without inputs); "auto" is not a supported literal aspectRatio value.
export function geminiImageConfig(ar: string) {
  return ar === 'auto' ? {} : { imageConfig: { aspectRatio: ar } }
}

export function formatDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`
}
