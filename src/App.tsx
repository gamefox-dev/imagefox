import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { PhotoProvider, PhotoView } from 'react-photo-view'
import 'react-photo-view/dist/react-photo-view.css'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { FAL_BASE_URL, FAL_DEFAULT_MODEL, falModelEndpoint, generateFalImage } from './fal'
import { falImageSize, formatDuration, geminiImageConfig } from './image-options'
import { generateOpenAiImage, generateOpenRouterImage } from './image-api'
import { fetchModelNames } from './model-catalog'
import type { ImageOutputFormat, ImageQuality, ImageResolution } from './image-options'

// ─── Types ────────────────────────────────────────────────────────────────────

type ApiCompatibility = 'gemini' | 'gpt-image' | 'openrouter' | 'fal'

type ModelSetting = {
  id: string
  name: string
  compatibility: ApiCompatibility
  baseUrl?: string
  apiKey: string
  modelName: string
  disableSafety?: boolean
  createdAt: number
  updatedAt: number
}

type Project = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

type InputImage = {
  id: string
  name: string
  type: string
  blob: Blob
  sourceImageId?: string
}

type ImageJob = {
  id: string
  projectId: string
  status: 'loading' | 'generated' | 'error'
  createdAt: number
  updatedAt: number
  prompt: string
  modelName?: string
  durationMs?: number
  aspectRatio: string
  resolution: ImageResolution
  quality?: ImageQuality
  outputFormat?: ImageOutputFormat
  frameCount?: number
  frameDurationMs?: number
  transparency?: boolean
  modelSettingId: string
  inputImages: InputImage[]
  blob?: Blob
  mimeType?: string
  error?: string
}

type StudioDb = {
  modelSettings: ModelSetting[]
  projects: Project[]
  images: ImageJob[]
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────

const DB_NAME = 'imagefox-studio'
const API_KEY_STORAGE_PREFIX = 'imagefox-api-key:'
const storedApiKey = (compatibility: ApiCompatibility) => {
  if (compatibility !== 'fal' && compatibility !== 'openrouter') return ''
  try { return localStorage.getItem(`${API_KEY_STORAGE_PREFIX}${compatibility}`) ?? '' } catch { return '' }
}
const rememberApiKey = (compatibility: ApiCompatibility, apiKey: string) => {
  if (compatibility !== 'fal' && compatibility !== 'openrouter') return
  try {
    if (apiKey) localStorage.setItem(`${API_KEY_STORAGE_PREFIX}${compatibility}`, apiKey)
    else localStorage.removeItem(`${API_KEY_STORAGE_PREFIX}${compatibility}`)
  } catch { /* localStorage may be unavailable in private browsing */ }
}
const DB_VERSION = 1
const STORE = 'state'
const STATE_KEY = 'app'
const defaultState: StudioDb = { modelSettings: [], projects: [], images: [] }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function loadState(): Promise<StudioDb> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(STATE_KEY)
    req.onsuccess = () => resolve(req.result ?? defaultState)
    req.onerror = () => reject(req.error)
  })
}

async function saveState(state: StudioDb): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(state, STATE_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const uid = () => crypto.randomUUID()
const now = () => Date.now()
const aspectRatios = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9']
const imageResolutions: ImageResolution[] = ['0.5K', '1K', '2K', '4K']
const imageQualities: ImageQuality[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const imageOutputFormats: ImageOutputFormat[] = ['png', 'jpeg', 'webp', 'gif']

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(',')
  const mime = header.match(/data:(.*?);/)?.[1] ?? 'image/png'
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// ─── Object URL hook ──────────────────────────────────────────────────────────
// Stable: creates a new object URL only when the blob identity changes,
// and revokes the previous one. Avoids the "blob loaded → url valid briefly"
// problem by NOT using useMemo (which doesn't run cleanup between renders).

function useElapsedSeconds(startMs: number, active: boolean): number {
  const [secs, setSecs] = useState(() => Math.floor((Date.now() - startMs) / 1000))
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setSecs(Math.floor((Date.now() - startMs) / 1000)), 1000)
    return () => clearInterval(id)
  }, [startMs, active])
  return secs
}

function useBlobUrl(blob: Blob | undefined): string {
  const [url, setUrl] = useState(() => (blob ? URL.createObjectURL(blob) : ''))
  const prevBlob = useRef(blob)
  const prevUrl = useRef(url)

  useEffect(() => {
    if (prevBlob.current === blob) return
    prevBlob.current = blob
    if (prevUrl.current) URL.revokeObjectURL(prevUrl.current)
    const next = blob ? URL.createObjectURL(blob) : ''
    prevUrl.current = next
    setUrl(next)
    return () => { if (next) URL.revokeObjectURL(next) }
  }, [blob])

  return url
}

// ─── API ──────────────────────────────────────────────────────────────────────

function apiBase(setting: ModelSetting) {
  const fallback =
    setting.compatibility === 'gemini'
      ? 'https://generativelanguage.googleapis.com'
      : setting.compatibility === 'openrouter'
        ? 'https://openrouter.ai'
        : setting.compatibility === 'fal'
          ? FAL_BASE_URL
          : 'https://api.openai.com'
  return (setting.baseUrl || fallback).replace(/\/$/, '')
}

async function generateOneWithFal(
  setting: ModelSetting, prompt: string, ar: string, resolution: ImageResolution, inputs: InputImage[], transparency?: boolean,
  quality?: ImageQuality, outputFormat?: ImageOutputFormat, frameCount?: number, frameDurationMs?: number,
): Promise<Blob> {
  return generateFalImage({
    baseUrl: setting.baseUrl,
    apiKey: setting.apiKey,
    modelName: setting.modelName,
    prompt,
    imageUrls: await Promise.all(inputs.map(img => blobToDataUrl(img.blob))),
    imageSize: falImageSize(ar, resolution),
    transparency,
    quality,
    outputFormat,
    frameCount,
    frameDurationMs,
    disableSafety: setting.disableSafety,
  })
}

