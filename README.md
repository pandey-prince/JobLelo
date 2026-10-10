# JobLeLo

A job portal for **job seekers** — IT roles in India from company career pages (100+ sources). Only India-relevant roles are shown.

> **Applicant-only mode:** The product UI is for job seekers. Recruiter signup is blocked; the public job feed shows scraped career-page listings only. Platform ops use a separate **admin** login at `/admin/login` (not linked in the student navbar).

## Live

| Service | URL |
|---------|-----|
| Frontend | https://www.joblelo.online |
| Backend API | Render (configure via env — not committed) |

## Tech stack

- **Frontend:** React (Vite), Redux, Tailwind, shadcn/ui
- **Backend:** Node.js 20, Express 5, MongoDB (Mongoose)
- **Deploy:** Vercel (frontend), Render (backend), MongoDB Atlas

## Custom domain (joblelo.online)

1. **Vercel** → Project **job-vista** → Settings → Domains → add `www.joblelo.online` and `joblelo.online` (redirect apex → www).
2. At your domain registrar, point DNS to Vercel (A/CNAME records shown in Vercel dashboard).
3. **Render** → **jobvista-backend** → Environment → set `FRONTEND_URL=https://www.joblelo.online` and redeploy (needed for CORS + email links).
4. Optional: set `VITE_SITE_URL=https://www.joblelo.online` in Vercel env vars.

The old Vercel URL (`job-vista-eta.vercel.app`) still works during transition; backend CORS allows both.

## Features

- Job seeker auth (JWT cookies) — email/password with **OTP verification**, **Google Sign-In**, student accounts only
- Job feed: scraped company career pages (India IT roles only)
- **JobMate AI Assistant:** Gemini-powered career assistant (optional `GEMINI_API_KEY`)
- 100+ Indian company career sources (Greenhouse, Lever, Workday, TCS, etc.)
- Job seeker tools: save jobs, email alerts, watchlist instant alerts, application kanban, resume match score
- First-letter profile avatars (no photo upload required)
- Docker Compose for local full stack

## Product UX (Phases 1–7)

### Routes

| Path | Description |
|------|-------------|
| `/jobs` | Main job feed with filters, sort, and mobile filter drawer (`/browse` redirects here) |
| `/companies/:slug` | Company page — careers-page meta, sync status, and paginated openings for one company |
| `/profile/setup` | Multi-step profile wizard after signup |
| `/description/:id` | Job detail with apply-on-company-site CTA and JobMate context |

### Job filters & sort

On `/jobs`, filters sync to the URL and API query params:

- **Company** — multi-select from monitored career sources (`companies` CSV on `GET /job/get`)
- **Sort** — `newest` (default) or `company` (A–Z)
- **Location, work mode, experience, role, job type, posted within** — same as before

On viewports below `lg`, filters open in a drawer; on desktop they stay in the sidebar.

### Onboarding checklist

Logged-in students see a three-step checklist on **Home** (dismissible banner) and **Profile**:

1. Complete profile (`/profile/setup`)
2. Watch 3 companies (`/my-companies`)
3. Create 1 email alert (`/alerts`)

Progress is computed from existing profile, watchlist, and alerts data — no extra DB fields.

### Recommended jobs

- **Home — Jobs for you:** `GET /job/recommended` when logged in with skills or preferred roles
- **Guests / empty profile:** CTA to complete profile instead of an empty grid
- Match score uses simple keyword overlap against job title and description

### Trust signals on job cards

Job cards show **freshness badges** (Posted today, New, Career page) and a **source label** (e.g. “From Razorpay”) via `JobFreshnessBadges`.

## Project structure

```
JobVista/
├── backend/                 # Express API
├── frontend-codes/frontend/ # React app (Vercel root)
├── docker-compose.yml
└── render.yaml              # Render backend blueprint
```

## Architecture (modular layout)

### Backend

Controllers stay thin and delegate to **services**:

| Module | Role |
|--------|------|
| `services/job-catalog/` | Job mapping, scraped lists, external feeds (Remotive/Arbeitnow) |
| `services/trackedApplication.service.js` | Kanban tracker sync and migration |
| `services/gemini.service.js` | Shared Gemini client for match score |
| `services/email.service.js` | Resend email delivery |
| `services/alertDigest.service.js` | Daily digest matching + send |
| `services/watchlistAlert.service.js` | Instant watchlist alerts after scrape |

Routes map to controllers; controllers call services — not the other way around.

### Frontend

| Layer | Role |
|-------|------|
| `src/api/client.js` | Shared axios instance (credentials, base URL) |
| `src/api/index.js` | Domain APIs: `authApi`, `jobsApi`, `adminApi`, `savedJobsApi`, `alertsApi`, `trackerApi`, `careerSourceApi`, … |
| `src/app/router.jsx` | Route definitions |
| `src/layouts/MainLayout.jsx` | Navbar + `<Outlet />` shell |
| `src/features/*/` | Feature hooks and UI (`useJobAlerts`, `useTrackedApplications`, `MatchScorePanel`) |
| `src/components/` | Page-level and shared UI |

