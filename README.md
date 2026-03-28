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

- [Images exceeding 2000px are rejected by Anthropic API](https://github.com/anomalyco/opencode/issues/12068)
- [request_too_large: Request exceeds the maximum size // exceded pixels image](https://github.com/anomalyco/opencode/issues/13865)
- [413 Payload Too Large when reading local image](https://github.com/anomalyco/opencode/issues/12060)
- [Request Entity Too Large with images blocks session — compaction also fails](https://github.com/anomalyco/opencode/issues/14562)
- [Screenshots from Chrome DevTools MCP are larger than context window](https://github.com/anomalyco/opencode/issues/10306)
- [Request Entity Too Large not caught before trying to read large files](https://github.com/anomalyco/opencode/issues/8956)
- [impossible to recover from 'image exceeds 5mb' error](https://github.com/anomalyco/opencode/issues/7235)

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

Create `large-image-optimizer.json` in your OpenCode config directory to customize provider settings:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/opencode/large-image-optimizer.json` |
| Linux | `~/.config/opencode/large-image-optimizer.json` |
| Windows | `%APPDATA%/opencode/large-image-optimizer.json` |

If `XDG_CONFIG_HOME` is set, `$XDG_CONFIG_HOME/opencode/large-image-optimizer.json` is used instead.

```json
{
  "providers": {
    "anthropic": true,
    "google": true,
    "openai": false
  },
  "defaultPolicy": true
}
```

- `providers`: per-provider toggle (`true` = optimize, `false` = skip)
- `defaultPolicy`: fallback for unlisted providers (default: `true`)

Without this file, defaults apply: Anthropic/Google enabled, OpenAI disabled.

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
