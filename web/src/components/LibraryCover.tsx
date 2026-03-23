import { useEffect, useRef, useState } from 'react'
import { pdfjs } from 'react-pdf'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type LibraryCoverProps = {
  sourceUrl: string
  title: string
}

const COVER_WIDTH = 240
const COVER_HEIGHT = 352

export function LibraryCover({ sourceUrl, title }: LibraryCoverProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null

    async function renderCover() {
      try {
        setReady(false)
        loadingTask = pdfjs.getDocument(sourceUrl)
        const pdf = await loadingTask.promise
        const page = await pdf.getPage(1)
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.max(COVER_WIDTH / baseViewport.width, COVER_HEIGHT / baseViewport.height)
        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas || cancelled) {
          return
        }

        const context = canvas.getContext('2d')
        if (!context) {
          return
        }

        const ratio = window.devicePixelRatio || 1
        canvas.width = Math.floor(COVER_WIDTH * ratio)
        canvas.height = Math.floor(COVER_HEIGHT * ratio)
        canvas.style.width = `${COVER_WIDTH}px`
        canvas.style.height = `${COVER_HEIGHT}px`

        const scratchCanvas = document.createElement('canvas')
        scratchCanvas.width = Math.floor(viewport.width * ratio)
        scratchCanvas.height = Math.floor(viewport.height * ratio)
        const scratchContext = scratchCanvas.getContext('2d')
        if (!scratchContext) {
          return
        }
        scratchContext.setTransform(ratio, 0, 0, ratio, 0, 0)

        renderTask = page.render({
          canvas: scratchCanvas,
          canvasContext: scratchContext,
          viewport,
        })

        await renderTask.promise

        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'

        const sourceAspect = scratchCanvas.width / scratchCanvas.height
        const targetAspect = canvas.width / canvas.height
        let sourceX = 0
        let sourceY = 0
        let sourceWidth = scratchCanvas.width
        let sourceHeight = scratchCanvas.height

        if (sourceAspect > targetAspect) {
          sourceWidth = scratchCanvas.height * targetAspect
          sourceX = (scratchCanvas.width - sourceWidth) / 2
        } else if (sourceAspect < targetAspect) {
          sourceHeight = scratchCanvas.width / targetAspect
          sourceY = (scratchCanvas.height - sourceHeight) / 2
        }

        context.drawImage(
          scratchCanvas,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          canvas.width,
          canvas.height,
        )

        if (!cancelled) {
          setReady(true)
        }
      } catch {
        if (!cancelled) {
          setReady(false)
        }
      }
    }

    void renderCover()

    return () => {
      cancelled = true
      renderTask?.cancel()
      loadingTask?.destroy()
    }
  }, [sourceUrl])

  return (
    <div className={`library-cover ${ready ? 'ready' : 'fallback'}`}>
      <canvas aria-hidden={!ready} ref={canvasRef} />
      {!ready ? (
        <div className="library-cover__fallback">
          <span>{title}</span>
        </div>
      ) : null}
    </div>
  )
}
