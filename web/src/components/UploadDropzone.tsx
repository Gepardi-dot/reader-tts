import { useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, RefObject } from 'react'

type UploadDropzoneProps = {
  containerRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  selectedFile: File | null
  uploading: boolean
  errorMessage?: string
  onFileSelected: (file: File | null) => void
  onUpload: () => void
  onOpenPicker: () => void
  onClearSelection: () => void
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function UploadDropzone({
  containerRef,
  inputRef,
  selectedFile,
  uploading,
  errorMessage,
  onFileSelected,
  onUpload,
  onOpenPicker,
  onClearSelection,
}: UploadDropzoneProps) {
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (!dragActive) {
      setDragActive(true)
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDragActive(false)
    onFileSelected(event.dataTransfer.files.item(0))
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    onFileSelected(event.target.files?.item(0) ?? null)
    event.target.value = ''
  }

  return (
    <aside
      className={`upload-dropzone ${dragActive ? 'is-dragging' : ''} ${selectedFile ? 'has-file' : ''}`}
      ref={containerRef}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <input
        accept=".pdf,application/pdf"
        className="upload-dropzone__input"
        onChange={handleInputChange}
        ref={inputRef}
        type="file"
      />

      <div className="upload-dropzone__header">
        <p className="eyebrow">Import</p>
        <h2>Add a book.</h2>
        <p>
          Drop a readable PDF here or browse for one.
        </p>
      </div>

      <div className="upload-dropzone__well">
        <div className="upload-dropzone__icon" aria-hidden="true">
          <span />
          <span />
        </div>

        {selectedFile ? (
          <div className="upload-dropzone__file">
            <strong>{selectedFile.name}</strong>
            <span>{formatFileSize(selectedFile.size)}</span>
          </div>
        ) : (
          <div className="upload-dropzone__empty">
            <strong>{dragActive ? 'Release to import this PDF' : 'Drop PDF here'}</strong>
            <span>Or choose a file manually.</span>
          </div>
        )}
      </div>

      <div className="upload-dropzone__actions">
        <button
          className="primary-button upload-dropzone__primary"
          disabled={uploading}
          onClick={selectedFile ? onUpload : onOpenPicker}
          type="button"
        >
          {uploading ? 'Importing...' : selectedFile ? 'Import now' : 'Choose PDF'}
        </button>
        <button
          className="secondary-button secondary-button--compact"
          disabled={uploading}
          onClick={onOpenPicker}
          type="button"
        >
          {selectedFile ? 'Replace file' : 'Browse files'}
        </button>
        {selectedFile ? (
          <button
            className="secondary-button secondary-button--compact"
            disabled={uploading}
            onClick={onClearSelection}
            type="button"
          >
            Clear
          </button>
        ) : null}
      </div>

      <small className="upload-dropzone__hint">
        Text-based PDFs work best.
      </small>
      {errorMessage ? <p className="upload-dropzone__error">{errorMessage}</p> : null}
    </aside>
  )
}
