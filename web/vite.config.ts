import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Serve web-demuxer's WASM binary SAME-ORIGIN (the package defaults to a jsdelivr
// CDN URL, which is CORS-blocked and breaks offline/self-hosted installs).
// v4 bundles the JS glue into the package and only fetches the .wasm at runtime,
// so we only need to serve web-demuxer.wasm (no separate ffmpeg.js anymore).
// Dev: a middleware streams the file; build: it's emitted into dist/web-demuxer/.
function webDemuxerAssets(): Plugin {
  const files = ["web-demuxer.wasm"];
  const dir = (f: string) => fileURLToPath(new URL(`node_modules/web-demuxer/dist/wasm-files/${f}`, import.meta.url));
  return {
    name: "web-demuxer-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/web-demuxer\/(web-demuxer\.wasm)(\?.*)?$/);
        if (!m) return next();
        res.setHeader("Content-Type", "application/wasm");
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

// Serve onnxruntime-web's WASM runtime (jsep .mjs/.wasm) SAME-ORIGIN under /ort/.
// onnxruntime-web otherwise loads these from a jsdelivr CDN, which is blocked by
// our CSP/cross-origin isolation and breaks offline installs. clientOcr points
// ort.env.wasm.wasmPaths at /ort/ so the in-browser OCR runtime is fully local.
function onnxRuntimeAssets(): Plugin {
  const files = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
  const dir = (f: string) => fileURLToPath(new URL(`node_modules/onnxruntime-web/dist/${f}`, import.meta.url));
  const ctype = (f: string) => (f.endsWith(".wasm") ? "application/wasm" : "text/javascript");
  return {
    name: "onnxruntime-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/ort\/(ort-wasm-simd-threaded\.jsep\.(?:mjs|wasm))(\?.*)?$/);
        if (!m) return next();
        res.setHeader("Content-Type", ctype(m[1]));
        res.end(readFileSync(dir(m[1])));
      });
    },
    generateBundle() {
      for (const f of files) {
        this.emitFile({ type: "asset", fileName: `ort/${f}`, source: readFileSync(dir(f)) });
      }
    },
  };
}

// In dev, proxy /api to the Go API so cookies are same-origin (no CORS dance).
export default defineConfig({
  plugins: [react(), tailwindcss(), webDemuxerAssets(), onnxRuntimeAssets()],
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
