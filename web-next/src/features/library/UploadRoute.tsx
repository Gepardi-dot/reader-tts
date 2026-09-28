import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Upload, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  AuthError,
  bookFileInputAccept,
  bookFormatsHelpText,
  isSupportedBookFile,
  unsupportedBookMessage,
  uploadBook,
} from '@/shared/api/client'
import { signOut } from '@/lib/auth'
import {
  getModelStatus,
  subscribeModelStatus,
  type ModelState,
} from '@/shared/storage/modelCache'
import { subscribeLaunchArrival, takeLaunchFiles } from '@/lib/pwaLaunch'

export function UploadRoute() {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [progressMessage, setProgressMessage] = useState('')
  const [progressValue, setProgressValue] = useState(0)
  const [drag, setDrag] = useState(false)
  const [modelState, setModelState] = useState<ModelState>(() => getModelStatus())
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  useEffect(() => subscribeModelStatus(setModelState), [])

  useEffect(() => {
    const applyLaunchFiles = () => {
      const launched = takeLaunchFiles()
      if (!launched.length) return
      const next = launched.find((item) => {
        const ext = item.name.includes('.') ? (item.name.split('.').pop()?.toLowerCase() ?? '') : ''
        if (/^(png|jpe?g|gif|webp|heic|mp3|m4a|wav|mp4|mov)$/.test(ext)) return false
        return isSupportedBookFile(item) || item.size > 0
      })
      if (next) {
        setFile(next)
        setError('')
        return
      }
      setError(unsupportedBookMessage())
    }
    applyLaunchFiles()
    return subscribeLaunchArrival(applyLaunchFiles)
  }, [])

  async function handleUpload() {
    if (!file) return
    setUploading(true)
    setError('')
    setProgressMessage('Converting to EPUB...')
    setProgressValue(0)
    try {
      const { book } = await uploadBook(file, null, {
        convertToEpub: true,
        onProgress: (progress) => {
          setProgressMessage(progress.message)
          setProgressValue(progress.progress)
        },
      })
      queryClient.setQueryData<unknown[]>(['books'], (current) => {
        const items = Array.isArray(current) ? current : []
        return [book, ...items.filter((item) => {
          return typeof item === 'object' && item !== null && 'id' in item
            ? item.id !== book.id
            : true
        })]
      })
      queryClient.invalidateQueries({ queryKey: ['books'] })
      navigate(`/book/${book.id}`)
    } catch (e) {
      if (e instanceof AuthError) {
        await signOut()
        navigate('/login', { replace: true })
        return
      }
      if (e instanceof TypeError && /fetch/i.test(e.message)) {
        setError('API is unreachable. Check the Cloudflare Worker or local Worker dev server and try again.')
      } else if (e instanceof TypeError && /undefined is not a function/i.test(e.message)) {
        setError(
          'This browser could not convert the file. Update Safari or Chrome, '
          + 'or export it as EPUB/TXT and upload that instead.',
        )
      } else {
        setError(e instanceof Error ? e.message : 'Upload failed')
      }
    } finally {
      setUploading(false)
      setProgressMessage('')
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDrag(false)
    const dropped = e.dataTransfer.files[0]
    if (!dropped) return
    const ext = dropped.name.includes('.')
      ? (dropped.name.split('.').pop()?.toLowerCase() ?? '')
      : ''
    if (/^(png|jpe?g|gif|webp|heic|mp3|m4a|wav|mp4|mov)$/.test(ext)) {
      setError(unsupportedBookMessage())
      return
    }
    if (isSupportedBookFile(dropped) || dropped.size > 0) {
      setFile(dropped)
      setError('')
    } else {
      setError(unsupportedBookMessage())
    }
  }

  return (
    <div className="p-6 max-w-lg mx-auto pt-12">
      <h1 className="text-xl font-semibold text-foreground mb-2">Upload a book</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Any supported file is converted to <span className="font-medium text-foreground">EPUB</span> in
        your browser, then opened for reading and TTS.
      </p>

      {/* Drop zone. The input covers the control so iOS receives the tap directly.
          A scripted click on a clipped input fails for EPUB, Kindle, and FB2. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cn(
          'relative w-full rounded-xl border-2 border-dashed p-12 flex flex-col items-center gap-4 transition-colors cursor-pointer',
          drag ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-muted/50',
          file && 'border-primary/40 bg-primary/5',
        )}
      >
        {file ? (
          <>
            <FileText size={40} className="text-primary" />
            <div className="text-center">
              <p className="font-medium text-foreground">{file.name}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {(file.size / 1024 / 1024).toFixed(1)} MB · will convert to EPUB
              </p>
            </div>
          </>
        ) : (
          <>
            <Upload size={40} className="text-muted-foreground/60" />
            <div className="text-center">
              <p className="font-medium text-foreground">Drop a book here</p>
              <p className="text-sm text-muted-foreground mt-1">{bookFormatsHelpText()}</p>
            </div>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={bookFileInputAccept()}
          aria-label="Choose a book file"
          className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          onChange={(e) => {
            const selected = e.target.files?.[0] ?? null
            e.target.value = ''
            if (!selected) return
            const ext = selected.name.includes('.')
              ? (selected.name.split('.').pop()?.toLowerCase() ?? '')
              : ''
            // Photos and audio are never books. Missing or uncommon extensions
            // stay selected so Kindle/EPUB/FB2 can be sniffed after iOS renames them.
            if (/^(png|jpe?g|gif|webp|heic|mp3|m4a|wav|mp4|mov)$/.test(ext)) {
              setFile(null)
              setError(unsupportedBookMessage())
              return
            }
            setFile(selected)
            setError('')
          }}
        />
      </div>

      {error && <p className="text-sm text-destructive mt-3">{error}</p>}

      <div className="mt-4 flex gap-3">
        <Button
          className="flex-1"
          disabled={!file || uploading}
          onClick={handleUpload}
        >
          {uploading ? progressMessage || 'Converting…' : 'Convert to EPUB & open'}
        </Button>
        {file && (
          <Button variant="outline" onClick={() => setFile(null)} disabled={uploading}>
            Clear
          </Button>
        )}
      </div>

      {uploading && progressMessage && (
        <div className="mt-3 space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.max(4, Math.min(100, progressValue))}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">{progressMessage}</p>
        </div>
      )}

      {modelState.status === 'downloading' && (
        <p className="text-xs text-muted-foreground mt-3">
          Preparing on-device voice ({modelState.progress}%)…
        </p>
      )}
      {modelState.status === 'ready' && (
        <p className="text-xs text-muted-foreground mt-3">
          On-device voice ready · audio will play instantly
        </p>
      )}
    </div>
  )
}
