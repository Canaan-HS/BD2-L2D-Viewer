import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import externalModelsPlugin from './scripts/vite-plugin-external-models.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss(), externalModelsPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  base: './'
})
