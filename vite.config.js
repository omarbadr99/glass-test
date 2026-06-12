import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative base so the build works both locally (npm run preview)
  // and when served from a GitHub Pages project subpath.
  base: './',
  plugins: [react()],
})
