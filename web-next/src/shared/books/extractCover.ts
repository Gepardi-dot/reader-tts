/**
 * Pull an embedded cover out of EPUB / FB2 packages, and shrink cover
 * images so they can be stored on the book record and shown under COEP.
 */

import type JSZip from 'jszip'

export const COVER_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
}

const COVER_IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)$/i

export function mimeFromCoverName(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return COVER_MIME_BY_EXT[ext] ?? 'image/jpeg'
}

function decodeOpfPath(opfDir: string, href: string) {
  return decodeURIComponent(`${opfDir}${href}`).replace(/\\/g, '/').replace(/^\.\//, '')
}

export function findEpubCoverHref(opfXml: string): string | null {
  const items = [...opfXml.matchAll(/<item\b[^>]*>/gi)].map((match) => match[0])

  const coverImageItem = items.find((tag) => /properties=["'][^"']*\bcover-image\b/i.test(tag))
  const fromProperties = coverImageItem?.match(/\bhref=["']([^"']+)["']/i)?.[1]
  if (fromProperties) return fromProperties

  const metaId =
    opfXml.match(/<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? opfXml.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']cover["']/i)?.[1]
  if (metaId) {
    const escaped = metaId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const item = items.find((tag) => new RegExp(`\\bid=["']${escaped}["']`, 'i').test(tag))
    const href = item?.match(/\bhref=["']([^"']+)["']/i)?.[1]
    if (href) return href
  }

  return null
}

function zipFile(zip: JSZip, path: string) {
  return zip.file(path) || zip.file(path.replace(/^\.\//, '')) || zip.file(path.replace(/^\/+/, ''))
}

async function blobFromZipPath(zip: JSZip, path: string): Promise<Blob | null> {
  const entry = zipFile(zip, path)
  if (!entry) return null
  const bytes = await entry.async('uint8array')
  if (!bytes.byteLength) return null
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type: mimeFromCoverName(path) })
}

export async function extractCoverFromEpubZip(zip: JSZip, opfPath?: string): Promise<Blob | null> {
  const resolvedOpf = opfPath ?? Object.keys(zip.files).find((path) => path.toLowerCase().endsWith('.opf'))
  if (resolvedOpf) {
    const opfDir = resolvedOpf.includes('/') ? resolvedOpf.slice(0, resolvedOpf.lastIndexOf('/') + 1) : ''
    const opfXml = await zip.file(resolvedOpf)!.async('string')
    const href = findEpubCoverHref(opfXml)
    if (href) {
      const cover = await blobFromZipPath(zip, decodeOpfPath(opfDir, href))
      if (cover) return cover
    }
  }

  const names = Object.keys(zip.files).filter((path) => !zip.files[path].dir && COVER_IMAGE_RE.test(path))
  const ranked = names
    .map((path) => {
      const base = path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
      let score = 0
      if (/(^|[^a-z])cover([^a-z]|$)/i.test(base)) score += 8
      if (/front/i.test(base)) score += 4
      if (/\/images?\//i.test(path)) score += 1
      return { path, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  for (const item of ranked) {
    const cover = await blobFromZipPath(zip, item.path)
    if (cover) return cover
  }
  return null
}

export function extractFb2Cover(xml: string): Blob | null {
  const href =
    xml.match(/<coverpage[\s\S]*?l:href=["']#([^"']+)["']/i)?.[1]
    ?? xml.match(/<coverpage[\s\S]*?href=["']#([^"']+)["']/i)?.[1]
    ?? xml.match(/<binary\b[^>]*id=["']([^"']*cover[^"']*)["']/i)?.[1]

  const binaries = [...xml.matchAll(/<binary\b([^>]*)>([\s\S]*?)<\/binary>/gi)]
  const match = href
    ? binaries.find((entry) => new RegExp(`\\bid=["']${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(entry[1]))
    : binaries.find((entry) => /id=["'][^"']*cover/i.test(entry[1]))
  if (!match) return null

  const contentType = match[1].match(/content-type=["']([^"']+)["']/i)?.[1] ?? 'image/jpeg'
  const base64 = match[2].replace(/\s+/g, '')
  if (!base64) return null
  try {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return new Blob([copy], { type: contentType })
  } catch {
    return null
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read cover image.'))
    reader.readAsDataURL(blob)
  })
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

export async function compressCover(blob: Blob, maxWidth = 280, maxHeight = 420): Promise<string> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height)
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height })
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, width, height)
        bitmap.close()
        if ('convertToBlob' in canvas) {
          const next = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.74 })
          return blobToDataUrl(next)
        }
        return (canvas as HTMLCanvasElement).toDataURL('image/jpeg', 0.74)
      }
      bitmap.close()
    } catch {
      // Fall through to the original bytes.
    }
  }
  return blobToDataUrl(blob)
}
