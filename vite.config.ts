import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    entries: ["index.html"]
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    watch: {
      ignored: ["**/data/**", "**/outputs/**", "**/benchmarks/output/**"]
    },
    proxy: {
      "/api": "http://127.0.0.1:3001"
    }
  }
});
