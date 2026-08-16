/**
 * Pure helpers that turn popular document formats into plain text.
 * Heavy work (zip/docx) is dynamic-imported from extractBookText.
 */

export function normalizeText(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function htmlToText(html: string) {
  if (typeof DOMParser === 'undefined') {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, noscript').forEach((node) => node.remove())
  // Preserve block boundaries a bit
  doc.querySelectorAll('p, div, br, h1, h2, h3, h4, h5, h6, li, tr').forEach((node) => {
    if (node.tagName === 'BR') {
      node.replaceWith('\n')
      return
    }
    node.append('\n')
  })
  return doc.body?.textContent ?? ''
}

export function xmlOrHtmlToText(markup: string) {
  // FB2 and ODT content are XML; DOMParser 'application/xml' keeps structure
  if (typeof DOMParser === 'undefined') {
    return markup.replace(/<[^>]+>/g, ' ')
  }
  const asHtml = markup
    .replace(/<\?xml[^?]*\?>/i, '')
    // Common FB2 tags → line breaks
    .replace(/<\/(p|v|subtitle|title|section|empty-line)>/gi, '</$1>\n')
    .replace(/<empty-line\s*\/>/gi, '\n')
  return htmlToText(asHtml)
}

/**
 * Lightweight RTF → text. Strips control words/groups; good enough for most
 * novel/export RTF. Not a full RTF engine.
 */
export function rtfToText(rtf: string) {
  let text = rtf
    // Prefer unicode escapes \'hh and \uN
    .replace(/\\'[0-9a-fA-F]{2}/g, (m) => {
      const hex = m.slice(2)
      try {
        return String.fromCharCode(parseInt(hex, 16))
      } catch {
        return ' '
      }
    })
    .replace(/\\u(-?\d+)\??/g, (_, n) => {
      const code = Number(n)
      if (!Number.isFinite(code)) return ' '
      // RTF \u is signed 16-bit
      const c = code < 0 ? 65536 + code : code
      try {
        return String.fromCharCode(c)
      } catch {
        return ' '
      }
    })

  // Remove font/color tables and other destination groups we don't need
  text = text.replace(/\{\\\*\\[^}]+\}/g, ' ')
  text = text.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info)[\s\S]*?\}/g, ' ')

  // Control words → space or newline
  text = text
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\line/g, '\n')
    .replace(/\\tab/g, '\t')
    .replace(/\\[a-z]+(-?\d+)?[ ]?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\\\\/g, '\\')

  return normalizeText(text)
}

/** Pull readable strings out of JSON (ebooks sometimes ship as structured JSON). */
export function jsonToText(raw: string) {
  try {
    const value = JSON.parse(raw) as unknown
    const chunks: string[] = []
    const walk = (node: unknown, depth: number) => {
      if (node == null || depth > 12) return
      if (typeof node === 'string') {
        const t = node.trim()
        if (t.length > 0) chunks.push(t)
        return
      }
      if (typeof node === 'number' || typeof node === 'boolean') return
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1)
        return
      }
      if (typeof node === 'object') {
        for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
          // Prefer narrative-ish keys
          if (/^(text|content|body|chapter|paragraph|title|story|pages?)$/i.test(key)
            || typeof val === 'string'
            || Array.isArray(val)
            || (val && typeof val === 'object')) {
            walk(val, depth + 1)
          }
        }
      }
    }
    walk(value, 0)
    const joined = chunks.join('\n\n')
    return normalizeText(joined || JSON.stringify(value, null, 2))
  } catch {
    return normalizeText(raw)
  }
}

export function estimatePages(text: string) {
  return Math.max(1, Math.ceil(text.length / 2400))
}
