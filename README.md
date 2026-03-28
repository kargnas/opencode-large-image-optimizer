# opencode-large-image-optimizer

OpenCode plugin that automatically optimizes oversized images before they hit model APIs.

It prevents common image-related failures by cropping images over 8000px and converting very large files to JPEG, reducing request payload size and context window pressure.

## Problem (Errors this plugin solves)

If you use screenshots, pasted images, or `read` attachments in OpenCode, you may hit errors like:

```
Image base64 size (8.4 MB) exceeds API limit (5.0 MB). Please resize the image before sending.
```
```
API Error: 413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}
```
```
messages.X.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels
```
```
Image was too large. Double press esc to go back and try again with a smaller image.
```
```
invalid_request_error: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels
```

These errors kill your active session with no way to recover — you're forced to start a new conversation and lose all context.

This plugin prevents these failures automatically by optimizing images before they reach the API.

### Related Issues

- [Oversized image breaks conversation permanently - no way to recover](https://github.com/anthropics/claude-code/issues/13480)
- [Image base64 size (8.4 MB) exceeds API limit (5.0 MB)](https://github.com/anthropics/claude-code/issues/20021)
- [Image base64 size error persists](https://github.com/anthropics/claude-code/issues/19701)
- [API Error 413: request_too_large kills the active session](https://github.com/anthropics/claude-code/issues/8092)
- [Image Upload Exceeds Size Limit Causing Persistent API Request Failure](https://github.com/anthropics/claude-code/issues/2939)
- [Read tool loops indefinitely on large Playwright screenshots](https://github.com/anthropics/claude-code/issues/27611)
- [Anthropic API Error: Image Upload Size Blocking All Message Attempts](https://github.com/anthropics/claude-code/issues/8039)

## Installation

Add `"opencode-large-image-optimizer"` to your plugin array in `opencode.json`:

```json
{
  "plugin": [
    "opencode-large-image-optimizer@latest"
  ]
}
```

## Configuration

The plugin includes a provider policy map in `src/plugin.ts`:

```ts
const PROVIDER_ENABLED: Record<string, boolean> = {
  anthropic: true,
  google: true,
  openai: false,
}
const DEFAULT_POLICY = true
```

Meaning:

- `anthropic`: optimization enabled
- `google`: optimization enabled
- `openai`: optimization disabled
- unknown provider: follows `DEFAULT_POLICY` (`true`)

## How it works

The optimizer applies the following 4 rules (in order):

1. **Normal dimensions** → pass through unchanged.
2. **Normal width + height > 8000px** → crop height from top to `8000px`.
3. **Width > 8000px** → crop width from horizontal center to `8000px`.
4. **File size > 5MB** → convert to JPEG (`quality=100`) and progressively reduce quality (`95`, `90`, `80`, `70`) if still above size limit.

Supported MIME types:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/gif`
- `image/webp`

## Scope

Optimization is applied to:

- `read` tool image attachments
- screenshot tool outputs carrying base64 image payloads
- chat message `file` parts via `experimental.chat.messages.transform`

## Notes

- This package expects `sharp` to be available as a peer dependency.
- Build output is generated into `dist/`.

## License

MIT
