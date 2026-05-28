import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: __dirname,
  base: "/dashboard/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  server: {
    proxy: {
      "/admin": "http://127.0.0.1:3100",
      "/health": "http://127.0.0.1:3100",
      "/ready": "http://127.0.0.1:3100",
      "/metrics": "http://127.0.0.1:3100",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../../dist/dashboard"),
    emptyOutDir: true,
  },
})
