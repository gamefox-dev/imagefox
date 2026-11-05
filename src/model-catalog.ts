export type ModelCatalogCompatibility = 'gemini' | 'gpt-image' | 'openrouter' | 'fal'

type CatalogModel = { id?: unknown; name?: unknown; endpoint_id?: unknown }

function catalogUrl(compatibility: ModelCatalogCompatibility, baseUrl?: string): string {
  const base = (baseUrl?.trim() || (compatibility === 'openrouter' ? 'https://openrouter.ai' : 'https://api.openai.com')).replace(/\/+$/, '')
  if (compatibility === 'fal') return 'https://api.fal.ai/v1/models?limit=100&status=active'
  if (compatibility === 'gemini') return `${base}/v1beta/models`
  return compatibility === 'openrouter' ? `${base}/api/v1/models` : `${base}/v1/models`
}

export async function fetchModelNames({
  compatibility,
  baseUrl,
  apiKey,
  signal,
}: {
  compatibility: ModelCatalogCompatibility
  baseUrl?: string
  apiKey?: string
  signal?: AbortSignal
}): Promise<string[]> {
  const headers: Record<string, string> = {}
  let url = catalogUrl(compatibility, baseUrl)
  if (apiKey?.trim() && compatibility === 'gemini') {
    url += `?key=${encodeURIComponent(apiKey.trim())}`
  } else if (apiKey?.trim()) {
    headers.Authorization = compatibility === 'fal' ? `Key ${apiKey.trim()}` : `Bearer ${apiKey.trim()}`
  }
  const res = await fetch(url, { headers, signal })
  if (!res.ok) throw new Error(`${compatibility} model list (${res.status}): ${await res.text()}`)
  const json = await res.json() as { data?: CatalogModel[]; models?: CatalogModel[] }
  const models = compatibility === 'fal' || compatibility === 'gemini' ? json.models ?? [] : json.data ?? []
  return [...new Set(models
    .map(model => String(
      compatibility === 'fal' ? model.endpoint_id
        : compatibility === 'gemini' ? String(model.name ?? '').replace(/^models\//, '')
          : model.id ?? '',
    ))
    .filter(Boolean))].sort((a, b) => a.localeCompare(b))
}
