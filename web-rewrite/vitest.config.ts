import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // Only run tests in our own src/ tree.
    // Explicit include prevents Vitest from picking up test files that some
    // npm packages (zod, react-pdf, merge-refs) ship inside node_modules/.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'tests/**'],
  },
})
