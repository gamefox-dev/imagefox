# ImageFox

## Model setup and autocomplete

Model API keys are stored in IndexedDB with the rest of the local model settings. fal.ai and OpenRouter keys are additionally remembered in browser `localStorage`, so the API key field is prefilled when creating another model of the same type. API keys never leave the browser except in requests to the configured provider.

The model name field has a **Load models** autocomplete. It queries the provider's model catalog endpoint: OpenAI `GET /v1/models`, Gemini `GET /v1beta/models`, OpenRouter `GET /api/v1/models`, or fal `GET https://api.fal.ai/v1/models`. OpenAI, Gemini, and OpenRouter require their API key; fal's catalog is public but the key is sent when available.

## GPT Image 2.6 output options

The default OpenAI model is `gpt-image-2.6`, which uses automatic routing. You can also configure `gpt-image-2.6-sunburst` for detailed work or `gpt-image-2.6-flare` for faster iteration. OpenRouter model IDs use the `openai/` prefix.

The generation toolbar exposes the documented GPT Image 2.6 quality tiers: `auto`, `low`, `medium`, `high`, `xhigh`, and `max`. It also supports PNG, JPEG, WebP, and animated GIF output. GIF generation adds controls for 2–16 frames and 20–2000 ms frame duration on the OpenAI Images API (the API rounds frame duration to 10 ms); OpenRouter and fal support GIFs with image references where their model endpoint supports it. GIF output uses the documented default of 9 frames and 200 ms when unchanged.

Quality and format controls are sent to OpenAI, OpenRouter, and fal GPT Image-compatible endpoints. Provider adapters that do not document these fields leave them disabled. Direct OpenAI image edits cannot return GIFs because the OpenAI Image edit endpoint does not support animated GIF output; OpenRouter and fal image-reference requests use their image API capabilities.

## Transparency and safety options

The generation toolbar has a **Transparency** selector:

- **Unspecified** (default): omit the background parameter and use provider defaults.
- **True (transparent)**: send `background: "transparent"` and `output_format: "png"`.
- **False (opaque)**: send `background: "opaque"`.

This applies to both generation and editing with OpenAI, OpenRouter, and compatible
fal endpoints. The selected model must support `background`; this is not automatic
background removal. The direct Gemini adapter does not expose this option. Each job
stores its transparency choice; redo/continue restore it, and Clear resets it to
Unspecified. Existing jobs without the field remain Unspecified.

In **Models → Add/Edit model**, **Disable / reduce safety** defaults to unchecked
(provider defaults). Its meaning depends on the provider:

| Provider | Behavior when checked |
| --- | --- |
| OpenAI | Sends `moderation: "low"` for both generation and edits. This reduces filtering; OpenAI does not offer a full safety-off switch. |
| fal.ai | Sends `enable_safety_checker: false`. Only use for endpoints documenting this parameter (e.g. FLUX.1 dev). Disabling the checker requires fal account authorization; otherwise checks still run. Other upstream restrictions still apply. |
| OpenRouter | Fetches the model's Images endpoint capabilities and sends `moderation: "low"` and/or `enable_safety_checker: false` under `provider.options[provider_slug]`, only when advertised in `allowed_passthrough_parameters`. Routing is limited to eligible providers. Unsupported models or failed capability lookups produce an error before generation rather than silently ignoring the option. |

fal's GPT Image 2.6 schema exposes transparency, quality, GIF output, and an
optional safety-checker override (subject to fal authorization). Older fal OpenAI
endpoints may not support the safety override, so the checkbox remains disabled for them. It is also disabled for the
direct Gemini adapter. OpenRouter's OpenAI GPT Image endpoints currently advertise
`moderation`; its Gemini image endpoint does not advertise a supported safety
control. Safety preferences persist with model settings and round-trip through YAML
as the optional boolean `disableSafety` (string values are rejected).

