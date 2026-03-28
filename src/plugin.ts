import type { Plugin } from '@opencode-ai/plugin'

/**
 * Image Optimizer Plugin
 *
 * Rules (applied in order):
 * 1. Normal dimensions → pass through
 * 2. Normal width + height > 8000px → crop from top to 8000px
 * 3. Width > 8000px → crop from horizontal center to 8000px
 * 4. File size > 5MB → convert to JPEG (quality=100, progressive reduction if still over)
 */

const MAX_DIMENSION = 8000
const MAX_FILE_SIZE = 5 * 1024 * 1024
const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])

const DEFAULT_PROVIDER_ENABLED: Record<string, boolean> = {
  anthropic: true,
  google: true,
  openai: false,
}
const DEFAULT_POLICY = true
const CONFIG_PATH = '~/.config/opencode/image-optimizer.json'

interface PluginConfig {
  providers?: Record<string, boolean>
  defaultPolicy?: boolean
}

let userConfig: PluginConfig | null = null

function resolveHome(p: string): string {
  if (p.startsWith('~/')) return require('node:path').join(require('node:os').homedir(), p.slice(2))
  return p
}

function loadConfig(): PluginConfig {
  if (userConfig) return userConfig
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const raw = fs.readFileSync(resolveHome(CONFIG_PATH), 'utf-8')
    userConfig = JSON.parse(raw) as PluginConfig
    log('config loaded', userConfig)
  } catch {
    userConfig = {}
  }
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
async function getSharp(): Promise<((input?: Buffer) => any) | null> {
  if (_sharpFactory) return _sharpFactory
  try {
    const mod = await import('sharp')
    const fn = typeof mod === 'function' ? mod : (mod as any).default
    if (typeof fn === 'function') { _sharpFactory = fn; return fn }
  } catch {}
  return null
}

function log(msg: string, data?: any) {
  const fs = require('node:fs') as typeof import('node:fs')
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

// PNG: width at byte 16, height at byte 20 (4 bytes big-endian each)
function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// JPEG: scan for SOF0-SOF3 markers (0xFFC0-0xFFC3) which contain dimensions
function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let offset = 2
  while (offset < buf.length - 8) {
    if (buf[offset] !== 0xff) break
    const marker = buf[offset + 1]
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) }
    }
    offset += 2 + buf.readUInt16BE(offset + 2)
  }
  return null
}

// GIF: width/height at bytes 6-9 (little-endian 16-bit each)
function parseGifDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10 || buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

// WebP: VP8 lossy dims at bytes 26-29, VP8L lossless encoded at byte 21
function parseWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const fmt = buf.toString('ascii', 12, 16)
  if (fmt === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (fmt === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
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
  const actions: string[] = []
  let pipeline = sharp(inputBuffer)
  let currentWidth = origWidth
  let currentHeight = origHeight
  let outputMime = mime

  // Rule 2: height > 8000 with normal width → crop from top
  if (currentHeight > MAX_DIMENSION && currentWidth <= MAX_DIMENSION) {
    pipeline = pipeline.extract({ left: 0, top: 0, width: currentWidth, height: MAX_DIMENSION })
    actions.push(`height crop: ${currentHeight}px → ${MAX_DIMENSION}px (top)`)
    currentHeight = MAX_DIMENSION
  }

  // Rule 3: width > 8000 → crop from horizontal center
  if (currentWidth > MAX_DIMENSION) {
    const leftOffset = Math.floor((currentWidth - MAX_DIMENSION) / 2)
    pipeline = pipeline.extract({ left: leftOffset, top: 0, width: MAX_DIMENSION, height: currentHeight })
    actions.push(`width crop: ${currentWidth}px → ${MAX_DIMENSION}px (center, offset=${leftOffset})`)
    currentWidth = MAX_DIMENSION
  }

  // Edge case: both dimensions exceeded, height still over after width crop
  if (currentHeight > MAX_DIMENSION) {
    pipeline = pipeline.extract({ left: 0, top: 0, width: currentWidth, height: MAX_DIMENSION })
    actions.push(`height crop: ${currentHeight}px → ${MAX_DIMENSION}px (top, post-width-crop)`)
    currentHeight = MAX_DIMENSION
  }

  let outputBuffer = await pipeline.toBuffer()

  // Rule 4: > 5MB → JPEG max quality, progressive reduction if needed
  if (outputBuffer.length > MAX_FILE_SIZE) {
    outputBuffer = await sharp(outputBuffer).jpeg({ quality: 100, mozjpeg: true }).toBuffer()
    outputMime = 'image/jpeg'
    actions.push(`jpeg convert: ${formatBytes(origBytes)} → ${formatBytes(outputBuffer.length)}`)

    if (outputBuffer.length > MAX_FILE_SIZE) {
      for (const q of [95, 90, 80, 70]) {
        outputBuffer = await sharp(outputBuffer).jpeg({ quality: q, mozjpeg: true }).toBuffer()
        actions.push(`jpeg q=${q}: ${formatBytes(outputBuffer.length)}`)
        if (outputBuffer.length <= MAX_FILE_SIZE) break
      }
    }
  }

  if (actions.length === 0) return null

  const finalMeta = await sharp(outputBuffer).metadata()
  return {
    dataUrl: buildDataUrl(outputMime, outputBuffer.toString('base64')),
    mime: outputMime,
    original: { width: origWidth, height: origHeight, bytes: origBytes },
    final: { width: finalMeta.width || currentWidth, height: finalMeta.height || currentHeight, bytes: outputBuffer.length },
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
