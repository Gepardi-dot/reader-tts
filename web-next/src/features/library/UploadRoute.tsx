import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Upload, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AuthError, BOOK_ACCEPT, isSupportedBookFile, uploadBook } from '@/shared/api/client'
import { signOut } from '@/lib/auth'
import {
  getModelStatus,
  subscribeModelStatus,
  type ModelState,
} from '@/shared/storage/modelCache'

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

  async function handleUpload() {
    if (!file) return
    setUploading(true)
    setError('')
    setProgressMessage('Preparing book...')
    setProgressValue(0)
    try {
      const book = await uploadBook(file, null, {
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
    if (isSupportedBookFile(dropped)) {
      setFile(dropped)
      setError('')
    } else {
      setError('Unsupported format. Upload PDF, TXT, Markdown, or HTML.')
    }
  }

  return (
    <div className="p-6 max-w-lg mx-auto pt-12">
      <h1 className="text-xl font-semibold text-foreground mb-6">Upload a book</h1>

      {/* Drop zone */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cn(
          'w-full rounded-xl border-2 border-dashed p-12 flex flex-col items-center gap-4 transition-colors cursor-pointer',
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
                {(file.size / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
          </>
        ) : (
          <>
            <Upload size={40} className="text-muted-foreground/60" />
            <div className="text-center">
              <p className="font-medium text-foreground">Drop a book here</p>
              <p className="text-sm text-muted-foreground mt-1">PDF, TXT, Markdown, or HTML</p>
            </div>
          </>
        )}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={BOOK_ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const selected = e.target.files?.[0] ?? null
          if (!selected) {
            setFile(null)
            return
          }
          if (isSupportedBookFile(selected)) {
            setFile(selected)
            setError('')
          } else {
            setFile(null)
            setError('Unsupported format. Upload PDF, TXT, Markdown, or HTML.')
          }
        }}
      />

      {error && <p className="text-sm text-destructive mt-3">{error}</p>}

      <div className="mt-4 flex gap-3">
        <Button
          className="flex-1"
          disabled={!file || uploading}
          onClick={handleUpload}
        >
          {uploading ? progressMessage || 'Uploading...' : 'Upload'}
        </Button>
        {file && (
          <Button variant="outline" onClick={() => setFile(null)}>
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
