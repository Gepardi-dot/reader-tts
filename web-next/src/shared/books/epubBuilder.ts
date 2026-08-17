/**
 * Build a minimal valid EPUB 3 package from title + chapters.
 * Uses JSZip (already a dependency for EPUB/ODT import).
 */

import type { BookChapter } from '@/shared/books/chapterSplit'

export interface BuildEpubInput {
  title: string
  author?: string
  language?: string
  chapters: BookChapter[]
  /** Original filename stem used for download name */
  fileNameBase?: string
  cover?: Blob
}

export interface BuiltEpub {
  blob: Blob
  fileName: string
  chapterCount: number
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function textToXhtmlParagraphs(text: string) {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
  if (blocks.length === 0) return '<p></p>'
  return blocks
    .map((block) => {
      const lines = escapeXml(block).replace(/\n/g, '<br/>')
      return `<p>${lines}</p>`
    })
    .join('\n')
}

function chapterXhtml(title: string, body: string, language: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}" xml:lang="${escapeXml(language)}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(title)}</title>
  <style>
    body { font-family: serif; line-height: 1.5; margin: 1.2em; }
    h1 { font-size: 1.4em; margin-bottom: 1em; }
    p { margin: 0 0 0.85em; text-indent: 1.2em; }
    p:first-of-type { text-indent: 0; }
  </style>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
  ${textToXhtmlParagraphs(body)}
</body>
</html>
`
}

function slugify(name: string) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'book'
}

/**
 * Create an EPUB 3 blob. Always re-packages content so any source format
 * becomes a consistent, portable .epub for download or re-import.
 */
export async function buildEpub(input: BuildEpubInput): Promise<BuiltEpub> {
  const JSZip = (await import('jszip')).default
  const title = input.title.trim() || 'Untitled book'
  const author = (input.author || 'Storybook Reader').trim()
  const language = input.language || 'en'
  const chapters = input.chapters.length > 0
    ? input.chapters
    : [{ id: 'ch-1', title: title, text: '' }]

  const bookId = `urn:uuid:${crypto.randomUUID()}`
  const zip = new JSZip()

  // mimetype must be first and uncompressed for strict EPUB readers
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
  )

  const manifestItems: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
  ]
  let coverMeta = ''
  if (input.cover && input.cover.size > 0) {
    const coverBytes = new Uint8Array(await input.cover.arrayBuffer())
    const coverType = input.cover.type || 'image/jpeg'
    const coverExt = coverType.includes('png') ? 'png' : coverType.includes('webp') ? 'webp' : 'jpg'
    zip.file(`OEBPS/cover.${coverExt}`, coverBytes)
    manifestItems.push(
      `<item id="cover-image" href="cover.${coverExt}" media-type="${coverType}" properties="cover-image"/>`,
    )
    coverMeta = '<meta name="cover" content="cover-image"/>'
  }
  const spineItems: string[] = []
  const navPoints: string[] = []

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    const href = `chapter-${i + 1}.xhtml`
    const id = `chap${i + 1}`
    zip.file(
      `OEBPS/${href}`,
      chapterXhtml(ch.title || `Chapter ${i + 1}`, ch.text, language),
    )
    manifestItems.push(
      `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`,
    )
    spineItems.push(`<itemref idref="${id}"/>`)
    navPoints.push(
      `<li><a href="${href}">${escapeXml(ch.title || `Chapter ${i + 1}`)}</a></li>`,
    )
  }

  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(bookId)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>${escapeXml(language)}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    <meta name="generator" content="Storybook Reader"/>
    ${coverMeta}
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    ${spineItems.join('\n    ')}
  </spine>
</package>
`,
  )

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}">
<head>
  <meta charset="UTF-8"/>
  <title>Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      ${navPoints.join('\n      ')}
    </ol>
  </nav>
</body>
</html>
`,
  )

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  const base = slugify(input.fileNameBase || title)
  return {
    blob,
    fileName: `${base}.epub`,
    chapterCount: chapters.length,
  }
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the browser has a chance to start the download
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000)
}
