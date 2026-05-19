import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { PhotoProvider, PhotoView } from 'react-photo-view'
import 'react-photo-view/dist/react-photo-view.css'

// ─── Types ────────────────────────────────────────────────────────────────────

type ApiCompatibility = 'gemini' | 'gpt-image'

type ModelSetting = {
  id: string
  name: string
  compatibility: ApiCompatibility
  baseUrl?: string
  apiKey: string
  modelName: string
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
  aspectRatio: string
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
const aspectRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

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

async function urlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not download generated image (${res.status})`)
  return res.blob()
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
  const fallback = setting.compatibility === 'gemini'
    ? 'https://generativelanguage.googleapis.com'
    : 'https://api.openai.com'
  return (setting.baseUrl || fallback).replace(/\/$/, '')
}

function openAiSize(ar: string) {
  if (['16:9', '3:2', '4:3'].includes(ar)) return '1536x1024'
  if (['9:16', '2:3', '3:4'].includes(ar)) return '1024x1536'
  return '1024x1024'
}

async function generateWithOpenAi(
  setting: ModelSetting, prompt: string, ar: string,
  inputs: InputImage[], count: number,
): Promise<Blob[]> {
  const headers = { Authorization: `Bearer ${setting.apiKey}` }
  let res: Response
  if (inputs.length) {
    const form = new FormData()
    form.append('model', setting.modelName)
    form.append('prompt', prompt)
    form.append('n', String(count))
    form.append('size', openAiSize(ar))
    inputs.forEach((img, i) => {
      form.append('image[]', new File([img.blob], img.name || `input-${i}.png`, { type: img.type || img.blob.type || 'image/png' }))
    })
    res = await fetch(`${apiBase(setting)}/v1/images/edits`, { method: 'POST', headers, body: form })
  } else {
    res = await fetch(`${apiBase(setting)}/v1/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: setting.modelName, prompt, n: count, size: openAiSize(ar) }),
    })
  }
  if (!res.ok) throw new Error(await res.text())
  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
  return Promise.all((json.data ?? []).map(async (item) => {
    if (item.b64_json) return dataUrlToBlob(`data:image/png;base64,${item.b64_json}`)
    if (item.url) return urlToBlob(item.url)
    throw new Error('Response had no b64_json or url')
  }))
}

async function generateOneWithGemini(
  setting: ModelSetting, prompt: string, ar: string, inputs: InputImage[],
): Promise<Blob> {
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
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ar } },
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

async function generateImages(
  setting: ModelSetting, prompt: string, ar: string,
  inputs: InputImage[], count: number,
): Promise<Blob[]> {
  if (setting.compatibility === 'gpt-image') return generateWithOpenAi(setting, prompt, ar, inputs, count)
  return Promise.all(Array.from({ length: count }, () => generateOneWithGemini(setting, prompt, ar, inputs)))
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

function GeneratingOverlay({ createdAt }: { createdAt: number }) {
  const secs = useElapsedSeconds(createdAt, true)
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" />
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
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [showKey, setShowKey] = useState(false)
  const [modelName, setModelName] = useState(initial?.modelName ?? 'gpt-image-2')

  function handleCompatibility(next: ApiCompatibility) {
    setCompatibility(next)
    if (!initial) setModelName(next === 'gemini' ? 'gemini-3.1-flash-image' : 'gpt-image-2')
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const stamp = now()
    onSave({
      id: initial?.id ?? uid(),
      name: name.trim() || modelName,
      compatibility,
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey.trim(),
      modelName: modelName.trim(),
      createdAt: initial?.createdAt ?? stamp,
      updatedAt: stamp,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
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
            </select>
          </Field>
          <Field label="Base URL" hint="Optional proxy. Leave blank for default endpoint.">
            <input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={compatibility === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com'}
              className={input}
            />
          </Field>
          <Field label="API key">
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
          <Field label="Model name">
            <input required value={modelName} onChange={e => setModelName(e.target.value)} className={input} />
          </Field>
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

function ModelsPanel({
  settings,
  onAdd,
  onEdit,
  onRemove,
  onClose,
}: {
  settings: ModelSetting[]
  onAdd: () => void
  onEdit: (s: ModelSetting) => void
  onRemove: (id: string) => void
  onClose: () => void
}) {
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
              <button onClick={() => onRemove(m.id)} className="text-xs text-zinc-400 hover:text-red-400">Remove</button>
            </div>
          ))}
          {!settings.length && <p className="px-4 py-3 text-sm text-zinc-500">No models yet.</p>}
        </div>
        <div className="border-t border-zinc-800 p-3">
          <button onClick={onAdd} className="w-full rounded-lg border border-zinc-700 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white">
            + Add model
          </button>
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
  const [aspectRatio, setAspectRatio] = useState('1:1')
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
    setInputImages(cur => [...cur, ...imgs.map(f => ({ id: uid(), name: f.name, type: f.type || 'image/png', blob: f as Blob }))])
  }, [])

  function addGridImageAsInput(img: ImageJob) {
    if (!img.blob) return
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
    override?: { prompt: string; inputImages: InputImage[]; aspectRatio: string; count?: number },
  ) {
    e?.preventDefault()
    if (!project || !selectedModel) return
    const reqPrompt = (override?.prompt ?? prompt).trim()
    const reqInputs = override?.inputImages ?? inputImages
    const reqAr = override?.aspectRatio ?? aspectRatio
    const count = override?.count ?? imageCount
    if (!reqPrompt) return alert('Enter a prompt first.')
    const stamp = now()
    const placeholders: ImageJob[] = Array.from({ length: count }, () => ({
      id: uid(), projectId: project.id, status: 'loading',
      createdAt: stamp, updatedAt: stamp, prompt: reqPrompt,
      aspectRatio: reqAr, modelSettingId: selectedModel.id, inputImages: reqInputs,
    }))
    updateState(s => ({
      ...s,
      images: [...placeholders, ...s.images],
      projects: s.projects.map(p => p.id === project.id ? { ...p, updatedAt: stamp } : p),
    }))
    try {
      const blobs = await generateImages(selectedModel, reqPrompt, reqAr, reqInputs, count)
      updateState(s => ({
        ...s,
        images: s.images.map(img => {
          const idx = placeholders.findIndex(p => p.id === img.id)
          if (idx === -1) return img
          const blob = blobs[idx]
          if (!blob) return { ...img, status: 'error', error: `No image returned for slot ${idx + 1}.`, updatedAt: now() }
          return { ...img, status: 'generated', blob, mimeType: blob.type || 'image/png', updatedAt: now() }
        }),
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      updateState(s => ({
        ...s,
        images: s.images.map(img =>
          placeholders.some(p => p.id === img.id)
            ? { ...img, status: 'error', error: msg, updatedAt: now() }
            : img,
        ),
      }))
    }
  }

  function redo(img: ImageJob) {
    setPrompt(img.prompt)
    setAspectRatio(img.aspectRatio)
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
                      {img.status === 'loading' && <GeneratingOverlay createdAt={img.createdAt} />}
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
                      {aspectRatios.map(r => <option key={r}>{r}</option>)}
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
                    onClick={() => { setPrompt(''); setInputImages([]); setAspectRatio('1:1'); setImageCount(1) }}
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
            onRemove={id => { removeModel(id) }}
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
