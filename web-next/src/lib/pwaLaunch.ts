/**
 * File Handling API / OS "Open with HiggsRead" handoff.
 * Files stay in memory until UploadRoute consumes them — never Cache Storage.
 */

type ArrivalListener = () => void

let pending: File[] = []
const arrival = new Set<ArrivalListener>()

export function queueLaunchFiles(files: File[]): void {
  const next = files.filter((file) => file instanceof File)
  if (!next.length) return
  pending = next
  for (const listener of arrival) listener()
}

export function takeLaunchFiles(): File[] {
  const files = pending
  pending = []
  return files
}

export function peekLaunchFiles(): File[] {
  return pending.slice()
}

export function subscribeLaunchArrival(listener: ArrivalListener): () => void {
  arrival.add(listener)
  return () => {
    arrival.delete(listener)
  }
}

export function initLaunchQueue(): void {
  if (typeof window === 'undefined') return
  const launchQueue = (
    window as Window & {
      launchQueue?: {
        setConsumer: (
          consumer: (params: { files?: FileSystemFileHandle[] }) => void | Promise<void>,
        ) => void
      }
    }
  ).launchQueue
  if (!launchQueue?.setConsumer) return

  launchQueue.setConsumer(async (params) => {
    const files: File[] = []
    for (const handle of params.files ?? []) {
      try {
        if (handle && typeof handle.getFile === 'function') {
          files.push(await handle.getFile())
        }
      } catch {
        // Skip a handle the OS revoked.
      }
    }
    queueLaunchFiles(files)
  })
}
