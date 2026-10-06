import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

// GitHub Pages and the Android app cannot set HTTP headers, so the CSP is injected as a <meta> tag.
// Build only: the dev server needs inline scripts for hot reload. public/_headers covers hosts that can set headers.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://fcm.googleapis.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

const cspMeta: Plugin = {
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
}

export default defineConfig({
  plugins: [react(), cspMeta],
  base: './', // relative asset paths: works on GitHub Pages subpaths and inside the Android app
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', testTimeout: 30000 },
})
