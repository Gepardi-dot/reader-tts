/**
 * pdf.js 6's modern build expects APIs that WebKit only added recently
 * (some not until iOS 26.2). Without these, getDocument throws
 * "undefined is not a function (near '...')" on current Safari/iOS.
 *
 * Must be imported before pdfjs-dist so class-field initializers see them.
 */

type MapWithUpsert<K, V> = Map<K, V> & {
  getOrInsert: (key: K, value: V) => V
  getOrInsertComputed: (key: K, callback: (key: K) => V) => V
}

type WeakMapWithUpsert<K extends object, V> = WeakMap<K, V> & {
  getOrInsert: (key: K, value: V) => V
  getOrInsertComputed: (key: K, callback: (key: K) => V) => V
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return value != null && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
}

export function installPdfCompat() {
  const math = Math as typeof Math & { sumPrecise?: (values: Iterable<number>) => number }
  if (typeof math.sumPrecise !== 'function') {
    math.sumPrecise = function sumPrecise(values) {
      if (!isIterable(values)) return 0
      let total = 0
      for (const value of values) total += Number(value)
      return total
    }
  }

  const promiseCtor = Promise as typeof Promise & {
    try?: <T>(fn: (...args: unknown[]) => T, ...args: unknown[]) => Promise<Awaited<T>>
    withResolvers?: <T>() => {
      promise: Promise<T>
      resolve: (value: T | PromiseLike<T>) => void
      reject: (reason?: unknown) => void
    }
  }
  if (typeof promiseCtor.try !== 'function') {
    promiseCtor.try = function promiseTry(fn, ...args) {
      try {
        return Promise.resolve(fn(...args))
      } catch (error) {
        return Promise.reject(error)
      }
    }
  }
  if (typeof promiseCtor.withResolvers !== 'function') {
    promiseCtor.withResolvers = function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
  }

  const urlCtor = URL as typeof URL & {
    parse?: (url: string, base?: string | URL) => URL | null
  }
  if (typeof urlCtor.parse !== 'function') {
    urlCtor.parse = function parse(url, base) {
      try {
        return new URL(url, base)
      } catch {
        return null
      }
    }
  }

  const mapProto = Map.prototype as MapWithUpsert<unknown, unknown>
  if (typeof mapProto.getOrInsert !== 'function') {
    mapProto.getOrInsert = function getOrInsert(key, value) {
      if (this.has(key)) return this.get(key)
      this.set(key, value)
      return value
    }
  }
  if (typeof mapProto.getOrInsertComputed !== 'function') {
    mapProto.getOrInsertComputed = function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key)
      const value = callback(key)
      this.set(key, value)
      return value
    }
  }

  const weakMapProto = WeakMap.prototype as WeakMapWithUpsert<object, unknown>
  if (typeof weakMapProto.getOrInsert !== 'function') {
    weakMapProto.getOrInsert = function getOrInsert(key, value) {
      if (this.has(key)) return this.get(key)
      this.set(key, value)
      return value
    }
  }
  if (typeof weakMapProto.getOrInsertComputed !== 'function') {
    weakMapProto.getOrInsertComputed = function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key)
      const value = callback(key)
      this.set(key, value)
      return value
    }
  }
}

installPdfCompat()

export function collectPdfTextItems(items: unknown): string {
  if (!Array.isArray(items)) return ''
  const parts: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const textItem = item as { str?: unknown; hasEOL?: unknown }
    if (typeof textItem.str !== 'string' || !textItem.str) continue
    parts.push(textItem.str)
    if (textItem.hasEOL) parts.push('\n')
  }
  return parts.join(' ')
}

export function isPdfInfrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (!message) return true
  if (/no extractable text/i.test(message)) return false
  if (/password/i.test(message)) return false
  if (/invalid pdf/i.test(message)) return false
  return true
}

export function describePdfError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/password/i.test(message)) {
    return 'This PDF is password-protected. Remove the password and try again.'
  }
  if (/no extractable text/i.test(message)) {
    return message
  }
  if (
    /undefined is not a function/i.test(message)
    || /is not a function \(near/i.test(message)
    || /worker failed to start/i.test(message)
  ) {
    return (
      'This browser could not convert the PDF. Update Safari or Chrome, '
      + 'or export the file as EPUB/TXT and upload that instead.'
    )
  }
  return message || 'PDF extraction failed.'
}