New job-seeker screens should use the API layer and feature hooks instead of calling axios directly.

## Local development

### 1. Backend

```bash
cd backend
npm install
```

Create `backend/.env`:

```env
MONGO_URI=mongodb://127.0.0.1:27017/jobvista
SECRET_KEY=your-local-secret
FRONTEND_URL=http://localhost:5173
SCRAPE_ENABLED=true
SCRAPE_ON_BOOT=false
LINK_CHECK_ENABLED=true
LINK_CHECK_CRON=0 3 * * *
LINK_CHECK_FAIL_THRESHOLD=3
```

Scraped jobs are kept fresh by:
- **Scrape sync** (default every 6 hours) — re-reads career boards and hard-deletes jobs no longer listed
- **Link check** (default daily) — validates `applicationUrl` and hard-deletes confirmed 404 / "job not found" pages after 3 failures

Recruiters can trigger manually via API (ops): `POST /api/v1/scraped-jobs/link-check`

### Admin ops dashboard

Admin accounts are **not** created via public signup. Bootstrap once with env vars in `backend/.env` (see `.env.example`):

```env
ADMIN_EMAIL=ops@example.com
ADMIN_PASSWORD=your-strong-password
ADMIN_FULLNAME=JobLeLo Admin
ADMIN_PHONE=9000000000
```

```bash
cd backend
npm run seed:admin
```

Then open **http://localhost:5173/admin/login** (production: `https://www.joblelo.online/admin/login`).

| Path | Purpose |
|------|---------|
| `/admin` | Ops dashboard — platform stats + searchable company table (scraped vs in-DB vs visible on site) |
| `/admin/sources` | Manage career sources — sync, enable/disable, add URL, Excel import |

All `/api/v1/admin/*` and scraped-jobs source mutations require the `admin` role and JWT cookie. Student accounts cannot access admin routes.

Optional company logo uploads (otherwise files save to `backend/uploads/`):

```env
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
API_BASE_URL=http://localhost:8000
```

Optional — seed demo data (legacy recruiter jobs; not shown in applicant-only feed):

```bash
npm run seed
```

Creates a demo recruiter, companies, and ~15 IT jobs in the database. Idempotent (only replaces its own demo data). These internal jobs do not appear in the public feed in applicant-only mode.

```bash
npm run dev
```

### 2. Frontend

```bash
cd frontend-codes/frontend
npm install
npm run dev
```

API URLs default to `http://localhost:8000/api/v1` in dev. Override with `VITE_*` vars — see `vercel.env.example`.

### 3. Docker

```bash
docker compose up --build
```

Frontend: http://localhost:3000 · Backend: http://localhost:8000

## API routes (`/api/v1`)

| Prefix | Purpose |
|--------|---------|
| `/user` | Register (**OTP verify**), login, **Google (`POST /google`)**, logout, profile, **`GET /me`** |
| `/job` | List jobs (scraped feed), **sort** (`sortBy`), **company filter** (`companies`), **`GET /recommended`** |
| `/application` | Apply to internal jobs (legacy; feed is scraped-only) |
| `/company` | Recruiter companies (API only) |
| `/scraped-jobs` | Scraped jobs + source ops (admin role only) |
| `/admin` | Admin dashboard stats and source list (`GET /dashboard`, `GET /sources`) |
| `/career-sources` | Public directory, watchlist, Excel import, **`GET /:slug/jobs`** company page API |
| `/chatbot` | JobMate messages |
| `/stats` | Public platform stats (job counts, companies monitored) |
| `/saved-jobs` | Bookmark jobs (student) |
| `/alerts` | Email job alerts — daily digest 8 PM IST (student) |
| `/tracked-applications` | Application kanban tracker (student) |

## Email alerts (Resend)

Set on backend (Render dashboard or `backend/.env`):

```env
RESEND_API_KEY=re_xxxx
EMAIL_FROM=JobLeLo <notifications@joblelo.online>
ALERT_DIGEST_CRON=30 14 * * *
```

`ALERT_DIGEST_CRON` runs at **8:00 PM IST** (14:30 UTC). Without `RESEND_API_KEY`, emails are skipped in dev and OTP codes are logged to the backend console locally.

## Auth (OTP + Google)

### Signup flow

1. `POST /user/register` — creates account, sends 6-digit OTP email (no session yet)
2. `POST /user/verify-email` — `{ email, otp }` → JWT cookie + verified account
3. `POST /user/resend-otp` — resend code (rate-limited)