Provider references:
- [OpenAI image generation and moderation](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI image edits](https://developers.openai.com/api/reference/resources/images/methods/edit/)
- [fal GPT Image 2.6 Flare generation schema](https://fal.ai/models/openai/gpt-image-2.6/flare/text-to-image/api)
- [fal GPT Image 2.6 Flare edit schema](https://fal.ai/models/openai/gpt-image-2.6/flare/edit/api)
- [fal FLUX.1 dev safety checker](https://fal.ai/models/fal-ai/flux/dev/api)
- [OpenRouter Images API and capability discovery](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)

## OpenRouter Images API

All OpenRouter generation requests now use **`POST /api/v1/images`**, including
GPT Image 2.6 Flare/Sunburst and Gemini image models, rather than chat completions.
Reference images are passed as data URLs in `input_references`; output is decoded
from `data[0].b64_json`, preserving `media_type` (PNG when omitted). Hosted image
URLs are also supported and downloaded without API credentials.

Explicit sizes use the Images API's top-level `aspect_ratio` and `resolution`
parameters (`0.5K` in the UI maps to `512`). Auto omits sizing overrides. There are
no automatic generation retries or chat fallbacks. Custom proxies must support
`/api/v1/images` and, when safety reduction is requested, the image-model endpoint
capability API under `/api/v1/images/models/{model}/endpoints`.

## fal.ai compatibility

In **Models → Add model**, select **fal.ai**, enter your fal API key, and use an
exact model endpoint ID (not the model page URL):

- Image editing: `openai/gpt-image-2.6/flare/edit` (the default; auto-selects text-to-image without inputs).
- Text-to-image: `openai/gpt-image-2.6/flare/text-to-image`.
- Other endpoints with the same schema, such as `fal-ai/flux/dev`, can also be configured.

For GPT Image 2.6 Flare/Sunburst, ImageFox selects `/edit` whenever reference images
are attached, including GIF requests, and `/text-to-image` when there are no inputs.
You can configure the family ID or either endpoint; routing preserves the variant.
Sending references to a text-to-image endpoint is not equivalent to editing and can
ignore the references or return a still image instead of the intended animation.
Other fal model families keep the exact endpoint as entered; their edit paths vary.

Requests run directly in the browser using `fetch` and `Authorization: Key …`.
The default base URL is `https://queue.fal.run`; an optional queue-compatible proxy
can be supplied. ImageFox submits the job, polls its returned status URL, and downloads
`images[0].url` after completion. Input images are sent as base64 data URIs in
`image_urls` (omitted for text-only requests). Each requested image is a separate job
with `num_images: 1`.

The Ratio control includes **Auto**. In Auto mode, fal.ai and OpenAI receive their
literal `auto` size, while Gemini and OpenRouter omit explicit size overrides so the
provider can use its native input-aware/default sizing. For explicit ratios,
resolution is mapped to `image_size: { width, height }` using the existing GPT Image
size constraints (including increasing undersized requests and capping 4K).
This compatibility targets endpoints accepting `prompt`, optional `image_urls`,
`image_size`, and `num_images`, and returning `images[].url`. fal schemas are not
identical: endpoints requiring `image_url`, `aspect_ratio`, `resolution`, masks, or
other model-specific inputs are not covered by this adapter. Model validation errors
are displayed in the image card. After 10 minutes ImageFox stops waiting; the server
job may still run, so check fal history before retrying.

YAML model import/export uses `compatibility: fal`. Keys are stored locally with the
other model settings and are included in YAML exports.

## Automatic sizing and generation metadata

**Auto** is the default ratio and lets the model choose dimensions from the input
images or prompt. The resolution selector is disabled in this mode, since a fixed
resolution would override automatic sizing. Exact input pixel preservation depends
on the model; Auto is not an application-side resize operation. Explicit ratios
remain available, and redo/continue preserve the original job's ratio setting.

Cards show the actual model ID during generation and after completion. New jobs
snapshot that ID so editing or deleting a model setting does not change their
history. Each image records its own elapsed duration, including input conversion,
queue wait, inference, and download. Batch images finish independently, so one
failure does not discard other successful results. Legacy images use the remaining
model setting when available and show a `~`-prefixed estimated time from timestamps.

## Development

- `bun run dev` — start the development server.
- `bun run build` — type-check and build.
- `bun run lint` — lint the codebase.
- `bun run test` — provider HTTP and image-option tests (requires Node.js 22.18+).

## Vite template notes

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
