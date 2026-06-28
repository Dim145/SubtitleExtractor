# Build the SPA, then serve it with nginx (which also proxies /api to the API,
# so the browser sees a single origin — no CORS in production).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Self-host the PP-OCRv6 small OCR models (used by in-browser extraction) into
# public/ so Vite copies them into dist/models. Lets browser OCR run offline and
# cross-origin-isolated (no third-party CDN at runtime). Downloaded here so it's
# reproducible in CI rather than depending on local files.
RUN apk add --no-cache curl \
 && mkdir -p public/models \
 && MB=https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main \
 && DB=https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main \
 && curl -fsSL "$MB/detection/ort/PP-OCRv6_small_det.ort"  -o public/models/PP-OCRv6_small_det.ort \
 && curl -fsSL "$MB/recognition/ort/PP-OCRv6_small_rec.ort" -o public/models/PP-OCRv6_small_rec.ort \
 && curl -fsSL "$DB/recognition/ppocrv6_dict.txt"           -o public/models/ppocrv6_dict.txt
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
# nginx serves /healthz (200); busybox wget ships in the nginx alpine base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1