Login with an unverified account returns `needsVerification: true` and sends a fresh OTP.

Google Sign-In (`POST /user/google` with ID token) skips OTP — email is treated as verified.

### Environment variables

**Render (backend)**

| Variable | Required | Notes |
|----------|----------|-------|
| `GOOGLE_CLIENT_ID` | For Google auth | OAuth Web client ID from Google Cloud Console |
| `RESEND_API_KEY` | For OTP in production | Same key used for job alert emails |
| `EMAIL_FROM` | Yes | e.g. `JobLeLo <notifications@joblelo.online>` — verify domain in Resend |

**Vercel (frontend)**

| Variable | Required | Notes |
|----------|----------|-------|
| `VITE_GOOGLE_CLIENT_ID` | For Google button | Same value as `GOOGLE_CLIENT_ID` |

**Google Cloud Console**

- Create OAuth **Web application** client
- Authorized JavaScript origins: `https://www.joblelo.online`, `https://joblelo.online`, `http://localhost:5173`

Admin login (`/admin/login`) remains email/password only.

## Scraping (hybrid: GitHub Actions + Render)

| Layer | What runs | Where |
|-------|-------------|--------|
| **API scrapers** (~47) | greenhouse, lever, workday, smartrecruiters, RSS, etc. | **GitHub Actions** every 6h — [`.github/workflows/scrape-api.yml`](.github/workflows/scrape-api.yml) (primary) |
| **Puppeteer scrapers** (~55) | `auto-puppeteer` career pages | **GitHub Actions** 3×/day — [`.github/workflows/scrape-puppeteer.yml`](.github/workflows/scrape-puppeteer.yml) (one bucket per run) |

Render sets `SKIP_PUPPETEER_SCRAPERS=true` — Puppeteer companies are **not** scraped on the hosted backend. Render’s built-in cron is an **optional backup** for API sync when the web process stays awake; **GitHub Actions is the primary** reliable runner for API sources.

### GitHub Actions setup (required for full 100-source coverage)

1. Repo **Settings → Secrets and variables → Actions**
2. Add secret: `MONGO_URI` (same Atlas URI as Render)
3. Workflows support **manual dispatch** from the Actions tab

**API sync** ([`scrape-api.yml`](.github/workflows/scrape-api.yml)) runs every 6 hours:
1. **api-sync** — `node scripts/sync-api.js` for greenhouse, lever, workday, smartrecruiters, RSS, etc.
2. **source health** — `node scripts/source-health.js --report-only` after sync

**Puppeteer sync** ([`scrape-puppeteer.yml`](.github/workflows/scrape-puppeteer.yml)) runs **3 times/day** (bucket `hash(id)%3`):
1. **priority-puppeteer** — user-submitted `auto-puppeteer` sources queued via `priorityPuppeteerSync`
2. **reprobe** — tries to upgrade auto-puppeteer boards to API scrapers (once per run)
3. **puppeteer-sync** — single job for `PUPPETEER_BUCKET=0|1|2` (cron maps schedule → bucket; ~1/3 of sources per run, 3h timeout)
4. **health-report** — logs a status report after the bucket finishes

Also: **Import career sources** ([`import-career-sources.yml`](.github/workflows/import-career-sources.yml)) — manual workflow to load region JSON (e.g. Noida) into Atlas without sync storm (`triggerSync: false`).

```bash
# Local / laptop (set Atlas URI)
cd backend
MONGO_URI="mongodb+srv://..." npm run import:sources -- --file=data/lists/noida_company_careers.json
```

`PUPPETEER_FAIL_ON_PARTIAL=false` — one source failing does **not** fail the whole workflow; only successful scrapes upsert jobs.

**Pilot (best-effort):** Chargebee, Ola, and Delhivery are active `auto-puppeteer` sources. After Render redeploy, boot seed flips them `isActive: true` in MongoDB. Then either wait for the daily Puppeteer run or manually: GitHub → Actions → **Scrape Puppeteer Sources** → Run workflow. In the logs, search for those company names — success shows job counts; failures are skipped and do not stop other sources. If a pilot returns junk or 0 useful India IT jobs for several runs, set `isActive: false` again in `backend/data/knownCareerBoards.js` for that company only.

**Priority Puppeteer sync** ([`scrape-puppeteer-priority.yml`](.github/workflows/scrape-puppeteer-priority.yml)) runs on demand when a user submits a generic career page:
- Triggered via `repository_dispatch` when Render has `GITHUB_WORKFLOW_DISPATCH_TOKEN` + `GITHUB_REPO` set
- Also supports manual dispatch from the Actions tab (~30 min timeout)
- Without the token, sources stay queued until the next priority or daily Puppeteer run

### Ops sync endpoint (optional)

