import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Highlight, HighlightColor } from '../types'
import {
  DEFAULT_READER_APPEARANCE,
  READER_FONT_SCALE_MAX,
  READER_FONT_SCALE_MIN,
  type ReaderAppearance,
} from './readerAppearance'
import { paginateReaderText, type ReaderPage } from './readerPagination'

const READER_FONT_SCALE_STEP = 0.05

type ReaderDeskProps = {
  text: string
  highlights: Highlight[]
  canPlayFromSelection?: boolean
  initialFontScale?: number
  initialAppearance?: ReaderAppearance
  focusRequest?: number
  focusRange?: {
    start: number
    end: number
  } | null
  narrationFocusRequest?: number
  spokenRange?: {
    start: number
    end: number
  } | null
  initialPageNumber?: number
  onProgressChange?: (payload: {
    pageNumber: number
    totalPages: number
    textStart: number
    textEnd: number
    textLength: number
  }) => void
  onFontScaleChange?: (fontScale: number) => void
  onAppearanceChange?: (appearance: ReaderAppearance) => void
  onCreateHighlight: (payload: {
    start: number
    end: number
    color: HighlightColor
    text: string
    note?: string
  }) => Promise<void>
  onPlayFromSelection?: (payload: {
    start: number
    end: number
    text: string
  }) => Promise<void> | void
}

type HighlightDraft = {
  start: number
  end: number
  text: string
}

type SelectionMenuPosition = {
  left: number
  top: number
  placement: 'above' | 'below'
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function isWordCharacter(value: string) {
  return /[0-9A-Za-z\u00C0-\u024F\u0400-\u04FF]/.test(value) || value === "'" || value === '-' || value === '\u2019'
}

function findWordBounds(text: string, offset: number) {
  if (!text.length) {
    return null
  }

  let cursor = Math.max(0, Math.min(offset, text.length - 1))

  if (!isWordCharacter(text[cursor] ?? '')) {
    if (cursor > 0 && isWordCharacter(text[cursor - 1] ?? '')) {
      cursor -= 1
    } else {
      while (cursor < text.length && !isWordCharacter(text[cursor] ?? '')) {
        cursor += 1
      }
      if (cursor >= text.length) {
        return null
      }
    }
  }

  let start = cursor
  let end = cursor + 1

  while (start > 0 && isWordCharacter(text[start - 1] ?? '')) {
    start -= 1
  }

  while (end < text.length && isWordCharacter(text[end] ?? '')) {
    end += 1
  }

  return end > start ? { start, end } : null
}

function resolveTextNodePosition(container: HTMLElement, targetOffset: number) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, targetOffset)
  let lastTextNode: Text | null = null
  let currentNode = walker.nextNode()

  while (currentNode) {
    const textNode = currentNode as Text
    const length = textNode.data.length

    if (remaining <= length) {
      return {
        node: textNode,
        offset: remaining,
      }
    }

    remaining -= length
    lastTextNode = textNode
    currentNode = walker.nextNode()
  }

  if (!lastTextNode) {
    return null
  }

  return {
    node: lastTextNode,
    offset: lastTextNode.data.length,
  }
}

function buildRangeFromOffsets(container: HTMLDivElement, start: number, end: number) {
  const startPosition = resolveTextNodePosition(container, start)
  const endPosition = resolveTextNodePosition(container, end)

  if (!startPosition || !endPosition) {
    return null
  }

  const range = document.createRange()
  range.setStart(startPosition.node, startPosition.offset)
  range.setEnd(endPosition.node, endPosition.offset)
  return range
}

function pointHitsRange(range: Range, clientX: number, clientY: number) {
  const tolerance = 1
  const rects = [...range.getClientRects()]

  if (!rects.length) {
    const rect = range.getBoundingClientRect()
    return (
      clientX >= rect.left - tolerance &&
      clientX <= rect.right + tolerance &&
      clientY >= rect.top - tolerance &&
      clientY <= rect.bottom + tolerance
    )
  }

  return rects.some(
    (rect) =>
      clientX >= rect.left - tolerance &&
      clientX <= rect.right + tolerance &&
      clientY >= rect.top - tolerance &&
      clientY <= rect.bottom + tolerance,
  )
}

