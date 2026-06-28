import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Serve web-demuxer's ffmpeg WASM demuxer SAME-ORIGIN (the package defaults to a
// jsdelivr CDN URL, which is CORS-blocked and breaks offline/self-hosted installs).
// Dev: a middleware streams the files; build: they're emitted into dist/web-demuxer/.
function webDemuxerAssets(): Plugin {
  const files = ["ffmpeg.js", "ffmpeg.wasm"];
  const dir = (f: string) => fileURLToPath(new URL(`node_modules/web-demuxer/dist/wasm-files/${f}`, import.meta.url));
  return {
    name: "web-demuxer-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/web-demuxer\/(ffmpeg\.js|ffmpeg\.wasm)(\?.*)?$/);
        if (!m) return next();
        res.setHeader("Content-Type", m[1].endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.end(readFileSync(dir(m[1])));
      });
    },
    generateBundle() {
      for (const f of files) {
        this.emitFile({ type: "asset", fileName: `web-demuxer/${f}`, source: readFileSync(dir(f)) });
      }
    },
  };
}

// In dev, proxy /api to the Go API so cookies are same-origin (no CORS dance).
export default defineConfig({
  plugins: [react(), tailwindcss(), webDemuxerAssets()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
