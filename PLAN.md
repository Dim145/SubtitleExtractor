# SubtitleExtractor — Plan d'architecture & roadmap

> Extraction de sous-titres **hardcodés** (incrustés) depuis des vidéos (mp4/mkv) par OCR,
> avec édition des sous-titres dans le navigateur. Application web conteneurisée.

Décisions cadrées :
- **Périmètre v1 : serveur d'abord (MVP complet)** — upload → traitement worker → édition navigateur → téléchargement.
- **Premier worker : macOS Apple Silicon** (natif, hors Docker). Worker NVIDIA ajouté ensuite.
- **OCR multi-backend configurable** (PP-OCRv5 léger *et* PaddleOCR-VL SOTA, choisi par env/job).
- **API en Go**. Frontend React. Worker en Python.
- Client-side navigateur = **phase ultérieure**, en option « clips courts / confidentialité ».

---

## 1. Vue d'ensemble de l'architecture

```
                            ┌─────────────────────────────────────────┐
                            │          Frontend (React + Vite)         │
                            │  - Auth (local + OIDC)                    │
                            │  - Upload vidéo + paramètres OCR          │
                            │  - Suivi temps réel (SSE: progress/logs)  │
                            │  - Éditeur ASS (JASSUB + wavesurfer.js)   │
                            │  - Téléchargement résultats (srt/ass/vtt) │
                            └───────────────────┬─────────────────────┘
                                                │ HTTPS (REST + SSE)
                            ┌───────────────────▼─────────────────────┐
                            │            API — Go (chi)                 │
                            │  - Auth/session, OIDC, comptes locaux     │
                            │  - Upload → stockage, création job        │
                            │  - File de jobs (River sur Postgres)      │
                            │  - SSE progress/logs                      │
                            │  - /internal claim API (bearer token)     │
                            └──────┬───────────────┬───────────────────┘
                                   │               │
              ┌────────────────────▼──┐   ┌────────▼──────────────────────┐
              │   Postgres 16          │   │  Stockage (interface Go)       │
              │  users, jobs,          │   │  - local-fs  OU                │
              │  job_results, job_logs │   │  - S3 / MinIO  (env)           │
              │  + tables River        │   │  presigned URLs                │
              └────────────────────────┘   └────────────────────────────────┘
                                   ▲ claim / heartbeat / progress / complete
                   ┌───────────────┴───────────────────┐
                   │                                    │
   ┌───────────────▼──────────────┐      ┌──────────────▼─────────────────┐
   │  Worker macOS (PHASE 1)       │      │  Worker NVIDIA (PHASE 2)        │
   │  - natif (launchd), hors      │      │  - Docker + nvidia-toolkit      │
   │    Docker (GPU Metal/ANE)     │      │  - ffmpeg NVDEC                 │
   │  - Python: pipeline commun    │      │  - Python: même pipeline        │
   │  - backend OCR: RapidOCR /    │      │  - backend OCR: PP-OCRv5 ou     │
   │    PaddleOCR-VL (MLX)         │      │    PaddleOCR-VL (vLLM/CUDA)     │
   └───────────────────────────────┘      └─────────────────────────────────┘
```

