export type ReaderAppearance = {
  fontFamily: 'serif' | 'sans'
  lineHeight: 'compact' | 'comfortable' | 'airy'
  pageWidth: 'narrow' | 'balanced' | 'wide'
  textAlign: 'left' | 'justify'
}

export const DEFAULT_READER_APPEARANCE: ReaderAppearance = {
  fontFamily: 'serif',
  lineHeight: 'comfortable',
  pageWidth: 'balanced',
  textAlign: 'justify',
}

export const READER_FONT_SCALE_MIN = 0.85
export const READER_FONT_SCALE_MAX = 1.45
