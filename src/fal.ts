import { backgroundOptions, imageOutputOptions } from './image-options.ts'
import type { ImageOutputFormat, ImageQuality } from './image-options.ts'

export const FAL_BASE_URL = 'https://queue.fal.run'
export const FAL_DEFAULT_MODEL = 'openai/gpt-image-2.6/flare/edit'

// Only route this known endpoint family. Other fal models have different edit
// conventions and must keep their explicitly configured endpoint.
export function falModelEndpoint(modelName: string, hasInputs: boolean): string {
  const endpoint = modelName.trim().replace(/^\/+|\/+$/g, '')
  const gptImage26 = endpoint.match(/^(openai\/gpt-image-2\.6\/(?:flare|sunburst))(?:\/(?:edit|text-to-image))?$/)
  return gptImage26 ? `${gptImage26[1]}/${hasInputs ? 'edit' : 'text-to-image'}` : endpoint
}

type FalImageRequest = {
  baseUrl?: string
  apiKey: string
  modelName: string
  prompt: string
  imageUrls: string[]
  imageSize: 'auto' | { width: number; height: number }
  transparency?: boolean
  quality?: ImageQuality
  outputFormat?: ImageOutputFormat
  frameCount?: number
  frameDurationMs?: number
  disableSafety?: boolean
}

type QueueStatus = {
  status?: string
  error?: string
  status_url?: string
  response_url?: string
}

type FalOutput = {
  images?: Array<{ url?: string; content_type?: string }>
}

// Use the queue rather than holding a single inference connection open. GPT
// Image 2.6 reference requests must use /edit, including animated GIF output.
export async function generateFalImage({
  baseUrl, apiKey, modelName, prompt, imageUrls, imageSize, transparency, quality, outputFormat, frameCount, frameDurationMs, disableSafety,
}: FalImageRequest): Promise<Blob> {
  const base = (baseUrl?.trim() || FAL_BASE_URL).replace(/\/+$/, '')
  const endpoint = falModelEndpoint(modelName, imageUrls.length > 0)
  if (!/^[\w-]+(?:\/[\w.-]+)+$/.test(endpoint) || endpoint.split('/').some(p => p === '.' || p === '..')) {
    throw new Error('fal.ai model name must be an endpoint ID, e.g. openai/gpt-image-2.6/flare/edit (not a URL).')
  }

  const outputOptions = imageOutputOptions({ quality, outputFormat, frameCount, frameDurationMs }, imageUrls.length > 0, 64, true)
  if (disableSafety && endpoint.startsWith('openai/') && !endpoint.startsWith('openai/gpt-image-2.6/')) {
    throw new Error('fal OpenAI endpoints do not document a safety override. Turn off “Disable / reduce safety” in Models.')
  }

  // Keep follow-up requests on the configured proxy, and never forward the key
  // to an arbitrary origin supplied in a queue response.
  function queueUrl(value: string | undefined): string {
    if (!value) throw new Error('fal.ai queue response is missing a status_url or response_url.')
    const url = new URL(value, `${base}/`)
    if (url.origin === FAL_BASE_URL) return `${base}${url.pathname}${url.search}`
    if (url.origin === new URL(base).origin && !url.username && !url.password) return url.href
    throw new Error('fal.ai queue returned a URL outside the configured API origin.')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000)
  const headers = { Authorization: `Key ${apiKey}` }

  async function request<T>(url: string, body?: object): Promise<T> {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`fal.ai (${res.status}): ${text.slice(0, 2000) || res.statusText}`)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error('fal.ai returned an invalid JSON response.')
    }
  }

  try {
    let status = await request<QueueStatus>(`${base}/${endpoint}`, {
      prompt,
      ...(imageUrls.length ? { image_urls: imageUrls } : {}),
      image_size: imageSize,
      num_images: 1,
      ...outputOptions,
      ...backgroundOptions(transparency, outputFormat),
      ...(disableSafety ? { enable_safety_checker: false } : {}),
    })
    const statusUrl = queueUrl(status.status_url)
    const responseUrl = queueUrl(status.response_url)

    while (true) {
      if (status.error) throw new Error(`fal.ai: ${status.error}`)
      if (status.status === 'COMPLETED') break
      if (status.status !== 'IN_QUEUE' && status.status !== 'IN_PROGRESS') {
        throw new Error(`fal.ai returned an unexpected queue status: ${status.status ?? 'missing'}`)
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
      status = await request<QueueStatus>(statusUrl)
    }

    const result = await request<FalOutput>(responseUrl)
    const image = result.images?.[0]
    if (!image?.url) throw new Error('fal.ai response contained no image in images[0].url.')
    // Both hosted URLs and base64 data URIs work with fetch. Never send the API
    // key to the media host.
    const res = await fetch(image.url, { signal: controller.signal })
    if (!res.ok) throw new Error(`Could not download fal.ai image (${res.status})`)
    const blob = await res.blob()
    return image.content_type && blob.type !== image.content_type
      ? new Blob([blob], { type: image.content_type })
      : blob
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('fal.ai timed out after 10 minutes. The request may still be running on fal.ai; check its history before retrying.', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
