import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  ssr: {
    // React must be external in the Nitro server bundle (FEN-463).
    external: ['react', 'react-dom'],
  },
  plugins: [
    devtools(),
    nitro(),
    tailwindcss(),
    tanstackStart({ srcDirectory: 'app' }),
    viteReact(),
  ],
})

export default config
