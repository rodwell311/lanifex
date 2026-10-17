# Lanifex

<div align="center">
  <img src="public/logos/lf-mark-tight.png" width="96" alt="Lanifex"><br>
  <b>Self-hosted AI planning tool</b> — dari ide mentah jadi PRD, fitur, task, dan prompt siap-eksekusi untuk coding agent.
</div>

---

## Arti nama

**Lanifex** berasal dari bahasa Latin: *lāna* (wol) + *-fex* ("pembuat", dari *facere* — seperti *artifex* si pengrajin, *opifex* si tukang). Jadi kira-kira: **"penenun"** — mereka yang menenun helai-helai benang terpisah menjadi satu kain utuh.

Itulah yang tool ini lakukan: ide yang masih berantakan ditenun, helai demi helai, menjadi sesuatu yang utuh dan siap dikerjakan — pertanyaan penjelasan, PRD, daftar fitur, task berurutan, sampai prompt yang bisa dieksekusi coding agent.

## Kenapa Lanifex

Kebanyakan alur "AI planning" berhenti di chat. Lanifex memindahkannya ke web app self-hosted yang menjadi **single source of truth** antara kamu dan coding agent (Claude Code, Codex, OpenCode, dll):

- **Wizard 5 langkah** — Ide → Tech stack (AI yang pilih atau kamu tentukan) → Pertanyaan klarifikasi dari AI → PRD (streaming) → Fitur & Task
- **PRD hidup** — markdown lengkap dengan acceptance criteria + roadmap, bisa direvisi dengan instruksi
- **Prompt agent + token akses** — prompt siap-paste berisi token `lf_...` scoped per plan; agent mengerjakan task satu per satu dan melaporkan balik
- **CLI agent** — `lanifex task next/start/complete/fail`, checkpoint per layer/fase, jadi agent tidak melompat-melompat
- **Monitoring** — progres %, tag `on progress` pada task yang sedang dikerjakan, auto-refresh
- **Model AI bebas diganti** — dari UI (halaman Setelan): ganti endpoint OpenAI-compatible apa pun, list & assign model per tahap, tanpa rebuild container. Env tetap didukung sebagai fallback.
- **Multi-user + mode pemilik** — akun pertama otomatis jadi pemilik, registrasi publik tertutup, pemilik bisa membuatkan akun orang lain
- **Resume wizard** — keluar di tengah perencanaan? Kembali tepat di langkah terakhir, jawaban utuh
- **Zero dependency** — Node 22 + `node:sqlite` saja. Frontend satu file HTML, tanpa build step, tanpa framework.

## Deploy (Docker)

```bash
git clone https://github.com/rodwell311/lanifex.git
cd lanifex
cp .env.example .env
# edit .env — arahkan LLM_BASE_URL ke provider OpenAI-compatible milikmu
docker compose up -d --build
# buka http://localhost:8788
```

Kebutuhan: Docker + Compose v2. Port bisa diganti lewat `PORT` di `.env`.

### Konfigurasi LLM

Semua variabel di `.env` bisa dioverride dari **UI → Setelan** (nilai di database menang):

```bash
LLM_BASE_URL=http://host.docker.internal:20128/v1   # endpoint OpenAI-compatible apa pun
LLM_API_KEY=sk-...
LLM_MODEL=code                                       # model utama
LLM_MODEL_QUESTIONS=...                              # opsional: model per tahap
LLM_MODEL_PRD=...
LLM_MODEL_FEATURES=...

MOCK_LLM=1                                           # demo tanpa provider — output deterministik
```

Cocok dengan: OpenAI, OpenRouter, Groq, vLLM, LiteLLM, Ollama (`/v1`), LM Studio, dan gateway lain yang kompatibel.

<details>
<summary>LLM gateway jalan sebagai container di host yang sama (bind 127.0.0.1)?</summary>

`host.docker.internal` tidak bisa menjangkau port yang hanya listen di `127.0.0.1` host. Solusi: join network container gateway itu — di `compose.yaml` sudah ada blok `networks.router` (external):

```bash
docker inspect <gateway> --format '{{json .NetworkSettings.Networks}}'  # lihat nama network
# set LLM_BASE_URL=http://<nama-container-gateway>:<port>/v1
```

Kalau tidak perlu, hapus saja blok `networks` di `compose.yaml`.
</details>

## Alur pemakaian

1. **Web** → buat akun (yang pertama = pemilik) → **+ Plan baru** → tulis ide
2. Jawab pertanyaan klarifikasi → PRD tergenerate (streaming, bisa direvisi) → **Pecah jadi Fitur & Task**
3. **Prompt agent** → salin prompt berisi token → paste ke coding agent kamu
4. Agent menjalankan loop:
   ```bash
   node cli.js login --server http://localhost:8788 --token lf_xxx
   node cli.js plan get 1
   node cli.js task next --plan 1 --json    # satu task, berhenti tiap ganti layer/fase
   node cli.js task start T1 && node cli.js task complete T1
   ```
5. Dashboard menampilkan progres real-time — task aktif ditandai `on progress`

## Arsitektur

```
server.js          # HTTP + SQLite + LLM client + API — satu file, zero dependency
cli.js             # CLI agent (login / plan / task loop)
public/index.html  # SPA wizard + dashboard — satu file, tanpa build
Dockerfile         # node:22-alpine
compose.yaml       # port 8788, volume data/, host.docker.internal
```

**API**: `/api/auth/*`, `/api/plan/*`, `/api/settings*`, `/api/agent/*` (token `lf_`).
**DB**: SQLite di `data/lanifex.db` (volume) — tabel `users, sessions, api_tokens, plans, features, tasks`.

## Test

```bash
bash smoke.sh    # end-to-end mock: register → PRD → fitur/task → token → loop CLI → progres
```

## Batasan

- Dibangun sebagai re-implementasi mandiri dari observasi perilaku sebuah produk planning berbasis AI — semua kode ditulis dari nol, tidak ada kode yang disalin.
- Belum ada: pembayaran/kuota, chat revisi interaktif, sync codebase, multi-workspace.

## Lisensi

MIT
