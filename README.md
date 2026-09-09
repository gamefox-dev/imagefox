# ImageFox

## fal.ai compatibility

In **Models → Add model**, select **fal.ai**, enter your fal API key, and use an
exact model endpoint ID (not the model page URL):

- Image editing: `openai/gpt-image-2.5/flare/edit` (the default; requires input images).
- Text-to-image: `openai/gpt-image-2.5/flare`.
- Other endpoints with the same schema, such as `fal-ai/flux/dev`, can also be configured.

The endpoint is used as entered; adding images does not automatically append `/edit`,
and omitting images does not remove it. Configure separate models for separate endpoints.

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
- `bun run test` — mocked fal HTTP tests (requires Node.js 22.18+).

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
