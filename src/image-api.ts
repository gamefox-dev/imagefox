import { backgroundOptions, openAiSize, openRouterImageConfig } from './image-options.ts'
import type { ImageResolution } from './image-options.ts'

type ImageRequest = {
  baseUrl?: string
  apiKey: string
  modelName: string
  prompt: string
  aspectRatio: string
  resolution: ImageResolution
  transparency?: boolean
  disableSafety?: boolean
}

type ImageInput = { blob: Blob; name: string; type: string }

type ImageResponse = {
  data?: Array<{ b64_json?: string; url?: string; media_type?: string }>
  output_format?: string
  error?: { message?: string }
}

async function imageResponse(res: Response, provider: string): Promise<Blob> {
  if (!res.ok) throw new Error(`${provider} (${res.status}): ${await res.text()}`)
  const json = await res.json() as ImageResponse
  if (json.error) throw new Error(`${provider}: ${json.error.message || 'Image generation failed'}`)
  const item = json.data?.[0]
  if (item?.b64_json) {
    const mime = item.media_type || (json.output_format ? `image/${json.output_format}` : 'image/png')
    const bytes = Uint8Array.from(atob(item.b64_json), char => char.charCodeAt(0))
    return new Blob([bytes], { type: mime })
  }
  if (item?.url) {
    // Media hosts must never receive the provider API key.
    const image = await fetch(item.url)
    if (!image.ok) throw new Error(`Could not download generated image (${image.status})`)
    const blob = await image.blob()
    return item.media_type ? new Blob([blob], { type: item.media_type }) : blob
  }
  throw new Error(`${provider} response contained no image in data[0].b64_json or data[0].url`)
}

export async function generateOpenAiImage({
  baseUrl, apiKey, modelName, prompt, aspectRatio, resolution, transparency, disableSafety, inputs,
}: ImageRequest & { inputs: ImageInput[] }): Promise<Blob> {
  const base = (baseUrl?.trim() || 'https://api.openai.com').replace(/\/+$/, '')
  const headers = { Authorization: `Bearer ${apiKey}` }
  const options = {
    ...backgroundOptions(transparency),
    ...(disableSafety ? { moderation: 'low' } : {}),
  }
  let res: Response
  if (inputs.length) {
    const form = new FormData()
    form.append('model', modelName)
    form.append('prompt', prompt)
    form.append('n', '1')
    form.append('size', openAiSize(aspectRatio, resolution))
    for (const [key, value] of Object.entries(options)) form.append(key, value)
    inputs.forEach((img, i) => {
      form.append('image[]', new File([img.blob], img.name || `input-${i}.png`, { type: img.type || img.blob.type || 'image/png' }))
    })
    res = await fetch(`${base}/v1/images/edits`, { method: 'POST', headers, body: form })
  } else {
    res = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt, n: 1, size: openAiSize(aspectRatio, resolution), ...options }),
    })
  }
  return imageResponse(res, 'OpenAI')
}

type ImageEndpoint = {
  provider_slug: string
  provider_tag?: string | null
  allowed_passthrough_parameters?: string[]
}

// There is no global safety switch on the Images API. Discover the permitted
// provider-specific fields only when requested, and constrain routing so a
// fallback cannot silently ignore the user's setting. Do not retry generation.
async function openRouterSafety(base: string, apiKey: string, modelName: string) {
  const modelPath = modelName.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`${base}/api/v1/images/models/${modelPath}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`Could not check OpenRouter safety options (${res.status}): ${await res.text()}`)
  const json = await res.json() as { endpoints?: ImageEndpoint[] }
  const options: Record<string, Record<string, boolean | string>> = {}
  const only = new Set<string>()
  for (const endpoint of json.endpoints ?? []) {
    const allowed = endpoint.allowed_passthrough_parameters ?? []
    const values: Record<string, boolean | string> = {}
    if (allowed.includes('enable_safety_checker')) values.enable_safety_checker = false
    if (allowed.includes('moderation')) values.moderation = 'low'
    if (!Object.keys(values).length || !endpoint.provider_tag) continue
    options[endpoint.provider_slug] = values
    only.add(endpoint.provider_tag)
  }
  if (!only.size) {
    throw new Error('This OpenRouter model has no routable endpoint advertising enable_safety_checker or moderation. Turn off “Disable / reduce safety” in Models to use provider defaults.')
  }
  return { provider: { only: [...only], options } }
}

export async function generateOpenRouterImage({
  baseUrl, apiKey, modelName, prompt, aspectRatio, resolution, transparency, disableSafety, imageUrls,
}: ImageRequest & { imageUrls: string[] }): Promise<Blob> {
  const base = (baseUrl?.trim() || 'https://openrouter.ai').replace(/\/+$/, '')
  const safety = disableSafety ? await openRouterSafety(base, apiKey, modelName) : {}
  const res = await fetch(`${base}/api/v1/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      prompt,
      n: 1,
      ...openRouterImageConfig(aspectRatio, resolution),
      ...backgroundOptions(transparency),
      ...safety,
      ...(imageUrls.length ? {
        input_references: imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
      } : {}),
    }),
  })
  return imageResponse(res, 'OpenRouter')
}
