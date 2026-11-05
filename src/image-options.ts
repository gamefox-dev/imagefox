export type ImageResolution = '0.5K' | '1K' | '2K' | '4K'
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp' | 'gif'

export type ImageOutputOptions = {
  quality?: ImageQuality
  outputFormat?: ImageOutputFormat
  frameCount?: number
  frameDurationMs?: number
}

// GIF output has a different pixel budget from still images; Auto sizing is
// recommended, and the provider validates explicit per-frame dimensions.
export function imageOutputOptions(options: ImageOutputOptions, maxFrames = 64) {
  const { quality, outputFormat, frameCount = 9, frameDurationMs = 200 } = options
  if (outputFormat === 'gif') {
    if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > maxFrames) {
      throw new Error(`GIF frame count must be an integer between 2 and ${maxFrames}.`)
    }
    if (!Number.isFinite(frameDurationMs) || frameDurationMs < 20 || frameDurationMs > 2000) {
      throw new Error('GIF frame duration must be between 20 and 2000 ms.')
    }
  }
  return {
    ...(quality ? { quality } : {}),
    ...(outputFormat ? { output_format: outputFormat } : {}),
    ...(outputFormat === 'gif' ? { frame_count: frameCount, frame_duration_ms: Math.round(frameDurationMs / 10) * 10 } : {}),
  }
}

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

export function backgroundOptions(
  transparency?: boolean,
  outputFormat?: ImageOutputFormat,
): { background?: 'transparent' | 'opaque'; output_format?: 'png' | 'webp' } {
  if (transparency === undefined) return {}
  if (transparency && outputFormat && outputFormat !== 'png' && outputFormat !== 'webp') {
    throw new Error('Transparent backgrounds require PNG or WebP output. Choose an alpha-capable format or turn off transparency.')
  }
  return transparency ? { background: 'transparent', output_format: outputFormat === 'webp' ? 'webp' : 'png' } : { background: 'opaque' }
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
