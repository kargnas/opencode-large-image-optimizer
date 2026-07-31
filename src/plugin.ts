import type { Plugin } from '@opencode-ai/plugin'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Image Optimizer Plugin
 *
 * Rules (applied in order):
 * 1. Both dimensions ≤ MAX_EDGE and raw size ≤ MAX_RAW_BYTES → pass through
 * 2. Any dimension > MAX_EDGE → resample (fit inside MAX_EDGE box, preserving aspect ratio)
 * 3. Raw size > MAX_RAW_BYTES after resample → convert to JPEG with progressive quality reduction
 *
 * Why resample instead of crop:
 *   Crop discards parts of the image the model might need to see (e.g. bottom of a screenshot).
 *   Anthropic already downscales to 1568px long edge internally, so resample to 1568 loses no
 *   information that the model would have used anyway.
 *
 * Why 3,932,160 bytes instead of 5MB:
 *   The API limit is 5MB measured in base64. base64 inflates by 4/3, so the raw byte budget is
 *   floor(5 * 1024 * 1024 * 3 / 4) = 3,932,160. The old 5MB raw threshold had a 1.25MB blind
 *   spot where files passed the plugin but were rejected by the API.
 */

// Anthropic downscales to 1568px long edge internally — resample to this loses zero model info
const MAX_EDGE = 1568
// API limit is 5MB base64 → raw budget = floor(5*1024*1024 * 3/4)
const MAX_RAW_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4) // 3,932,160
const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])

const DEFAULT_PROVIDER_ENABLED: Record<string, boolean> = {
  anthropic: true,
  google: true,
  openai: false,
}
const DEFAULT_POLICY = true
const CONFIG_FILENAME = 'large-image-optimizer.json'

interface PluginConfig {
  providers?: Record<string, boolean>
  defaultPolicy?: boolean
}

let userConfig: PluginConfig | null = null

function getConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'opencode')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode')
  return path.join(os.homedir(), '.config', 'opencode')
}

function loadConfig(): PluginConfig {
  if (userConfig) return userConfig
  const candidates = [
    path.join(getConfigDir(), CONFIG_FILENAME),
    path.join(os.homedir(), '.config', 'opencode', CONFIG_FILENAME),
  ]
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf-8')
      userConfig = JSON.parse(raw) as PluginConfig
      log('config loaded', { path: p, ...userConfig })
      return userConfig
    } catch {}
  }
  userConfig = {}
  return userConfig
}

const sessionProviders = new Map<string, string>()

function shouldOptimize(sessionID: string): boolean {
  const config = loadConfig()
  const providers = { ...DEFAULT_PROVIDER_ENABLED, ...config.providers }
  const fallback = config.defaultPolicy ?? DEFAULT_POLICY
  const provider = sessionProviders.get(sessionID)
  if (!provider) return fallback
  return providers[provider] ?? fallback
}

let _sharpFactory: ((input?: Buffer) => any) | null = null
let _sharpWarned = false
async function getSharp(): Promise<((input?: Buffer) => any) | null> {
  if (_sharpFactory) return _sharpFactory
  try {
    const mod = await import('sharp')
    const fn = typeof mod === 'function' ? mod : (mod as any).default
    if (typeof fn === 'function') { _sharpFactory = fn; return fn }
  } catch (err) {
    if (!_sharpWarned) {
      _sharpWarned = true
      // eslint-disable-next-line no-console
      console.error('[image-optimizer] sharp not installed — plugin disabled. Install with: npm i -g sharp')
      log('sharp import failed', { error: err instanceof Error ? err.message : String(err) })
    }
    return null
  }
  if (!_sharpWarned) {
    _sharpWarned = true
    // eslint-disable-next-line no-console
    console.error('[image-optimizer] sharp resolved but did not export a function — plugin disabled.')
    log('sharp shape unexpected')
  }
  return null
}

function log(msg: string, data?: any) {
  const line = `[${new Date().toISOString()}] [image-optimizer] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`
  try { fs.appendFileSync('/tmp/opencode-image-optimizer.log', line) } catch {}
}

function extractBase64Data(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/s)
  if (match) return match[1]
  if (/^[A-Za-z0-9+/]/.test(dataUrl) && !dataUrl.startsWith('http')) return dataUrl
  return null
}

function buildDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`
}

interface OptimizeResult {
  dataUrl: string
  mime: string
  original: { width: number; height: number; bytes: number }
  final: { width: number; height: number; bytes: number }
  actions: string[]
}

async function optimizeImage(dataUrl: string, mime: string): Promise<OptimizeResult | null> {
  const sharp = await getSharp()
  if (!sharp) { log('sharp unavailable'); return null }

  const rawBase64 = extractBase64Data(dataUrl)
  if (!rawBase64) return null

  const inputBuffer = Buffer.from(rawBase64, 'base64')
  if (inputBuffer.length === 0) return null

  const metadata = await sharp(inputBuffer).metadata()
  const origWidth = metadata.width || 0
  const origHeight = metadata.height || 0
  if (origWidth === 0 || origHeight === 0) return null

  const origBytes = inputBuffer.length
  const maxDim = Math.max(origWidth, origHeight)

  // Pass through if already within both dimension and size budgets.
  // Small animated GIFs land here, so their animation survives untouched.
  if (maxDim <= MAX_EDGE && origBytes <= MAX_RAW_BYTES) return null

  const actions: string[] = []
  let outputMime = mime

  // An oversized animated image loses every frame but the first, because sharp is
  // deliberately opened WITHOUT { animated: true }. Do not "fix" that by enabling it:
  // measured on a 9.59MB / 6-frame / 2400x1600 GIF, keeping the frames produced 5.62MB
  // (still over the 3.93MB budget, so the API rejects it anyway) and took 11.2s, versus
  // 934KB and 2.0s when flattened. Anthropic only analyzes the first frame of a GIF, so
  // those extra frames cost payload and latency and buy the model nothing.
  // The flattening is recorded below so it never happens silently.
  const pages = metadata.pages || 1
  if (pages > 1) {
    actions.push(`animation flattened: ${pages} frames → 1 (API reads the first frame only)`)
  }

  // Step 1: Resample if any dimension exceeds target (fit inside MAX_EDGE box)
  let pipeline = sharp(inputBuffer)
  if (maxDim > MAX_EDGE) {
    pipeline = pipeline.resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    actions.push(`resample: ${origWidth}x${origHeight} → fit ${MAX_EDGE}px (aspect preserved)`)
  }

  let outputBuffer = await pipeline.toBuffer()

  // Step 2: If still over raw budget, convert to JPEG with progressive quality reduction
  if (outputBuffer.length > MAX_RAW_BYTES) {
    for (const q of [90, 80, 70, 60]) {
      outputBuffer = await sharp(outputBuffer).jpeg({ quality: q, mozjpeg: true }).toBuffer()
      outputMime = 'image/jpeg'
      actions.push(`jpeg q=${q}: ${formatBytes(outputBuffer.length)}`)
      if (outputBuffer.length <= MAX_RAW_BYTES) break
    }
  }

  if (actions.length === 0) return null

  const finalMeta = await sharp(outputBuffer).metadata()
  return {
    dataUrl: buildDataUrl(outputMime, outputBuffer.toString('base64')),
    mime: outputMime,
    original: { width: origWidth, height: origHeight, bytes: origBytes },
    final: { width: finalMeta.width || 0, height: finalMeta.height || 0, bytes: outputBuffer.length },
    actions,
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

function formatOptimizeInfo(results: Array<{ filename: string; result: OptimizeResult }>): string {
  if (results.length === 0) return ''
  const lines = ['\n\n[Image Optimizer]']
  for (const { filename, result } of results) {
    const orig = `${result.original.width}x${result.original.height} (${formatBytes(result.original.bytes)})`
    const final = `${result.final.width}x${result.final.height} (${formatBytes(result.final.bytes)})`
    lines.push(`- ${filename}: ${orig} → ${final}`)
    for (const a of result.actions) lines.push(`  ↳ ${a}`)
  }
  return lines.join('\n')
}

export const plugin: Plugin = async ({ directory }) => {
  log('loaded', { directory })

  return {
    'chat.message': async (input: any) => {
      if (input.model?.providerID && input.sessionID) {
        sessionProviders.set(input.sessionID, input.model.providerID)
      }
    },

    'tool.execute.after': async (input: any, output: any) => {
      if (!shouldOptimize(input.sessionID)) return

      const tool = (input.tool as string || '').toLowerCase()

      if (tool === 'read') {
        const attachments = output.attachments
        if (!Array.isArray(attachments) || attachments.length === 0) return

        const results: Array<{ filename: string; result: OptimizeResult }> = []
        for (const [i, att] of attachments.entries()) {
          if (!att?.mime || !att?.url || !SUPPORTED_MIMES.has(att.mime.toLowerCase())) continue
          const filename = att.filename || `image-${i + 1}`
          try {
            const result = await optimizeImage(att.url, att.mime)
            if (result) {
              att.url = result.dataUrl
              att.mime = result.mime
              results.push({ filename, result })
              log('optimized', { filename, from: `${result.original.width}x${result.original.height}`, to: `${result.final.width}x${result.final.height}`, actions: result.actions })
            }
          } catch (err) {
            log('failed', { filename, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (results.length > 0 && typeof output.output === 'string') {
          output.output += formatOptimizeInfo(results)
        }
      }

      if (tool.includes('screenshot')) {
        const metadata = output.metadata as any
        if (!metadata?.base64 || typeof metadata.base64 !== 'string') return
        try {
          const result = await optimizeImage(buildDataUrl('image/png', metadata.base64), 'image/png')
          if (result) {
            const raw = extractBase64Data(result.dataUrl)
            if (raw) {
              metadata.base64 = raw
              if (typeof output.output === 'string') {
                output.output += `\n[Image Optimizer] ${result.original.width}x${result.original.height} → ${result.final.width}x${result.final.height} (${formatBytes(result.original.bytes)} → ${formatBytes(result.final.bytes)})`
              }
              log('screenshot optimized', { actions: result.actions })
            }
          }
        } catch (err) {
          log('screenshot failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }
    },

    'experimental.chat.messages.transform': async (_input: any, output: any) => {
      if (!output.messages || !Array.isArray(output.messages)) return
      for (const msg of output.messages) {
        if (!msg.parts || !Array.isArray(msg.parts)) continue
        for (const part of msg.parts) {
          if (part.type !== 'file' || !SUPPORTED_MIMES.has((part.mime || '').toLowerCase()) || typeof part.url !== 'string') continue
          try {
            const result = await optimizeImage(part.url, part.mime)
            if (result) {
              part.url = result.dataUrl
              part.mime = result.mime
              log('clipboard optimized', { from: `${result.original.width}x${result.original.height}`, to: `${result.final.width}x${result.final.height}`, actions: result.actions })
            }
          } catch (err) {
            log('clipboard failed', { error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    },
  }
}
