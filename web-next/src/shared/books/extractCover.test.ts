import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  extractCoverFromEpubZip,
  extractFb2Cover,
  findEpubCoverHref,
  parseFb2Metadata,
  parseOpfMetadata,
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

describe('parseOpfMetadata', () => {
  it('reads title, author, and ISBN from Dublin Core tags', () => {
    expect(parseOpfMetadata(`
      <metadata>
        <dc:title>The Art of Seduction</dc:title>
        <dc:creator opf:role="aut">Robert Greene</dc:creator>
        <dc:identifier opf:scheme="ISBN">978-0-14-118263-6</dc:identifier>
      </metadata>
    `)).toEqual({
      title: 'The Art of Seduction',
      author: 'Robert Greene',
      isbn: '9780141182636',
    })
  })

  it('ignores Calibre UUIDs', () => {
    expect(parseOpfMetadata(`
      <dc:title>Storyworthy</dc:title>
      <dc:identifier opf:scheme="calibre">abc-uuid</dc:identifier>
      <dc:identifier>urn:isbn:9781101984147</dc:identifier>
    `).isbn).toBe('9781101984147')
  })
})

describe('parseFb2Metadata', () => {
  it('reads FictionBook title, author, and isbn', () => {
    expect(parseFb2Metadata(`
      <description>
        <title-info>
          <book-title>Influence</book-title>
          <author><first-name>Robert</first-name><last-name>Cialdini</last-name></author>
        </title-info>
        <publish-info><isbn>978-0-06-124189-5</isbn></publish-info>
      </description>
    `)).toEqual({
      title: 'Influence',
      author: 'Robert Cialdini',
      isbn: '9780061241895',
    })
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