**Principe clé** : le worker n'est pas couplé à la file de jobs. Il est un **client HTTP** d'un
protocole `claim / heartbeat / progress / complete`. L'API Go est la seule à parler à River.
→ Cela permet au worker macOS de tourner **nativement hors Docker** (obligatoire : Docker sur
macOS n'accède pas au GPU Apple) et d'ajouter le worker NVIDIA sans toucher l'API.

---

## 2. Pile technologique

| Couche | Choix | Raison |
|---|---|---|
| Frontend | **React + Vite + TypeScript** | Meilleur support des libs d'édition de sous-titres |
| UI | Tailwind + composants légers (shadcn/ui optionnel) | Rapidité |
| Éditeur sous-titres | **ass-compiler** (modèle ASS), **subtitle.js** (SRT/VTT), **JASSUB** (rendu libass-wasm), **wavesurfer.js** + `@wavesurfer/react` (timeline/waveform) | Tous MIT/BSD, fidélité ASS |
| API | **Go** + **chi** | I/O-bound orchestrateur, écosystème mûr |
| File de jobs | **Table `jobs` Postgres** (`FOR UPDATE SKIP LOCKED`) | Workers externes/polyglottes via protocole HTTP → River (lib Go) n'apporte rien ici ; la table = file transactionnelle sans broker. *(décision M2, remplace River)* |
| DB | **Postgres 16** | jobs/users/results/logs + queue |
| Accès DB | **pgx** + **sqlc** + **golang-migrate** | SQL vérifié à la compilation |
| Auth | **coreos/go-oidc** + `x/oauth2` ; **argon2id** (local) | Standards 2026 |
| Stockage | interface Go → **local-fs** ou **S3/MinIO** (`minio-go`) | Configurable par env |
| Temps réel | **SSE** | Flux serveur→client unidirectionnel, simple, traverse les proxies |
| Worker | **Python** (pipeline ffmpeg + OCR) | Écosystème OCR/PaddleOCR |
| OCR backends | **RapidOCR (ONNX/CoreML)**, **PP-OCRv5**, **PaddleOCR-VL (MLX/vLLM)** | Multi-backend configurable |
| Conteneurisation | **docker-compose** (+ nvidia-container-toolkit pour le worker GPU) | |

### Go : librairies
`go-chi/chi/v5`, `jackc/pgx/v5`, `sqlc-dev/sqlc`, `golang-migrate/migrate`,
`riverqueue/river`, `coreos/go-oidc/v3`, `golang.org/x/oauth2`, `golang-jwt/jwt/v5`,
`alexedwards/argon2id`, `minio/minio-go/v7` (ou `aws-sdk-go-v2`), `caarlos0/env`.

---

## 3. Le pipeline OCR (cœur du produit)

La valeur n'est pas l'appel OCR mais **la boucle de frames + le merge temporel**.
Base de référence à étudier/forker : **timminator/VideOCR** (MIT — a déjà SSIM-skip,
merge Levenshtein, sortie ASS positionnée).

```
1. Région sous-titres   : crop (bbox utilisateur OU détection auto bas de cadre ~20-30%)
2. Décodage frames      : ffmpeg, échantillonnage (fps configurable). macOS: -hwaccel videotoolbox.
                          NVIDIA: -hwaccel cuda -hwaccel_output_format cuda (NVDEC, crop AVANT download)
3. Skip par SSIM        : si SSIM(frame_n, frame_n-1) > seuil → réutiliser l'OCR précédent
                          (gros gain de vitesse + détecte les frontières de cues)
4. OCR                  : backend choisi (RapidOCR / PP-OCRv5 / PaddleOCR-VL) sur la bande croppée
5. Dédup / merge        : grouper frames consécutives si ratio Levenshtein ≥ seuil (~80) ;
                          garder la variante à meilleure confiance ; combler petits gaps (~0.09s)
6. Timing               : start = idx_premier/fps ; end = idx_dernier/fps
                          (précision frame-accurate si fps d'échantillonnage = fps vidéo)
7. Style / position     : depuis bbox OCR → \an (grille 3x3) ou \pos(x,y) [FIABLE]
                          taille police ← hauteur bbox [APPROX] ; couleur ← pixels glyphes [PEU FIABLE]
8. Écriture             : ASS (format maître, garde position/style) → conversion SRT/VTT
```

**Extraction de style — attentes réalistes :**
- ✅ **Position** (`\an`/`\pos`) : fiable, vient directement de la bbox.
- 🟡 **Taille** : estimée depuis la hauteur de bbox, approximative.
- 🟠 **Couleur du texte** : échantillonnage des pixels du glyphe, peu fiable (dégradés, anti-aliasing).
- ❌ **Police, gras/italique, karaoké, animations** : non récupérables.
- → Tout style extrait est une **valeur par défaut éditable** dans l'éditeur, pas une vérité.

### Backends OCR (configurable par env/job)
| Backend | Cible | VRAM | Notes |
|---|---|---|---|
| **RapidOCR (ONNX, CoreML exp.)** | macOS + CPU | faible | Voie la plus fiable et propre sur Mac (démarrage) |
| **PP-OCRv5 / v6** | NVIDIA + CPU | faible | Rapide, léger, multilingue |
| **PaddleOCR-VL 1.6** | NVIDIA (vLLM) / macOS (MLX) | ~2 Go | SOTA précision ; latence/VRAM plus élevées |

Choix par variable `OCR_BACKEND` et/ou par paramètre de job (`params.ocr_backend`).

---

## 4. Schéma base de données (esquisse)

```sql
create type auth_provider as enum ('local','oidc');
create type job_status   as enum ('queued','claimed','running','succeeded','failed','canceled');

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  provider auth_provider not null,
  password_hash text,                 -- argon2id (local), null si oidc
  oidc_issuer text, oidc_subject text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  unique (oidc_issuer, oidc_subject)
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  status job_status not null default 'queued',
  worker_class text not null default 'any',     -- 'gpu-nvidia' | 'macos' | 'any'
  source_filename text not null,
  input_key text not null,                       -- clé stockage de la vidéo
  params jsonb not null default '{}',            -- langue, crop box, fps, ocr_backend, format(s)...
  progress_pct smallint not null default 0,
  progress_stage text,
  claimed_by text, claimed_at timestamptz, last_heartbeat timestamptz,
  attempt int not null default 0,
  error_message text,
  river_job_id bigint,
  created_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz
);
create index on jobs (status, worker_class);
create index on jobs (user_id, created_at desc);

create table job_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  kind text not null,                            -- 'ass' | 'srt' | 'vtt' | 'json' | 'preview'
  storage_key text not null,
  language text, byte_size bigint, sha256 text,
  created_at timestamptz not null default now()
);

create table job_logs (
  id bigserial primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  ts timestamptz not null default now(),
  level text not null default 'info',
  message text not null
);
create index on job_logs (job_id, id);          -- SSE: WHERE id > $cursor
```

---

## 5. Protocole worker (claim / heartbeat / complete)

API `/internal/*`, protégée par `INTERNAL_API_TOKEN` (bearer) — jamais exposée publiquement.

```
POST /internal/jobs/claim?worker_class=macos     → job + URL presignée de la vidéo d'entrée
POST /internal/jobs/{id}/progress  {pct, stage, log_line}   (répété)
POST /internal/jobs/{id}/heartbeat                          (périodique → détection worker mort)
PUT  /internal/jobs/{id}/result   (upload .ass/.srt/.vtt ou déclare la clé stockage)
POST /internal/jobs/{id}/complete {status: success|failure, error?}
```

- L'API marque `running` à la claim, ack/erreur le job River à `complete`.
- Si pas de heartbeat dans le délai → ré-enqueue (tolérance aux pannes worker).
- `worker_class` route le travail : le Mac ne prend que `macos`/`any`, le NVIDIA `gpu-nvidia`/`any`.

---

## 6. Stockage & Auth (configurables par env)

### Stockage — interface Go unique
```
STORAGE_BACKEND=local|s3
# local
STORAGE_LOCAL_ROOT=/data/blobs
# s3 / minio / r2
STORAGE_S3_ENDPOINT=...   STORAGE_S3_BUCKET=...   STORAGE_S3_REGION=...
STORAGE_S3_ACCESS_KEY=... STORAGE_S3_SECRET_KEY=... STORAGE_S3_FORCE_PATH_STYLE=true
```
- S3 : `PresignGet` = vraie URL presignée (téléchargement direct, sans proxy API).
- local : `PresignGet` = URL signée `/files/{token}` servie par l'API (range requests).
- ⚠️ **Multi-machines (Mac + serveur API séparés) ⇒ S3/MinIO obligatoire** (le Mac ne voit pas le FS du serveur).

### Auth
```
AUTH_LOCAL_ENABLED=true   AUTH_OIDC_ENABLED=true
OIDC_ISSUER_URL=...  OIDC_CLIENT_ID=...  OIDC_CLIENT_SECRET=...  OIDC_REDIRECT_URL=...
OIDC_SCOPES=openid,email,profile
JWT_SIGNING_KEY=...  SESSION_TTL=24h
```
- Les deux flux convergent vers une ligne `users` + session signée (cookie httpOnly).
- Local = argon2id. OIDC = Authorization Code + PKCE (`go-oidc`), upsert par `(issuer, subject)`.

---

## 7. Conteneurisation & topologie

### Phase 1 (Mac) — dev local
```
docker-compose : api, postgres, (minio optionnel)
worker macOS   : natif via launchd, venv Python, pointe vers l'API
```
Pour le dev tout-en-un sur le Mac, le stockage local-fs suffit **si** l'API et le worker partagent
le même FS. Dès qu'ils sont sur des machines différentes → MinIO/S3.

### Phase 2 (NVIDIA)
```
docker-compose (host Linux) : api, postgres, minio, nvidia-worker
nvidia-worker : base nvidia/cuda, ffmpeg --enable-nvdec, NVIDIA_DRIVER_CAPABILITIES=compute,utility,video
                deploy.resources.reservations.devices: [gpu, compute, video]
```

---

## 8. Frontend — éditeur de sous-titres

Layout 3 zones : **aperçu vidéo** (overlay ASS live via JASSUB) + **liste de cues** (table éditable,
source de vérité) + **timeline waveform** (wavesurfer, 1 région = 1 cue, drag/resize du timing).

Fonctions : édition inline texte/timing, split/merge cue, ripple-shift, gestionnaire de styles ASS
(`[V4+ Styles]`), poignée de position sur la vidéo → `\pos`, grille 3×3 → `\an`.
Import/export ASS (canonique) ↔ SRT/VTT.

---

## 9. Phase ultérieure — traitement client-side (option)

À proposer plus tard comme option « confidentialité / clips courts », **gated** :
- Stack : **web-demuxer** (MKV) → **WebCodecs** (décodage matériel) → échantillonnage + dédup →
  crop bande → **`ppu-paddle-ocr`** (PP-OCRv5 INT8) sur **onnxruntime-web / WebGPU** → SRT/ASS.
- Contraintes : **WebGPU requis**, clips **≤ ~5–10 min**, HEVC = fallback ffmpeg.wasm (lent),
  streamer et `.close()` les frames (mémoire WASM ~4 Go).
- Ne PAS faire : ffmpeg.wasm + Tesseract.js (le plus lent + le moins précis).

---

## 10. Structure du dépôt (proposée)

```
SubtitleExtractor/
├─ docker-compose.yml              # api + postgres + minio (+ nvidia-worker en phase 2)
├─ .env.example
├─ api/                            # Go
│  ├─ cmd/api/main.go
│  ├─ internal/{http,auth,jobs,storage,db,sse,config}/
│  ├─ db/migrations/               # golang-migrate
│  └─ db/queries/                  # sqlc
├─ worker/                         # Python (pipeline commun)
│  ├─ pyproject.toml
│  ├─ subextractor/
│  │  ├─ pipeline.py               # crop, ffmpeg, SSIM-skip, OCR, merge, write
│  │  ├─ backends/{rapidocr,ppocr,paddleocr_vl}.py
│  │  ├─ client.py                 # claim/heartbeat/progress/complete
│  │  └─ formats/{ass,srt,vtt}.py
│  ├─ Dockerfile.nvidia            # phase 2
│  └─ run-macos.sh / launchd.plist # phase 1
├─ web/                            # React + Vite
│  └─ src/{auth,upload,jobs,editor}/
└─ PLAN.md                         # ce document
```

---

## 11. Roadmap par jalons

**M1 — Socle API + auth + DB**
docker-compose (api+postgres), migrations, comptes locaux + OIDC, sessions, healthcheck.

**M2 — Upload + jobs + stockage**
Endpoint upload (stream → stockage), interface stockage local/S3, création job + River,
liste/détail des jobs.

**M3 — Worker macOS + protocole**
Protocole `/internal` claim/heartbeat/progress/complete, worker Python (pipeline ffmpeg +
SSIM-skip + RapidOCR), sortie ASS/SRT, multi-backend (env).

**M4 — Temps réel + téléchargement**
SSE progress/logs vers le frontend, persistance logs, téléchargement résultats (presigned).

**M5 — Éditeur navigateur**
JASSUB + wavesurfer, table de cues, édition timing/texte/position/style, import/export.

**M6 — Worker NVIDIA**
Dockerfile CUDA + ffmpeg NVDEC, nvidia-container-toolkit, backends PP-OCRv5 / PaddleOCR-VL,
routing `worker_class`.

**M7 (option) — Client-side navigateur**
Prototype WebCodecs + WebGPU + ppu-paddle-ocr, gating (WebGPU + durée).

---

## 12. Risques & points d'attention

- **Précision OCR sur sous-titres stylisés / basse résolution** : crop serré + bon backend essentiels.
  Prévoir la révision humaine dans l'éditeur comme partie intégrante du flux.
- **PaddlePaddle natif sur Apple Silicon historiquement cassé** → privilégier RapidOCR (ONNX/CoreML)
  ou PaddleOCR-VL via MLX sur Mac.
- **Multi-machines ⇒ S3 obligatoire** (le Mac ne voit pas le FS de l'API).
- **Licences** : vérifier les poids des modèles (Surya = OpenRAIL-M, seuil 5M$). PaddleOCR/RapidOCR =
  Apache-2.0. Éviter le code CC-BY-NC (VTT Editor Pro). Préférer JASSUB (MIT) à l'original Octopus (libass/GPL).
- **Timing frame-accurate vs vitesse** : compromis via fps d'échantillonnage, exposé en paramètre de job.
```
