import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiPort = process.env.PORT || "3001";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
      "/socket.io": {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: path.join(__dirname, "..", "dist"),
    emptyOutDir: true,
  },
});
