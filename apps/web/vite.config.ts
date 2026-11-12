import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend calls the backend only via relative "/api/..." paths (design
// spec #6, constraint 3) so it works unchanged in a browser tab or an
// embedded webview after Electron packaging. The dev proxy below exists
// only to make relative paths work during local development.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.ELENCHI_SERVER_URL ?? "http://127.0.0.1:4000",
        changeOrigin: true,
      },
    },
  },
});