async function generateOneWithGemini(
  setting: ModelSetting, prompt: string, ar: string, resolution: ImageResolution, inputs: InputImage[],
): Promise<Blob> {
  void resolution
  type Part = { text: string } | { inline_data: { mime_type: string; data: string } }
  const parts: Part[] = [{ text: prompt }]
  for (const img of inputs) {
    const dataUrl = await blobToDataUrl(img.blob)
    parts.push({ inline_data: { mime_type: img.type || img.blob.type || 'image/png', data: dataUrl.split(',')[1] } })
  }
  const key = setting.apiKey ? `?key=${encodeURIComponent(setting.apiKey)}` : ''
  const res = await fetch(
    `${apiBase(setting)}/v1beta/models/${encodeURIComponent(setting.modelName)}:generateContent${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...geminiImageConfig(ar) },
      }),
    },
  )
  if (!res.ok) throw new Error(await res.text())
  type GeminiPart = {
    inlineData?: { data?: string; mimeType?: string }
    inline_data?: { data?: string; mime_type?: string }
  }
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> }
  const outParts = json.candidates?.flatMap(c => c.content?.parts ?? []) ?? []
  const imgPart = outParts.find(p => p.inlineData?.data || p.inline_data?.data)
  const data = imgPart?.inlineData?.data ?? imgPart?.inline_data?.data
  const mime = imgPart?.inlineData?.mimeType ?? imgPart?.inline_data?.mime_type ?? 'image/png'
  if (!data) throw new Error('Gemini response contained no image part')
  return dataUrlToBlob(`data:${mime};base64,${data}`)
}

async function generateOneImage(
  setting: ModelSetting, prompt: string, ar: string,
  resolution: ImageResolution, inputs: InputImage[], transparency?: boolean,
  quality?: ImageQuality, outputFormat?: ImageOutputFormat, frameCount?: number, frameDurationMs?: number,
): Promise<Blob> {
  const request = { ...setting, prompt, aspectRatio: ar, resolution, transparency, quality, outputFormat, frameCount, frameDurationMs }
  if (setting.compatibility === 'gpt-image') return generateOpenAiImage({ ...request, inputs })
  if (setting.compatibility === 'openrouter') return generateOpenRouterImage({
    ...request, imageUrls: await Promise.all(inputs.map(img => blobToDataUrl(img.blob))),
  })
  if (setting.compatibility === 'fal') return generateOneWithFal(
    setting, prompt, ar, resolution, inputs, transparency, quality, outputFormat, frameCount, frameDurationMs,
  )
  return generateOneWithGemini(setting, prompt, ar, resolution, inputs)
}

// ─── Small components ─────────────────────────────────────────────────────────

function Img({ blob, className = '' }: { blob?: Blob; className?: string }) {
  const url = useBlobUrl(blob)
  if (!url) return <div className={`bg-zinc-800 ${className}`} />
  return <img src={url} className={className} />
}

// Renders a clickable thumbnail that opens in the PhotoProvider lightbox.
// IMPORTANT: the <PhotoView> child must NOT be a <button> or any element that
// submits forms – we use a plain <div> with role=button and stop propagation.
function LightboxThumb({
  blob,
  className = '',
  onClick,
}: { blob?: Blob; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  const url = useBlobUrl(blob)
  if (!url) return null
  return (
    <PhotoView src={url}>
      <div
        role="button"
        tabIndex={0}
        className={`cursor-zoom-in ${className}`}
        onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.click()}
      >
        <img src={url} className="h-full w-full object-cover" draggable={false} />
      </div>
    </PhotoView>
  )
}

function GeneratingOverlay({ createdAt, modelName }: { createdAt: number; modelName?: string }) {
  const secs = useElapsedSeconds(createdAt, true)
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" />
      <span className="max-w-full break-all text-xs text-zinc-300" title={modelName}>{modelName ?? 'Generating'}</span>
      <span className="tabular-nums text-xs text-zinc-500">{secs}s</span>
    </div>
  )
}

// ─── Model modal ──────────────────────────────────────────────────────────────

function ModelModal({
  settings,
  initial,
  required,
  onSave,
  onClose,
}: {
  settings: ModelSetting[]
  initial?: ModelSetting
  required?: boolean
  onSave: (s: ModelSetting) => void
  onClose: () => void
}) {
  const [compatibility, setCompatibility] = useState<ApiCompatibility>(initial?.compatibility ?? 'gpt-image')
  const [name, setName] = useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey || storedApiKey(initial?.compatibility ?? 'gpt-image'))
  const [showKey, setShowKey] = useState(false)
  const [modelName, setModelName] = useState(initial?.modelName ?? 'gpt-image-2.6')
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const modelListId = useMemo(() => `model-list-${uid()}`, [])
  const [disableSafety, setDisableSafety] = useState(initial?.disableSafety ?? false)
  const falEndpoint = modelName.trim().replace(/^\/+/, '')
  const safetyUnavailable = compatibility === 'gemini' || (compatibility === 'fal' && falEndpoint.startsWith('openai/') && !falEndpoint.startsWith('openai/gpt-image-2.6/'))

  async function loadModelSuggestions() {
    setModelsLoading(true)
    setModelsError('')
    try {
      const names = await fetchModelNames({
        compatibility,
        baseUrl,
        apiKey,
      })
      setModelSuggestions(names)
    } catch (err) {
      setModelSuggestions([])
      setModelsError(err instanceof Error ? err.message : String(err))
    } finally {
      setModelsLoading(false)
    }
  }

  function handleCompatibility(next: ApiCompatibility) {
    setCompatibility(next)
    setModelSuggestions([])
    setModelsError('')
    if (!initial) {
      setApiKey(storedApiKey(next))
      const defaults: Record<ApiCompatibility, string> = {
        'gpt-image': 'gpt-image-2.6',
        'gemini': 'gemini-3.1-flash-image',
        'openrouter': 'google/gemini-3.1-flash-image-preview',
        'fal': FAL_DEFAULT_MODEL,
      }
      setModelName(defaults[next])
    }
  }


  function submit(e: FormEvent) {
    e.preventDefault()
    const stamp = now()
    rememberApiKey(compatibility, apiKey.trim())
    onSave({
      id: initial?.id ?? uid(),
      name: name.trim() || modelName,
      compatibility,
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey.trim(),
      modelName: modelName.trim(),
      disableSafety: !safetyUnavailable && disableSafety,
      createdAt: initial?.createdAt ?? stamp,
      updatedAt: stamp,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <form
        onSubmit={submit}
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
      >
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">
              {initial ? 'Edit model' : 'Add model'}
            </h2>
            <p className="mt-0.5 text-sm text-zinc-400">
              {required ? 'Add your first model to start generating.' : 'API keys are stored only in your browser.'}
            </p>
          </div>
          {!required && (
            <button type="button" onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          )}
        </div>

        <div className="grid gap-4">
          <Field label="Display name">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="My model" className={input} />
          </Field>
          <Field label="API compatibility">
            <select value={compatibility} onChange={e => handleCompatibility(e.target.value as ApiCompatibility)} className={input}>
              <option value="gpt-image">OpenAI / gpt-image-compatible</option>
              <option value="gemini">Gemini</option>
              <option value="openrouter">OpenRouter</option>
              <option value="fal">fal.ai</option>
            </select>
          </Field>
          <Field label="Base URL" hint="Optional proxy. Leave blank for default endpoint.">
            <input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={compatibility === 'gemini' ? 'https://generativelanguage.googleapis.com' : compatibility === 'openrouter' ? 'https://openrouter.ai' : compatibility === 'fal' ? FAL_BASE_URL : 'https://api.openai.com'}
              className={input}
            />
          </Field>
          <Field label="API key" hint={compatibility === 'fal' || compatibility === 'openrouter' ? 'Remembered in localStorage' : undefined}>
            <div className="relative">
              <input
                required
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                type={showKey ? 'text' : 'password'}
                className={`${input} w-full pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-zinc-500 hover:text-zinc-200"
                tabIndex={-1}
              >
                {showKey ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
          </Field>
          <Field label={compatibility === 'fal' ? 'Model endpoint ID' : 'Model name'}>
            <div className="flex gap-2">
              <input
                required
                list={modelListId}
                value={modelName}
                onChange={e => setModelName(e.target.value)}
                onFocus={() => { if (!modelSuggestions.length && !modelsLoading && (compatibility === 'fal' || apiKey.trim())) void loadModelSuggestions() }}
                className={`${input} min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={() => { void loadModelSuggestions() }}
                disabled={modelsLoading || (compatibility !== 'fal' && !apiKey.trim())}
                className="shrink-0 rounded-lg border border-zinc-700 px-2.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
              >
                {modelsLoading ? 'Loading…' : 'Load models'}
              </button>
            </div>
            <datalist id={modelListId}>
              {modelSuggestions.map(name => <option key={name} value={name} />)}
            </datalist>
            {modelsError && <span className="text-xs leading-relaxed text-red-400">{modelsError}</span>}
            {!modelsError && modelSuggestions.length > 0 && (
              <span className="text-xs text-zinc-500">{modelSuggestions.length} models available for autocomplete.</span>
            )}
          </Field>
          {compatibility === 'gpt-image' && (
            <p className="text-xs leading-relaxed text-zinc-400">
              GPT Image 2.6 models: <code className="text-zinc-300">gpt-image-2.6</code> auto-routes, while
              <code className="ml-1 text-zinc-300">gpt-image-2.6-sunburst</code> favors detail and
              <code className="ml-1 text-zinc-300">gpt-image-2.6-flare</code> favors speed.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={!safetyUnavailable && disableSafety} disabled={safetyUnavailable}
              onChange={e => setDisableSafety(e.target.checked)} className="accent-white" />
            Disable / reduce safety
          </label>
          <p className="text-xs leading-relaxed text-zinc-400">
            {safetyUnavailable
              ? 'No supported safety override for this adapter/model. Provider defaults apply.'
              : compatibility === 'gpt-image'
                ? 'Uses moderation: low for generation and edits. OpenAI does not allow disabling all safety filtering.'
                : compatibility === 'fal'
                  ? 'Sends enable_safety_checker: false. Only use with endpoints documenting this field; fal requires account authorization. Other provider restrictions still apply.'
                  : 'Checks endpoint capabilities, then uses enable_safety_checker: false or moderation: low via provider options. Unsupported models report an error; low is not fully off.'}
          </p>
          {compatibility === 'fal' && (
            <p className="text-xs leading-relaxed text-zinc-400">
              Enter the exact endpoint ID, not a URL. For GPT Image 2.6, use
              {' '}openai/gpt-image-2.6/flare/text-to-image for text-to-image or use
              openai/gpt-image-2.6/flare/edit for image inputs.
              GPT Image 2.6 Flare/Sunburst automatically use /edit with reference images
              (including GIF output), or /text-to-image without them. Other endpoint IDs
              are used unchanged. Supports prompt, image_urls,
              image_size (width/height), and images output; available sizes vary by model.
            </p>
          )}
        </div>

        <button className="mt-6 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 active:bg-zinc-200">
          Save
        </button>

        {!!settings.length && (
          <p className="mt-3 text-center text-xs text-zinc-500">
            {settings.length} model{settings.length === 1 ? '' : 's'} configured
          </p>
        )}
      </form>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm text-zinc-300">{label}{hint && <span className="ml-2 text-xs text-zinc-500">{hint}</span>}</span>
      {children}
    </label>
  )
}

const input = 'rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-zinc-400'

// ─── Models panel ─────────────────────────────────────────────────────────────

type ExportedModel = Omit<ModelSetting, 'id' | 'createdAt' | 'updatedAt'>

function exportModels(settings: ModelSetting[]) {
  const data: ExportedModel[] = settings.map(({ name, compatibility, baseUrl, apiKey, modelName, disableSafety }) => ({
    name, compatibility, ...(baseUrl ? { baseUrl } : {}), apiKey, modelName,
    ...(disableSafety !== undefined ? { disableSafety } : {}),
  }))
  const yaml = yamlDump({ models: data }, { lineWidth: -1 })
  const blob = new Blob([yaml], { type: 'text/yaml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'imagefox-models.yaml'
  a.click()
  URL.revokeObjectURL(url)
}

function importModels(file: File): Promise<ModelSetting[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = yamlLoad(String(reader.result)) as { models?: unknown[] }
        if (!parsed?.models || !Array.isArray(parsed.models))
          return reject(new Error('YAML must have a top-level "models" list'))
        const stamp = now()
        const settings: ModelSetting[] = parsed.models.map((m, i) => {
          const obj = m as Record<string, unknown>
          if (!obj.apiKey) throw new Error(`Model #${i + 1} is missing apiKey`)
          if (!obj.modelName) throw new Error(`Model #${i + 1} is missing modelName`)
          if (obj.disableSafety !== undefined && typeof obj.disableSafety !== 'boolean')
            throw new Error(`Model #${i + 1} disableSafety must be a boolean`)
          const compat = obj.compatibility as string
          if (!['gemini', 'gpt-image', 'openrouter', 'fal'].includes(compat))
            throw new Error(`Model #${i + 1} has invalid compatibility "${compat}"`)
          return {
            id: uid(),
            name: String(obj.name || obj.modelName),
            compatibility: compat as ApiCompatibility,
            baseUrl: obj.baseUrl ? String(obj.baseUrl) : undefined,
            apiKey: String(obj.apiKey),
            modelName: String(obj.modelName),
            disableSafety: obj.disableSafety as boolean | undefined,
            createdAt: stamp,
            updatedAt: stamp,
          }
        })
        resolve(settings)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function ModelsPanel({
  settings,
  onAdd,
  onEdit,
  onDuplicate,
  onRemove,
  onImport,
  onClose,
}: {
  settings: ModelSetting[]
  onAdd: () => void
  onEdit: (s: ModelSetting) => void
  onDuplicate: (s: ModelSetting) => void
  onRemove: (id: string) => void
  onImport: (imported: ModelSetting[]) => void
  onClose: () => void
}) {
  const importRef = useRef<HTMLInputElement>(null)

  async function handleImportFile(file: File) {
    try {
      const imported = await importModels(file)
      onImport(imported)
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/50 p-4 pt-16">
      <div className="w-80 rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <span className="text-sm font-semibold text-white">Models</span>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="divide-y divide-zinc-800">
          {settings.map(m => (
            <div key={m.id} className="flex items-center gap-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white">{m.name}</div>
                <div className="text-xs text-zinc-500">{m.modelName}</div>
              </div>
              <button onClick={() => onEdit(m)} className="text-xs text-zinc-400 hover:text-white">Edit</button>
              <button onClick={() => onDuplicate(m)} className="text-xs text-zinc-400 hover:text-white">Duplicate</button>
              <button onClick={() => onRemove(m.id)} className="text-xs text-zinc-400 hover:text-red-400">Remove</button>
            </div>
          ))}
          {!settings.length && <p className="px-4 py-3 text-sm text-zinc-500">No models yet.</p>}
        </div>
        <div className="flex flex-col gap-2 border-t border-zinc-800 p-3">
          <button onClick={onAdd} className="w-full rounded-lg border border-zinc-700 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white">
            + Add model
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => exportModels(settings)}
              disabled={!settings.length}
              className="flex-1 rounded-lg border border-zinc-700 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Export YAML
            </button>
            <button
              onClick={() => importRef.current?.click()}
              className="flex-1 rounded-lg border border-zinc-700 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white"
            >
              Import YAML
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".yaml,.yml,text/yaml"
              hidden
              onChange={e => { const f = e.target.files?.[0]; if (f) { void handleImportFile(f); e.target.value = '' } }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

type ModalState =
  | { kind: 'none' }
  | { kind: 'models-panel' }
  | { kind: 'add-model'; required?: boolean }
  | { kind: 'edit-model'; setting: ModelSetting }

export default function App() {
  const [state, setState] = useState<StudioDb>(defaultState)
  const [loaded, setLoaded] = useState(false)
  const [route, setRoute] = useState<{ screen: 'home' } | { screen: 'project'; id: string }>({ screen: 'home' })
  const [modal, setModal] = useState<ModalState>({ kind: 'none' })
  const [selectedModelId, setSelectedModelId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState('auto')
  const [resolution, setResolution] = useState<ImageResolution>('1K')
  const [quality, setQuality] = useState<ImageQuality>('auto')
  const [outputFormat, setOutputFormat] = useState<ImageOutputFormat>('png')
  const [frameCount, setFrameCount] = useState(9)
  const [frameDurationMs, setFrameDurationMs] = useState(200)
  const [transparency, setTransparency] = useState<boolean | undefined>(undefined)
  const [imageCount, setImageCount] = useState(1)
  const [inputImages, setInputImages] = useState<InputImage[]>([])
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounter = useRef(0)

  // Load from IDB, fix stale loading states
  useEffect(() => {
    loadState().then(stored => {
      const fixed: StudioDb = {
        ...stored,
        images: stored.images.map(img => {
          // Fix stale loading states from interrupted sessions
          const base = img.status === 'loading'
            ? { ...img, status: 'error' as const, error: 'Generation was interrupted (page reloaded).' }
            : img
          // Normalize inputImages blobs: IDB round-trip can return Blobs with empty type
          return {
            ...base,
            modelName: base.modelName ?? stored.modelSettings.find(m => m.id === base.modelSettingId)?.modelName,
            resolution: base.resolution ?? '1K',
            inputImages: (base.inputImages ?? []).map(ii => ({
              ...ii,
              type: ii.type || (ii.blob instanceof Blob ? ii.blob.type : '') || 'image/png',
              blob: ii.blob instanceof Blob ? ii.blob : new Blob([]),
            })),
          }
        }),
      }
      setState(fixed)
      setSelectedModelId(fixed.modelSettings[0]?.id ?? '')
      setLoaded(true)
      if (!fixed.modelSettings.length) setModal({ kind: 'add-model', required: true })
    })
  }, [])

  useEffect(() => {
    if (loaded) saveState(state).catch(console.error)
  }, [state, loaded])

  const project = route.screen === 'project' ? state.projects.find(p => p.id === route.id) : undefined
  const projectImages = useMemo(
    () => state.images.filter(img => img.projectId === project?.id).sort((a, b) => b.createdAt - a.createdAt),
    [state.images, project?.id],
  )
  const selectedModel = state.modelSettings.find(m => m.id === selectedModelId) ?? state.modelSettings[0]
  const canCustomizeOutput = selectedModel?.compatibility === 'gpt-image' || selectedModel?.compatibility === 'openrouter' || selectedModel?.compatibility === 'fal'
  const maxGifFrames = selectedModel?.compatibility === 'gpt-image' ? 16 : 64

  function updateState(fn: (s: StudioDb) => StudioDb) {
    setState(cur => fn(cur))
  }

  function saveModel(setting: ModelSetting) {
    updateState(s => ({
      ...s,
      modelSettings: [...s.modelSettings.filter(m => m.id !== setting.id), setting]
        .sort((a, b) => a.createdAt - b.createdAt),
    }))
    setSelectedModelId(setting.id)
    setModal({ kind: 'none' })
  }

  function duplicateModel(setting: ModelSetting) {
    const stamp = now()
    const duplicate: ModelSetting = {
      ...setting,
      id: uid(),
      name: `${setting.name} copy`,
      createdAt: stamp,
      updatedAt: stamp,
    }
    updateState(s => ({ ...s, modelSettings: [...s.modelSettings, duplicate].sort((a, b) => a.createdAt - b.createdAt) }))
    setSelectedModelId(duplicate.id)
  }

  function removeModel(id: string) {
    if (state.modelSettings.length <= 1) return alert('Keep at least one model.')
    updateState(s => ({ ...s, modelSettings: s.modelSettings.filter(m => m.id !== id) }))
    if (selectedModelId === id) setSelectedModelId(state.modelSettings.find(m => m.id !== id)?.id ?? '')
  }

  function createProject() {
    const name = window.prompt('Project name', `Project ${state.projects.length + 1}`)?.trim()
    if (!name) return
    const stamp = now()
    const p: Project = { id: uid(), name, createdAt: stamp, updatedAt: stamp }
    updateState(s => ({ ...s, projects: [p, ...s.projects] }))
    setRoute({ screen: 'project', id: p.id })
  }

  function deleteProject(id: string) {
    if (!confirm('Delete this project and all its images?')) return
    updateState(s => ({
      ...s,
      projects: s.projects.filter(p => p.id !== id),
      images: s.images.filter(img => img.projectId !== id),
    }))
  }

  const addFiles = useCallback((files: FileList | File[]) => {
    const imgs = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imgs.length && selectedModel?.compatibility === 'gpt-image') setOutputFormat(current => current === 'gif' ? 'png' : current)
    setInputImages(cur => [...cur, ...imgs.map(f => ({ id: uid(), name: f.name, type: f.type || 'image/png', blob: f as Blob }))])
  }, [selectedModel?.compatibility])

  function addGridImageAsInput(img: ImageJob) {
    if (!img.blob) return
    if (selectedModel?.compatibility === 'gpt-image') setOutputFormat(current => current === 'gif' ? 'png' : current)
    setInputImages(cur => [...cur, {
      id: uid(),
      name: `generated-${img.id}.png`,
      type: img.mimeType || img.blob!.type || 'image/png',
      blob: img.blob!,
      sourceImageId: img.id,
    }])
  }

  async function submitGeneration(
    e?: FormEvent,
    override?: {
      prompt: string
      inputImages: InputImage[]
      aspectRatio: string
      resolution?: ImageResolution
      quality?: ImageQuality
      outputFormat?: ImageOutputFormat
      frameCount?: number
      frameDurationMs?: number
      transparency?: boolean
      count?: number
    },
  ) {
    e?.preventDefault()
    if (!project || !selectedModel) return
    const reqPrompt = (override?.prompt ?? prompt).trim()
    const reqInputs = override?.inputImages ?? inputImages
    const reqAr = override?.aspectRatio ?? aspectRatio
    const reqResolution = override?.resolution ?? resolution
    const reqQuality = override?.quality ?? quality
    const requestedOutputFormat = override?.outputFormat ?? outputFormat
    const reqOutputFormat = canCustomizeOutput && !(selectedModel.compatibility === 'gpt-image' && reqInputs.length && requestedOutputFormat === 'gif')
      ? requestedOutputFormat
      : undefined
    const reqFrameCount = Math.min(maxGifFrames, override?.frameCount ?? frameCount)
    const reqFrameDurationMs = override?.frameDurationMs ?? frameDurationMs
    const reqTransparency = selectedModel.compatibility === 'gemini' || reqOutputFormat === 'gif'
      ? undefined
      : override ? override.transparency : transparency
    const count = override?.count ?? imageCount
    if (!reqPrompt) return alert('Enter a prompt first.')
    const stamp = now()
    const placeholders: ImageJob[] = Array.from({ length: count }, () => ({
      id: uid(), projectId: project.id, status: 'loading',
      createdAt: stamp, updatedAt: stamp, prompt: reqPrompt,
      modelName: selectedModel.compatibility === 'fal'
        ? falModelEndpoint(selectedModel.modelName, reqInputs.length > 0)
        : selectedModel.modelName,
      aspectRatio: reqAr,
      resolution: reqResolution,
      quality: reqQuality,
      outputFormat: reqOutputFormat,
      frameCount: reqOutputFormat === 'gif' ? reqFrameCount : undefined,
      frameDurationMs: reqOutputFormat === 'gif' ? reqFrameDurationMs : undefined,
      transparency: reqTransparency,
      modelSettingId: selectedModel.id,
      inputImages: reqInputs,
    }))
    updateState(s => ({
      ...s,
      images: [...placeholders, ...s.images],
      projects: s.projects.map(p => p.id === project.id ? { ...p, updatedAt: stamp } : p),
    }))
    // Settle each card independently: fast images shouldn't inherit the slowest
    // request's duration, and one failure must not discard successful siblings.
    await Promise.all(placeholders.map(async placeholder => {
      const started = performance.now()
      let result: Partial<ImageJob>
      try {
        const blob = await generateOneImage(
          selectedModel, reqPrompt, reqAr, reqResolution, reqInputs, reqTransparency,
          reqQuality, reqOutputFormat, reqFrameCount, reqFrameDurationMs,
        )
        result = { status: 'generated', blob, mimeType: blob.type || 'image/png' }
      } catch (err) {
        result = { status: 'error', error: err instanceof Error ? err.message : String(err) }
      }
      const durationMs = performance.now() - started
      const updatedAt = now()
      updateState(s => ({
        ...s,
        images: s.images.map(img => img.id === placeholder.id
          ? { ...img, ...result, durationMs, updatedAt }
          : img),
      }))
    }))
  }

  function redo(img: ImageJob) {
    setPrompt(img.prompt)
    setAspectRatio(img.aspectRatio)
    setResolution(img.resolution ?? '1K')
    setQuality(img.quality ?? 'auto')
    setOutputFormat(img.outputFormat ?? 'png')
    setFrameCount(img.frameCount ?? 9)
    setFrameDurationMs(img.frameDurationMs ?? 200)
    setTransparency(img.transparency)
    setInputImages(img.inputImages)
  }

  function deleteImage(id: string) {
    if (!confirm('Delete this image?')) return
    updateState(s => ({ ...s, images: s.images.filter(img => img.id !== id) }))
  }

  function downloadImage(img: ImageJob) {
    if (!img.blob) return
    const ext = (img.mimeType || img.blob.type || 'image/png').split('/')[1] ?? 'png'
    const url = URL.createObjectURL(img.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `imagefox-${img.id.slice(0, 8)}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  function continueImage(img: ImageJob) {
    if (!img.blob) return
    setInputImages([{
      id: uid(),
      name: `turn-${img.id}.png`,
      type: img.mimeType || img.blob.type || 'image/png',
      blob: img.blob,
      sourceImageId: img.id,
    }])
    setPrompt(img.prompt)
    setAspectRatio(img.aspectRatio)
    setResolution(img.resolution ?? '1K')
    setQuality(img.quality ?? 'auto')
    setOutputFormat(img.outputFormat ?? 'png')
    setFrameCount(img.frameCount ?? 9)
    setFrameDurationMs(img.frameDurationMs ?? 200)
    setTransparency(img.transparency)
  }

  // Drag-and-drop into the form
  function onFormDragEnter(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current++
    setIsDraggingOver(true)
  }
  function onFormDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDraggingOver(false) }
  }
  function onFormDrop(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current = 0
    setIsDraggingOver(false)
    const imageId = e.dataTransfer.getData('imagefox/image-id')
    if (imageId) {
      const found = state.images.find(i => i.id === imageId)
      if (found) { addGridImageAsInput(found); return }
    }
    addFiles(e.dataTransfer.files)
  }

  if (!loaded) {
    return <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400 text-sm">Loading…</div>
  }

  return (
    <PhotoProvider>
      <div className="min-h-screen bg-zinc-950 text-zinc-100">

        {/* ── Header ── */}
        <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
          <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-4 px-4">
            <button onClick={() => setRoute({ screen: 'home' })} className="text-sm font-semibold text-white hover:text-zinc-300">
              ImageFox
            </button>
            <div className="flex items-center gap-2">
              <select
                value={selectedModel?.id ?? ''}
                onChange={e => setSelectedModelId(e.target.value)}
                className="max-w-48 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-white outline-none"
              >
                {state.modelSettings.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button
                onClick={() => setModal({ kind: 'models-panel' })}
                className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white"
              >
                Models
              </button>
            </div>
          </div>
        </header>

        {/* ── Home ── */}
        {route.screen === 'home' && (
          <main className="mx-auto max-w-6xl px-4 py-8">
            <div className="mb-6 flex items-center justify-between">
              <h1 className="text-xl font-semibold">Projects</h1>
              <button
                onClick={createProject}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                New project
              </button>
            </div>
            {!state.projects.length ? (
              <div className="rounded-xl border border-dashed border-zinc-700 px-8 py-16 text-center text-sm text-zinc-500">
                No projects yet. Create one to start.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {state.projects.map(p => {
                  const cover = state.images.find(img => img.projectId === p.id && img.blob)
                  const total = state.images.filter(img => img.projectId === p.id).length
                  return (
                    <div key={p.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
                      <button
                        onClick={() => setRoute({ screen: 'project', id: p.id })}
                        className="block h-40 w-full overflow-hidden bg-zinc-800"
                      >
                        <Img blob={cover?.blob} className="h-full w-full object-cover" />
                      </button>
                      <div className="flex items-center justify-between gap-2 px-4 py-3">
                        <div>
                          <div className="text-sm font-medium text-white truncate max-w-40">{p.name}</div>
                          <div className="text-xs text-zinc-500">{total} image{total !== 1 ? 's' : ''}</div>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => setRoute({ screen: 'project', id: p.id })}
                            className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                          >
                            Open
                          </button>
                          <button
                            onClick={() => deleteProject(p.id)}
                            className="rounded-md px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </main>
        )}

        {/* ── Project ── */}
        {route.screen === 'project' && project && (
          <main className="mx-auto max-w-6xl px-4 pb-72 pt-6">
            <div className="mb-5 flex items-center gap-3">
              <button
                onClick={() => setRoute({ screen: 'home' })}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                ← Projects
              </button>
              <span className="text-zinc-700">/</span>
              <span className="text-sm font-medium text-white">{project.name}</span>
            </div>

            {!projectImages.length ? (
              <div className="rounded-xl border border-dashed border-zinc-800 px-8 py-16 text-center text-sm text-zinc-600">
                Generated images will appear here.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {projectImages.map(img => (
                  <div
                    key={img.id}
                    draggable={!!img.blob}
                    onDragStart={e => e.dataTransfer.setData('imagefox/image-id', img.id)}
                    className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
                  >
                    <div className="relative aspect-square bg-zinc-950">
                      {img.status === 'loading' && <GeneratingOverlay createdAt={img.createdAt} modelName={img.modelName} />}
                      {img.status === 'error' && (
                        <div className="absolute inset-0 overflow-auto p-3">
                          <div className="text-xs font-semibold text-red-400 mb-1">Failed</div>
                          <pre className="whitespace-pre-wrap text-[11px] text-red-300/80 leading-relaxed">{img.error}</pre>
                        </div>
                      )}
                      {img.status === 'generated' && (
                        <LightboxThumb
                          blob={img.blob}
                          className="absolute inset-0 overflow-hidden"
                        />
                      )}
                    </div>
                    <div className="p-2.5">
                      <div className="mb-1 flex items-start justify-between gap-2 text-[11px] text-zinc-400">
                        <span className="min-w-0 break-all" title={img.modelName ?? 'Model setting no longer available'}>
                          {img.modelName ?? 'Unknown model'}
                        </span>
                        {img.status !== 'loading' && (img.durationMs !== undefined || img.status === 'generated') && (
                          <span
                            className="shrink-0 tabular-nums text-zinc-500"
                            title={img.durationMs === undefined
                              ? 'Estimated from legacy timestamps; may include waiting for other images in the batch'
                              : 'Elapsed time including upload, queue wait, generation, and download'}
                          >
                            {img.durationMs === undefined ? '~' : ''}
                            {formatDuration(img.durationMs ?? Math.max(0, img.updatedAt - img.createdAt))}
                          </span>
                        )}
                      </div>
                      <p className="line-clamp-1 text-xs text-zinc-500 mb-2">{img.prompt}</p>
                      <div className="flex gap-1.5">
                        <button
                          title="Retry with same prompt and inputs"
                          onClick={() => redo(img)}
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white"
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 2.5v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M12.16 10A6 6 0 1 1 11 5l2.5-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                        {img.status === 'generated' && (
                          <>
                            <button
                              title="Use as input image"
                              onClick={() => addGridImageAsInput(img)}
                              className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white"
                            >
                              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 2v9M2 6.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                            </button>
                            <button
                              title="Download image"
                              onClick={() => downloadImage(img)}
                              className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white"
                            >
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0-3-3m3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                            </button>
                            <button
                              title="Continue editing (multi-turn)"
                              onClick={() => continueImage(img)}
                              className="flex h-7 flex-1 items-center justify-center rounded-md border border-zinc-700 text-xs text-zinc-400 hover:border-zinc-500 hover:text-white"
                            >
                              Continue
                            </button>
                          </>
                        )}
                        <button
                          title="Delete image"
                          onClick={() => deleteImage(img.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-600 hover:border-red-800 hover:bg-red-950 hover:text-red-400"
                        >
                          <svg width="11" height="11" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Input form ── */}
            <form
              onSubmit={submitGeneration}
              onDragEnter={onFormDragEnter}
              onDragLeave={onFormDragLeave}
              onDragOver={e => e.preventDefault()}
              onDrop={onFormDrop}
              className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur-lg"
            >
              <div
                className={`mx-auto max-w-2xl px-4 py-3 transition-colors ${isDraggingOver ? 'bg-zinc-800/50' : ''}`}
              >
                {isDraggingOver && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-t-xl border-2 border-dashed border-zinc-500 text-sm text-zinc-400">
                    Drop images here
                  </div>
                )}

                {/* Input image strip */}
                {inputImages.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {inputImages.map(img => (
                      <div key={img.id} className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800">
                        <LightboxThumb blob={img.blob} className="h-full w-full" />
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setInputImages(xs => xs.filter(x => x.id !== img.id)) }}
                          className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900/90 text-zinc-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-500 hover:text-white"
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Prompt + controls */}
                <div className="flex gap-2 items-start">
                  {/* Add image button */}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    title="Add input image"
                    className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" /><path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={e => e.target.files && addFiles(e.target.files)}
                  />

                  {/* Textarea */}
                  <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        void submitGeneration()
                      }
                    }}
                    placeholder="Describe the image… (⌘↵ to generate)"
                    rows={2}
                    className="min-h-9 flex-1 resize-y rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-zinc-500"
                  />

                  {/* Submit */}
                  <button
                    type="submit"
                    disabled={!selectedModel}
                    className="mt-0.5 h-9 shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Generate
                  </button>
                </div>

                {/* Bottom toolbar */}
                <div className="mt-2.5 flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-xs text-zinc-500">
                    Ratio
                    <select
                      value={aspectRatio}
                      onChange={e => setAspectRatio(e.target.value)}
                      className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none"
                    >
                      {aspectRatios.map(r => <option key={r} value={r}>{r === 'auto' ? 'Auto' : r}</option>)}
                    </select>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-zinc-500">
                    Resolution
                    <select
                      value={resolution}
                      disabled={aspectRatio === 'auto'}
                      title={aspectRatio === 'auto' ? 'Auto lets the model choose dimensions from the inputs or prompt' : undefined}
                      onChange={e => setResolution(e.target.value as ImageResolution)}
                      className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none disabled:opacity-40"
                    >
                      {imageResolutions.map(r => <option key={r}>{r}</option>)}
                    </select>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-zinc-500">
                    Quality
                    <select
                      value={quality}
                      disabled={!canCustomizeOutput}
                      title={!canCustomizeOutput ? 'Quality is not exposed by this adapter' : 'Rendering quality; Auto lets the provider choose'}
                      onChange={e => setQuality(e.target.value as ImageQuality)}
                      className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none disabled:opacity-40"
                    >
                      {imageQualities.map(q => <option key={q} value={q}>{q === 'auto' ? 'Auto' : q}</option>)}
                    </select>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-zinc-500">
                    Format
                    <select
                      value={outputFormat}
                      disabled={!canCustomizeOutput}
                      title={!canCustomizeOutput ? 'Output formats are not exposed by this adapter' : inputImages.length && selectedModel?.compatibility === 'gpt-image' ? 'The direct OpenAI edit endpoint does not support GIF output' : 'Returned file format'}
                      onChange={e => {
                        const format = e.target.value as ImageOutputFormat
                        setOutputFormat(format)
                        if (format === 'gif') setTransparency(undefined)
                      }}
                      className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none disabled:opacity-40"
                    >
                      {imageOutputFormats.map(format => (
                        <option key={format} value={format} disabled={format === 'gif' && inputImages.length > 0 && selectedModel?.compatibility === 'gpt-image'}>
                          {format.toUpperCase()}{format === 'gif' ? ' (animated)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>

                  {outputFormat === 'gif' && canCustomizeOutput && (
                    <>
                      <label className="flex items-center gap-2 text-xs text-zinc-500">
                        Frames
                        <input
                          type="number"
                          min={2}
                          max={maxGifFrames}
                          value={frameCount}
                          onChange={e => setFrameCount(Math.min(maxGifFrames, Math.max(2, Number(e.target.value) || 2)))}
                          className="w-14 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-xs text-zinc-500">
                        Frame ms
                        <input
                          type="number"
                          min={20}
                          max={2000}
                          step={10}
                          value={frameDurationMs}
                          onChange={e => setFrameDurationMs(Math.min(2000, Math.max(20, Number(e.target.value) || 20)))}
                          className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none"
                        />
                      </label>
                    </>
                  )}

                  <label className="flex items-center gap-2 text-xs text-zinc-500">
                    Transparency
                    <select
                      value={transparency === undefined ? 'unspecified' : String(transparency)}
                      disabled={selectedModel?.compatibility === 'gemini' || outputFormat === 'gif'}
                      title={selectedModel?.compatibility === 'gemini' ? 'Not supported by the direct Gemini adapter' : outputFormat === 'gif' ? 'GIF output cannot be transparent' : 'Requires model support for background; true requests PNG output'}
                      onChange={e => setTransparency(e.target.value === 'unspecified' ? undefined : e.target.value === 'true')}
                      className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none disabled:opacity-40"
                    >
                      <option value="unspecified">Unspecified</option>
                      <option value="true">True (transparent)</option>
                      <option value="false">False (opaque)</option>
                    </select>
                  </label>

                  <label className="flex flex-1 items-center gap-3 text-xs text-zinc-500">
                    <span className="shrink-0">Count: {imageCount}</span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={1}
                      value={imageCount}
                      onChange={e => setImageCount(Number(e.target.value))}
                      className="flex-1 accent-white"
                    />
                    <span className="shrink-0 text-zinc-600">10</span>
                  </label>

                  <button
                    type="button"
                    onClick={() => {
                      setPrompt('')
                      setInputImages([])
                      setAspectRatio('auto')
                      setResolution('1K')
                      setQuality('auto')
                      setOutputFormat('png')
                      setFrameCount(9)
                      setFrameDurationMs(200)
                      setTransparency(undefined)
                      setImageCount(1)
                    }}
                    className="text-xs text-zinc-600 hover:text-zinc-300"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </form>
          </main>
        )}

        {/* ── Modals ── */}
        {modal.kind === 'models-panel' && (
          <ModelsPanel
            settings={state.modelSettings}
            onAdd={() => setModal({ kind: 'add-model' })}
            onEdit={s => setModal({ kind: 'edit-model', setting: s })}
            onDuplicate={duplicateModel}
            onRemove={id => { removeModel(id) }}
            onImport={imported => {
              updateState(s => ({
                ...s,
                modelSettings: [
                  ...s.modelSettings,
                  ...imported.filter(imp => !s.modelSettings.some(m => m.modelName === imp.modelName && m.compatibility === imp.compatibility)),
                ],
              }))
              setModal({ kind: 'none' })
            }}
            onClose={() => setModal({ kind: 'none' })}
          />
        )}
        {modal.kind === 'add-model' && (
          <ModelModal
            settings={state.modelSettings}
            required={modal.required}
            onSave={saveModel}
            onClose={() => setModal({ kind: 'none' })}
          />
        )}
        {modal.kind === 'edit-model' && (
          <ModelModal
            settings={state.modelSettings}
            initial={modal.setting}
            onSave={saveModel}
            onClose={() => setModal({ kind: 'models-panel' })}
          />
        )}
      </div>
    </PhotoProvider>
  )
}