function getCaretRangeFromPoint(clientX: number, clientY: number) {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }

  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(clientX, clientY)
    if (!position) {
      return null
    }

    const range = document.createRange()
    range.setStart(position.offsetNode, position.offset)
    range.collapse(true)
    return range
  }

  if (typeof doc.caretRangeFromPoint === 'function') {
    return doc.caretRangeFromPoint(clientX, clientY)
  }

  return null
}

function colorClass(color: HighlightColor) {
  if (color === 'rose') {
    return 'highlight-rose'
  }
  if (color === 'sky') {
    return 'highlight-sky'
  }
  return 'highlight-amber'
}

function isTextEntryTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function buildSegments(
  page: ReaderPage,
  highlights: Highlight[],
  spokenRange?: {
    start: number
    end: number
  } | null,
  focusRange?: {
    start: number
    end: number
  } | null,
) {
  const segments: Array<{
    text: string
    color: HighlightColor | null
    focus: boolean
    spoken: boolean
    key: string
  }> = []
  const relevant = highlights
    .filter((item) => item.end > page.start && item.start < page.end)
    .sort((left, right) => left.start - right.start)
  const spokenStart = spokenRange ? Math.max(spokenRange.start, page.start) : null
  const spokenEnd = spokenRange ? Math.min(spokenRange.end, page.end) : null
  const focusStart = focusRange ? Math.max(focusRange.start, page.start) : null
  const focusEnd = focusRange ? Math.min(focusRange.end, page.end) : null
  const boundaries = new Set([page.start, page.end])

  for (const item of relevant) {
    boundaries.add(Math.max(item.start, page.start))
    boundaries.add(Math.min(item.end, page.end))
  }

  if (spokenStart !== null && spokenEnd !== null && spokenEnd > spokenStart) {
    boundaries.add(spokenStart)
    boundaries.add(spokenEnd)
  }

  if (focusStart !== null && focusEnd !== null && focusEnd > focusStart) {
    boundaries.add(focusStart)
    boundaries.add(focusEnd)
  }

  const sorted = [...boundaries].sort((left, right) => left - right)
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const segmentStart = sorted[index]
    const segmentEnd = sorted[index + 1]
    if (segmentEnd <= segmentStart) {
      continue
    }

    const color =
      relevant.find((item) => item.start < segmentEnd && item.end > segmentStart)?.color ?? null
    const spoken =
      spokenStart !== null &&
      spokenEnd !== null &&
      spokenStart < segmentEnd &&
      spokenEnd > segmentStart
    const focus =
      focusStart !== null &&
      focusEnd !== null &&
      focusStart < segmentEnd &&
      focusEnd > segmentStart

    segments.push({
      text: page.text.slice(segmentStart - page.start, segmentEnd - page.start),
      color,
      focus,
      spoken,
      key: `${page.start}-${segmentStart}-${segmentEnd}`,
    })
  }

  return segments.filter((segment) => segment.text.length > 0)
}

