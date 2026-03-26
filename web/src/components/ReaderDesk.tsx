import { useEffect, useMemo, useRef, useState } from 'react'
import type { Highlight, HighlightColor } from '../types'
import { paginateReaderText, type ReaderPage } from './readerPagination'

type ReaderDeskProps = {
  text: string
  highlights: Highlight[]
  canPlayFromSelection?: boolean
  initialFontScale?: number
  narrationFocusRequest?: number
  spokenRange?: {
    start: number
    end: number
  } | null
  title: string
  initialPageNumber?: number
  onProgressChange?: (payload: {
    pageNumber: number
    totalPages: number
    textStart: number
    textEnd: number
    textLength: number
  }) => void
  onFontScaleChange?: (fontScale: number) => void
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
) {
  const segments: Array<{
    text: string
    color: HighlightColor | null
    spoken: boolean
    key: string
  }> = []
  const relevant = highlights
    .filter((item) => item.end > page.start && item.start < page.end)
    .sort((left, right) => left.start - right.start)
  const spokenStart = spokenRange ? Math.max(spokenRange.start, page.start) : null
  const spokenEnd = spokenRange ? Math.min(spokenRange.end, page.end) : null
  const boundaries = new Set([page.start, page.end])

  for (const item of relevant) {
    boundaries.add(Math.max(item.start, page.start))
    boundaries.add(Math.min(item.end, page.end))
  }

  if (spokenStart !== null && spokenEnd !== null && spokenEnd > spokenStart) {
    boundaries.add(spokenStart)
    boundaries.add(spokenEnd)
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

    segments.push({
      text: page.text.slice(segmentStart - page.start, segmentEnd - page.start),
      color,
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
  narrationFocusRequest = 0,
  spokenRange,
  title,
  initialPageNumber = 1,
  onProgressChange,
  onFontScaleChange,
  onCreateHighlight,
  onPlayFromSelection,
}: ReaderDeskProps) {
  const [pageNumber, setPageNumber] = useState(1)
  const [fontScale, setFontScale] = useState(initialFontScale)
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

  const pages = useMemo(() => paginateReaderText(text), [text])
  const lastVisiblePage = pages.length

  useEffect(() => {
    setPageNumber(Math.min(Math.max(1, initialPageNumber), Math.max(1, pages.length)))
    setDraft(null)
  }, [initialPageNumber, pages.length, text])

  useEffect(() => {
    setFontScale(initialFontScale)
  }, [initialFontScale])

  useEffect(() => {
    progressChangeRef.current = onProgressChange
  }, [onProgressChange])

  useEffect(() => {
    fontScaleChangeRef.current = onFontScaleChange
  }, [onFontScaleChange])

  useEffect(() => {
    fontScaleChangeRef.current?.(fontScale)
  }, [fontScale])

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

  function scrollToPage(targetPage: number) {
    const safePage = Math.min(Math.max(1, targetPage), pages.length)
    const node = pageRefs.current[safePage - 1]
    if (!node) {
      return
    }

    const top = node.getBoundingClientRect().top + window.scrollY - 112
    window.scrollTo({
      top: Math.max(0, top),
      behavior: 'smooth',
    })
    setPageNumber(safePage)
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

  const visiblePages = pages

  return (
    <div className="reader-desk">
      <div className="book-stage__desk" />
      <div className="book-stage__meta">
        <div>
          <strong>{title}</strong>
          <p>Reader page {pageNumber} of {pages.length}</p>
        </div>

        <div className="reader-desk__actions">
          <label className="reader-desk__scale">
            <span>Type size</span>
            <input
              max={1.25}
              min={0.9}
              onChange={(event) => setFontScale(Number(event.target.value))}
              step={0.05}
              type="range"
              value={fontScale}
            />
          </label>

          <div className="book-stage__actions">
            <button
              disabled={pageNumber <= 1}
              onClick={() => scrollToPage(pageNumber - 1)}
              type="button"
            >
              Previous
            </button>
            <button
              disabled={pageNumber >= lastVisiblePage}
              onClick={() => scrollToPage(pageNumber + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <div className="reader-tip">
        <strong>{draft ? 'Selection ready' : 'Reader mode'}</strong>
        <p>
          {draft
            ? canPlayFromSelection
              ? 'Use the floating menu to play from here, highlight, attach a note, or open a quick definition search.'
              : 'Set up a ready voice in Audio controls to use Play here. You can still highlight, add a note, or open a quick definition search.'
            : 'Scroll naturally through the book, then click a word or select a passage to open the playback and highlight menu.'}
        </p>
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
              {buildSegments(page, highlights, spokenRange).map((segment) => (
                <span
                  className={[
                    segment.color ? colorClass(segment.color) : '',
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
