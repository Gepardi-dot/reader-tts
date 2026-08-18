declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export class WorkerMessageHandler {
    static setup(handler: unknown, port: unknown): void
  }
}

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export class WorkerMessageHandler {
    static setup(handler: unknown, port: unknown): void
  }
}

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist'
}
