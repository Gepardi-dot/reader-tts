import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  extractCoverFromEpubZip,
  extractFb2Cover,
  findEpubCoverHref,
} from './extractCover'

describe('findEpubCoverHref', () => {
  it('prefers the cover-image property', () => {
    expect(findEpubCoverHref(`
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="c1" href="images/front.jpg" media-type="image/jpeg" properties="cover-image"/>
    `)).toBe('images/front.jpg')
  })

  it('falls back to the OPF cover meta id', () => {
    expect(findEpubCoverHref(`
      <meta name="cover" content="coverid"/>
      <item id="coverid" href="cover.png" media-type="image/png"/>
    `)).toBe('cover.png')
  })
})

describe('extractCoverFromEpubZip', () => {
  it('reads the declared cover image from the package', async () => {
    const zip = new JSZip()
    zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
      <package>
        <metadata><meta name="cover" content="cover-image"/></metadata>
        <manifest>
          <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg"/>
        </manifest>
      </package>`)
    zip.file('OEBPS/images/cover.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))

    const cover = await extractCoverFromEpubZip(zip, 'OEBPS/content.opf')
    expect(cover).not.toBeNull()
    expect(cover?.type).toBe('image/jpeg')
    expect((await cover!.arrayBuffer()).byteLength).toBe(4)
  })
})

describe('extractFb2Cover', () => {
  it('decodes a named cover binary', () => {
    const cover = extractFb2Cover(`
      <coverpage><image l:href="#cover.jpg"/></coverpage>
      <binary id="cover.jpg" content-type="image/jpeg">/w==</binary>
    `)
    expect(cover).not.toBeNull()
    expect(cover?.type).toBe('image/jpeg')
  })
})