`POST /api/v1/scraped-jobs/sync/ops?mode=api|puppeteer|all` with header `x-cron-secret: <CRON_SECRET>`.

Set `CRON_SECRET` on Render if you want external cron triggers. Render’s built-in scheduler already syncs **API sources only**.

### Manual scripts (debug only)

Do **not** run Puppeteer sync against production Atlas from your laptop. Production Puppeteer scraping is handled only by the GitHub Actions workflow above.

```bash
cd backend
npm run sync:api              # API sources only (Render-style)
npm run sync:puppeteer        # Local debugging only — CI uses the same script
npm run sync:puppeteer-priority  # User-queued Puppeteer sources only
npm run reprobe:sources       # Upgrade auto-puppeteer → API where possible
npm run sync:health           # Report; add --report-only to never fail exit code
```

### One-time: kick API sync on Render

After deploy, either wait for the 6h cron or temporarily set `SCRAPE_ON_BOOT=true` in Render and redeploy once.

## Caching

The public job catalog (home, `/jobs`, companies page, stats, recommendations) is cached **in memory** on the backend, so a page load no longer re-reads and re-processes up to 5,000 jobs from MongoDB.

- **What is cached:** the global, user-independent list of visible jobs (IT + India filters, dedupe, mapped for the UI) plus a lower-cased search text per job. Per-user steps (dismissed jobs, profile recommendations, filters, sort, pagination) run *after* the cache, so nothing personal is ever shared.
- **Freshness:** TTL based (`CATALOG_CACHE_TTL_MS`, default 5 min) with stale-while-revalidate (`CATALOG_CACHE_STALE_MS`, default 30 min), because GitHub Actions scrapers write to MongoDB from other processes. Writers inside the API process (syncs, link check, admin source edits) invalidate the cache when they finish.
- **Warm-up:** the cache is built in the background on boot; concurrent cold requests share a single DB load.
- **Keyword search** is plain, case-insensitive text matching against the cached list (no regex), bounded to 100 characters.
- **Derived data** (public stats, company groups, guest recommendations) is memoised per catalog version.
- **External jobs** (Remotive/Arbeitnow detail pages) are served from a cached id index instead of re-downloading the whole listing.
- **Kill switch:** set `CATALOG_CACHE_TTL_MS=0` (and/or `EXTERNAL_JOBS_CACHE_TTL_MS=0`) to bypass caching with no code change.
- **Admin:** `GET /api/v1/admin/cache` shows hits/misses, age, job count and memory; `POST /api/v1/admin/cache/clear` rebuilds the catalog now.
- **Benchmark:** `npm run benchmark:catalog` (DB pipeline) or `BASE_URL=http://localhost:8000 node scripts/benchmark-catalog.js --http` (endpoints).
- **Limits:** the cache is per process. If you ever run more than one backend instance, swap the store behind `backend/utils/memoryCache.js` for a shared one (e.g. Redis).

### Try it locally (no scraping needed)

```bash
# 1. a local MongoDB (any of these)
docker compose up -d mongo                      # uses the repo's docker-compose.yml

# 2. backend/.env  (copy .env.example and set at least:)
#    MONGO_URI=mongodb://127.0.0.1:27017/jobvista-local
#    SECRET_KEY=local-dev-secret
#    FRONTEND_URL=http://localhost:5173
#    SCRAPE_ENABLED=false   LINK_CHECK_ENABLED=false
#    ADMIN_EMAIL=admin@local.test   ADMIN_PASSWORD=Admin#12345

# 3. backend: seed demo companies + 1,500 jobs (refuses non-local databases), then run
cd backend && npm install
npm run seed:catalog                  # or: node scripts/seed-local-catalog.js --jobs=5000
npm run dev                           # http://localhost:8000

# 4. frontend (falls back to http://localhost:8000 in dev)
cd frontend-codes/frontend && npm install && npm run dev      # http://localhost:5173

# 5. end-to-end cache checks against the running backend
cd backend && TEST_ADMIN_EMAIL=admin@local.test TEST_ADMIN_PASSWORD='Admin#12345' npm run test:e2e-cache
```

Admin login is at `/admin/login`; cache status is at `GET /api/v1/admin/cache` (admin cookie required).

## Tests

```bash
cd backend
npm test                                    # API suite (server running)
npm run test:integration                    # MongoDB + scrapers (slow)
npm run test:cache                          # cache unit + controller tests (no DB needed)
npm run test:e2e-cache                      # live cache behaviour vs a running local backend + local DB
TEST_API_BASE=http://localhost:8000 node scripts/e2e-test.js
```

## Deployment

- **Render:** Connect repo, root `backend`, set `MONGO_URI`, `SECRET_KEY`, `FRONTEND_URL`
- **Vercel:** Root `frontend-codes/frontend`, env vars from `vercel.env.example`

## License

MIT