export function ReaderDesk({
  text,
  highlights,
  canPlayFromSelection = false,
  initialFontScale = 1,
  initialAppearance = DEFAULT_READER_APPEARANCE,
  focusRequest = 0,
  focusRange = null,
  narrationFocusRequest = 0,
  spokenRange,
  initialPageNumber = 1,
  onProgressChange,
  onFontScaleChange,
  onAppearanceChange,
  onCreateHighlight,
  onPlayFromSelection,
}: ReaderDeskProps) {
  const [pageNumber, setPageNumber] = useState(1)
  const [fontScale, setFontScale] = useState(initialFontScale)
  const [appearance, setAppearance] = useState(initialAppearance)
  const [draft, setDraft] = useState<HighlightDraft | null>(null)
  const [savingColor, setSavingColor] = useState<HighlightColor | null>(null)
  const [playingSelection, setPlayingSelection] = useState(false)
  const [menuPosition, setMenuPosition] = useState<SelectionMenuPosition | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteColor, setNoteColor] = useState<HighlightColor>('amber')
  const menuRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<Array<HTMLDivElement | null>>([])
  const lastReportedPageRef = useRef<number | null>(null)
  const hasAutoScrolledRef = useRef(false)
  const progressChangeRef = useRef<typeof onProgressChange>(onProgressChange)
  const fontScaleChangeRef = useRef<typeof onFontScaleChange>(onFontScaleChange)
  const appearanceChangeRef = useRef<typeof onAppearanceChange>(onAppearanceChange)

  const pages = useMemo(() => paginateReaderText(text), [text])
  const readerDeskStyle = useMemo<CSSProperties>(() => {
    const pageWidth =
      appearance.pageWidth === 'narrow' ? 640 : appearance.pageWidth === 'wide' ? 980 : 840
    const lineHeight =
      appearance.lineHeight === 'compact' ? 1.72 : appearance.lineHeight === 'airy' ? 2.06 : 1.9
    const fontFamily =
      appearance.fontFamily === 'sans'
        ? "'Avenir Next', 'Segoe UI', sans-serif"
        : "'Cormorant Garamond', Georgia, serif"

    return {
      '--reader-page-width': `${pageWidth}px`,
      '--reader-line-height': `${lineHeight}`,
      '--reader-font-family': fontFamily,
      '--reader-text-align': appearance.textAlign,
    } as CSSProperties
  }, [appearance])

  useEffect(() => {
    setPageNumber(Math.min(Math.max(1, initialPageNumber), Math.max(1, pages.length)))
    setDraft(null)
  }, [initialPageNumber, pages.length, text])

  useEffect(() => {
    setFontScale(initialFontScale)
  }, [initialFontScale])

  useEffect(() => {
    setAppearance(initialAppearance)
  }, [initialAppearance])

  useEffect(() => {
    progressChangeRef.current = onProgressChange
  }, [onProgressChange])

  useEffect(() => {
    fontScaleChangeRef.current = onFontScaleChange
  }, [onFontScaleChange])

  useEffect(() => {
    appearanceChangeRef.current = onAppearanceChange
  }, [onAppearanceChange])

  useEffect(() => {
    fontScaleChangeRef.current?.(fontScale)
  }, [fontScale])

  useEffect(() => {
    appearanceChangeRef.current?.(appearance)
  }, [appearance])

  useEffect(() => {
    pageRefs.current = pageRefs.current.slice(0, pages.length)
  }, [pages.length])

  useEffect(() => {
    if (!pages.length) {
      return
    }
    const currentPage = pages[Math.max(0, Math.min(pageNumber - 1, pages.length - 1))]
    lastReportedPageRef.current = pageNumber
    progressChangeRef.current?.({
      pageNumber,
      totalPages: pages.length,
      textStart: currentPage.start,
      textEnd: currentPage.end,
      textLength: text.length,
    })
  }, [pageNumber, pages, text.length])

  useEffect(() => {
    if (!pages.length) {
      return
    }

    const visibilityByPage = new Map<number, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const nextPage = Number((entry.target as HTMLElement).dataset.pageNumber)
          if (!nextPage) {
            continue
          }
          visibilityByPage.set(nextPage, entry.isIntersecting ? entry.intersectionRatio : 0)
        }

        let mostVisiblePage = 0
        let highestRatio = 0

        for (const [nextPage, ratio] of visibilityByPage) {
          if (ratio > highestRatio) {
            highestRatio = ratio
            mostVisiblePage = nextPage
          }
        }

        if (mostVisiblePage > 0) {
          setPageNumber((current) => (current === mostVisiblePage ? current : mostVisiblePage))
        }
      },
      {
        threshold: [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9],
        rootMargin: '-10% 0px -35% 0px',
      },
    )

    for (const node of pageRefs.current) {
      if (node) {
        observer.observe(node)
      }
    }

    return () => observer.disconnect()
  }, [pages.length])

  useEffect(() => {
    if (!pages.length) {
      return
    }

    const targetPage = Math.min(Math.max(1, initialPageNumber), pages.length)
    if (targetPage === lastReportedPageRef.current) {
      return
    }

    const node = pageRefs.current[targetPage - 1]
    if (!node) {
      return
    }

    const top = node.getBoundingClientRect().top + window.scrollY - 112
    window.scrollTo({
      top: Math.max(0, top),
      behavior: hasAutoScrolledRef.current ? 'smooth' : 'auto',
    })
    setPageNumber(targetPage)
    hasAutoScrolledRef.current = true
  }, [initialPageNumber, pages.length, text])

  useEffect(() => {
    if (!narrationFocusRequest || !spokenRange || !pages.length) {
      return
    }

    const targetPageIndex = pages.findIndex(
      (page) => spokenRange.start < page.end && spokenRange.end > page.start,
    )
    if (targetPageIndex < 0) {
      return
    }

    let innerFrame = 0
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => {
        const pageNode = pageRefs.current[targetPageIndex]
        if (!pageNode) {
          return
        }

        const spokenNode = pageNode.querySelector('.narration-current') as HTMLElement | null
        const targetNode = spokenNode ?? pageNode
        const top = targetNode.getBoundingClientRect().top + window.scrollY - 148
        window.scrollTo({
          top: Math.max(0, top),
          behavior: hasAutoScrolledRef.current ? 'smooth' : 'auto',
        })
        hasAutoScrolledRef.current = true
      })
    })

    return () => {
      window.cancelAnimationFrame(outerFrame)
      if (innerFrame) {
        window.cancelAnimationFrame(innerFrame)
      }
    }
  }, [narrationFocusRequest, pages, spokenRange])

  useEffect(() => {
    if (!focusRequest || !focusRange || !pages.length) {
      return
    }

    const targetPageIndex = pages.findIndex((page) => focusRange.start < page.end && focusRange.end > page.start)
    if (targetPageIndex < 0) {
      return
    }

    let innerFrame = 0
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => {
        const page = pages[targetPageIndex]
        const pageNode = pageRefs.current[targetPageIndex]
        const contentNode = pageNode?.querySelector('.reader-sheet__content') as HTMLDivElement | null
        if (!pageNode || !contentNode) {
          return
        }

        const focusNode = pageNode.querySelector('.reader-highlight-focus') as HTMLElement | null
        const start = Math.max(0, focusRange.start - page.start)
        const end = Math.max(start + 1, Math.min(page.end, focusRange.end) - page.start)
        const range = focusNode ? null : buildRangeFromOffsets(contentNode, start, end)
        const targetTop =
          (focusNode?.getBoundingClientRect().top ?? range?.getBoundingClientRect().top ?? pageNode.getBoundingClientRect().top) +
          window.scrollY -
          168

        window.scrollTo({
          top: Math.max(0, targetTop),
          behavior: 'smooth',
        })
        hasAutoScrolledRef.current = true
      })
    })

    return () => {
      window.cancelAnimationFrame(outerFrame)
      if (innerFrame) {
        window.cancelAnimationFrame(innerFrame)
      }
    }
  }, [focusRequest, focusRange, pages])

  useEffect(() => {
    if (!draft) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return
      }
      clearSelection()
    }

    const clearFromViewportChange = () => clearSelection()

    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('scroll', clearFromViewportChange, true)
    window.addEventListener('resize', clearFromViewportChange)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('scroll', clearFromViewportChange, true)
      window.removeEventListener('resize', clearFromViewportChange)
    }
  }, [draft])

  function clearSelection() {
    window.getSelection()?.removeAllRanges()
    setDraft(null)
    setMenuPosition(null)
    setNoteOpen(false)
    setNoteText('')
    setNoteColor('amber')
    setPlayingSelection(false)
  }

  function applyDraftFromRange(page: ReaderPage, container: HTMLDivElement, range: Range) {
    const startRange = range.cloneRange()
    startRange.selectNodeContents(container)
    startRange.setEnd(range.startContainer, range.startOffset)
    const start = page.start + startRange.toString().length

    const endRange = range.cloneRange()
    endRange.selectNodeContents(container)
    endRange.setEnd(range.endContainer, range.endOffset)
    const end = page.start + endRange.toString().length

    const selectedText = normalizeText(range.toString())
    if (!selectedText || end <= start) {
      clearSelection()
      return false
    }

    const rect = range.getBoundingClientRect()
    const menuWidth = Math.min(420, window.innerWidth - 24)
    const centeredLeft = rect.left + rect.width / 2
    const clampedLeft = Math.max(
      16 + menuWidth / 2,
      Math.min(centeredLeft, window.innerWidth - 16 - menuWidth / 2),
    )
    const placeBelow = rect.top < 180

    setDraft({
      start,
      end,
      text: selectedText,
    })
    setMenuPosition({
      left: clampedLeft,
      top: placeBelow ? rect.bottom + 14 : rect.top - 14,
      placement: placeBelow ? 'below' : 'above',
    })
    setNoteOpen(false)
    setNoteText('')
    setNoteColor('amber')
    setPlayingSelection(false)
    return true
  }

  function buildWordRangeFromPoint(page: ReaderPage, container: HTMLDivElement, clientX: number, clientY: number) {
    const caretRange = getCaretRangeFromPoint(clientX, clientY)
    if (!caretRange || !container.contains(caretRange.startContainer)) {
      return null
    }

    const prefixRange = caretRange.cloneRange()
    prefixRange.selectNodeContents(container)
    prefixRange.setEnd(caretRange.startContainer, caretRange.startOffset)

    const bounds = findWordBounds(page.text, prefixRange.toString().length)
    if (!bounds) {
      return null
    }

    const range = buildRangeFromOffsets(container, bounds.start, bounds.end)
    if (!range || !pointHitsRange(range, clientX, clientY)) {
      return null
    }

    return range
  }

  function captureSelection(
    page: ReaderPage,
    container: HTMLDivElement,
    clientX: number,
    clientY: number,
  ) {
    const selection = window.getSelection()
    const range =
      selection &&
      selection.rangeCount > 0 &&
      !selection.isCollapsed &&
      container.contains(selection.getRangeAt(0).commonAncestorContainer) &&
      container.contains(selection.anchorNode) &&
      container.contains(selection.focusNode)
        ? selection.getRangeAt(0)
        : buildWordRangeFromPoint(page, container, clientX, clientY)

    if (!range) {
      clearSelection()
      return
    }

    if (selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }

    applyDraftFromRange(page, container, range)
  }

  async function saveHighlight(color: HighlightColor, note?: string) {
    if (!draft) {
      return
    }

    try {
      setSavingColor(color)
      await onCreateHighlight({
        start: draft.start,
        end: draft.end,
        color,
        text: draft.text,
        note: note?.trim() ? note.trim() : undefined,
      })
      clearSelection()
    } finally {
      setSavingColor(null)
    }
  }

  async function copySelection() {
    if (!draft) {
      return
    }

    try {
      await navigator.clipboard.writeText(draft.text)
    } catch {
      // Ignore clipboard failures and leave the menu open.
    }
  }

  function openDefinitionWindow() {
    if (!draft) {
      return
    }

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`${draft.text} definition`)}`
    window.open(
      searchUrl,
      'storybook-dictionary',
      'popup=yes,width=540,height=680,menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes',
    )
  }

  async function playFromSelection() {
    if (!draft || !onPlayFromSelection || !canPlayFromSelection || playingSelection) {
      return
    }

    try {
      setPlayingSelection(true)
      await onPlayFromSelection(draft)
      clearSelection()
    } finally {
      setPlayingSelection(false)
    }
  }

  async function saveNote() {
    await saveHighlight(noteColor, noteText)
  }

  function updateAppearance(nextPartial: Partial<ReaderAppearance>) {
    setAppearance((current) => {
      const next = {
        ...current,
        ...nextPartial,
      }

      return Object.keys(nextPartial).every(
        (key) => current[key as keyof ReaderAppearance] === next[key as keyof ReaderAppearance],
      )
        ? current
        : next
    })
  }

  function adjustFontScale(delta: number) {
    setFontScale((current) => {
      const next = Number((current + delta).toFixed(2))
      return Math.min(READER_FONT_SCALE_MAX, Math.max(READER_FONT_SCALE_MIN, next))
    })
  }

  const visiblePages = pages

  return (
    <div className="reader-desk" style={readerDeskStyle}>
      <div className="book-stage__desk" />

      <div className="reader-settings" role="toolbar" aria-label="Reader appearance">
        <div className="reader-settings__group">
          <span className="reader-settings__label">Format</span>
          <div className="reader-settings__segmented">
            <button
              aria-pressed={appearance.fontFamily === 'serif'}
              className={appearance.fontFamily === 'serif' ? 'active' : ''}
              onClick={() => updateAppearance({ fontFamily: 'serif' })}
              type="button"
            >
              Serif
            </button>
            <button
              aria-pressed={appearance.fontFamily === 'sans'}
              className={appearance.fontFamily === 'sans' ? 'active' : ''}
              onClick={() => updateAppearance({ fontFamily: 'sans' })}
              type="button"
            >
              Sans
            </button>
          </div>
        </div>

        <div className="reader-settings__group reader-settings__group--size">
          <span className="reader-settings__label">Size</span>
          <div className="reader-settings__size">
            <button
              aria-label="Decrease text size"
              disabled={fontScale <= READER_FONT_SCALE_MIN}
              onClick={() => adjustFontScale(-READER_FONT_SCALE_STEP)}
              type="button"
            >
              A-
            </button>
            <input
              aria-label="Text size"
              max={READER_FONT_SCALE_MAX}
              min={READER_FONT_SCALE_MIN}
              onChange={(event) => setFontScale(Number(event.target.value))}
              step={READER_FONT_SCALE_STEP}
              type="range"
              value={fontScale}
            />
            <button
              aria-label="Increase text size"
              disabled={fontScale >= READER_FONT_SCALE_MAX}
              onClick={() => adjustFontScale(READER_FONT_SCALE_STEP)}
              type="button"
            >
              A+
            </button>
          </div>
        </div>

        <div className="reader-settings__group">
          <span className="reader-settings__label">Page</span>
          <div className="reader-settings__segmented">
            <button
              aria-pressed={appearance.pageWidth === 'narrow'}
              className={appearance.pageWidth === 'narrow' ? 'active' : ''}
              onClick={() => updateAppearance({ pageWidth: 'narrow' })}
              type="button"
            >
              Narrow
            </button>
            <button
              aria-pressed={appearance.pageWidth === 'balanced'}
              className={appearance.pageWidth === 'balanced' ? 'active' : ''}
              onClick={() => updateAppearance({ pageWidth: 'balanced' })}
              type="button"
            >
              Balanced
            </button>
            <button
              aria-pressed={appearance.pageWidth === 'wide'}
              className={appearance.pageWidth === 'wide' ? 'active' : ''}
              onClick={() => updateAppearance({ pageWidth: 'wide' })}
              type="button"
            >
              Wide
            </button>
          </div>
        </div>

        <div className="reader-settings__group">
          <span className="reader-settings__label">Text</span>
          <div className="reader-settings__segmented">
            <button
              aria-pressed={appearance.textAlign === 'left'}
              className={appearance.textAlign === 'left' ? 'active' : ''}
              onClick={() => updateAppearance({ textAlign: 'left' })}
              type="button"
            >
              Left
            </button>
            <button
              aria-pressed={appearance.textAlign === 'justify'}
              className={appearance.textAlign === 'justify' ? 'active' : ''}
              onClick={() => updateAppearance({ textAlign: 'justify' })}
              type="button"
            >
              Justify
            </button>
          </div>
        </div>

        <div className="reader-settings__group">
          <span className="reader-settings__label">Spacing</span>
          <div className="reader-settings__segmented">
            <button
              aria-pressed={appearance.lineHeight === 'compact'}
              className={appearance.lineHeight === 'compact' ? 'active' : ''}
              onClick={() => updateAppearance({ lineHeight: 'compact' })}
              type="button"
            >
              Tight
            </button>
            <button
              aria-pressed={appearance.lineHeight === 'comfortable'}
              className={appearance.lineHeight === 'comfortable' ? 'active' : ''}
              onClick={() => updateAppearance({ lineHeight: 'comfortable' })}
              type="button"
            >
              Comfort
            </button>
            <button
              aria-pressed={appearance.lineHeight === 'airy'}
              className={appearance.lineHeight === 'airy' ? 'active' : ''}
              onClick={() => updateAppearance({ lineHeight: 'airy' })}
              type="button"
            >
              Airy
            </button>
          </div>
        </div>
      </div>

      {draft && menuPosition ? (
        <div
          className={`selection-menu selection-menu--${menuPosition.placement}`}
          onMouseDown={(event) => {
            if (!isTextEntryTarget(event.target)) {
              event.preventDefault()
            }
          }}
          ref={menuRef}
          style={{ left: menuPosition.left, top: menuPosition.top }}
        >
          <div className="selection-menu__label">{draft.text}</div>
          <div className="selection-menu__actions">
            <button
              disabled={!canPlayFromSelection || playingSelection}
              onClick={() => void playFromSelection()}
              title={canPlayFromSelection ? 'Start playback from this selection' : 'Set up a ready voice in Audio controls first'}
              type="button"
            >
              {canPlayFromSelection ? (playingSelection ? 'Starting...' : 'Play here') : 'Live not ready'}
            </button>
            <button onClick={() => void copySelection()} type="button">
              Copy
            </button>
            <button onClick={() => setNoteOpen((current) => !current)} type="button">
              {noteOpen ? 'Close note' : 'Note'}
            </button>
            <button onClick={openDefinitionWindow} type="button">
              Define
            </button>
          </div>
          <div className="selection-menu__highlight-row">
            <span>Highlight</span>
            <div className="selection-menu__swatches">
              <button
                aria-label="Highlight in amber"
                className="selection-swatch amber"
                disabled={savingColor !== null}
                onClick={() => void saveHighlight('amber')}
                type="button"
              />
              <button
                aria-label="Highlight in rose"
                className="selection-swatch rose"
                disabled={savingColor !== null}
                onClick={() => void saveHighlight('rose')}
                type="button"
              />
              <button
                aria-label="Highlight in sky"
                className="selection-swatch sky"
                disabled={savingColor !== null}
                onClick={() => void saveHighlight('sky')}
                type="button"
              />
            </div>
          </div>

          {noteOpen ? (
            <div className="selection-note">
              <textarea
                autoFocus
                maxLength={500}
                onChange={(event) => setNoteText(event.target.value)}
                placeholder="Add a short note for this highlight..."
                rows={3}
                value={noteText}
              />
              <div className="selection-note__footer">
                <div className="selection-menu__swatches">
                  <button
                    aria-label="Save note with amber highlight"
                    className={`selection-swatch amber ${noteColor === 'amber' ? 'active' : ''}`}
                    onClick={() => setNoteColor('amber')}
                    type="button"
                  />
                  <button
                    aria-label="Save note with rose highlight"
                    className={`selection-swatch rose ${noteColor === 'rose' ? 'active' : ''}`}
                    onClick={() => setNoteColor('rose')}
                    type="button"
                  />
                  <button
                    aria-label="Save note with sky highlight"
                    className={`selection-swatch sky ${noteColor === 'sky' ? 'active' : ''}`}
                    onClick={() => setNoteColor('sky')}
                    type="button"
                  />
                </div>
                <button
                  className="primary-button selection-note__save"
                  disabled={savingColor !== null}
                  onClick={() => void saveNote()}
                  type="button"
                >
                  {savingColor === noteColor ? 'Saving...' : 'Save note'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="page-spread page-spread--continuous">
        {visiblePages.map((page, index) => (
          <div
            className={`paper-sheet ${index % 2 === 1 ? 'right' : ''}`}
            data-page-number={index + 1}
            key={`${page.start}-${page.end}`}
            ref={(node) => {
              pageRefs.current[index] = node
            }}
          >
            <div
              className="reader-sheet__content"
              onMouseUp={(event) =>
                captureSelection(page, event.currentTarget, event.clientX, event.clientY)
              }
              style={{ fontSize: `${fontScale}rem` }}
            >
              {buildSegments(page, highlights, spokenRange, focusRange).map((segment) => (
                <span
                  className={[
                    segment.color ? colorClass(segment.color) : '',
                    segment.focus ? 'reader-highlight-focus' : '',
                    segment.spoken ? 'narration-current' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  key={segment.key}
                >
                  {segment.text}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
