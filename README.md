# RwandAir Catering Control

RwandAir internal catering operations and stock-control platform. The responsive PWA supports English/French operation, offline Attendant drafts, Lead operational review, Procurement ledger approval and executive cost insights.

## Prerequisites

- Node.js 22 or newer
- Docker Desktop or Docker Engine with Compose
- Port `80` available for the full Docker stack. Terminate HTTPS at the host or
  platform reverse proxy for pilot deployment.

## Run the application

### Run locally with PostgreSQL in Docker

Use this for local development when the web and API should run directly on the
host. PostgreSQL remains in Docker; authentication sessions are stored in
PostgreSQL, so no Redis service is required.

1. Install dependencies:

  ```bash
  npm ci
  npm --prefix apps/api ci
  ```

2. Create the local API environment file:

  ```bash
  cp apps/api/.env.example apps/api/.env.local
  ```

  Keep the PostgreSQL password in this file aligned with `POSTGRES_PASSWORD`
  in the root `.env` file.

3. Create the root environment file if it does not exist, then start the
  host API dependencies:

  ```bash
  test -f .env || cp .env.example .env
  docker compose up -d postgres
  ```

4. Prepare the database:

  ```bash
  npm --prefix apps/api run prisma:generate
  npm --prefix apps/api run prisma:migrate:local
  npm --prefix apps/api run seed:local
  ```

5. Start the API and web application in separate terminals:

  ```bash
  npm --prefix apps/api run dev:local
  npm run dev
  ```

Open `http://localhost:3001`. The API is available at
`http://localhost:4000/health` and the web proxy at
`http://localhost:3001/api/health`.

The API `dev` command loads `apps/api/.env.example` and the optional ignored
`apps/api/.env.local`. Keep both terminals running while using host-local mode:

```bash
npm --prefix apps/api run dev
npm run dev
```

Stop the Docker database with:

```bash
docker compose stop postgres
```

### Run the complete Docker stack

1. Create the Docker environment file:

   ```bash
   cp .env.example .env
   ```

2. Replace the placeholder PostgreSQL and MinIO secrets in `.env`.
   For local HTTP keep `WEB_ORIGIN=http://localhost` and
   `COOKIE_SECURE=false`. For a TLS deployment, terminate HTTPS in front of
   this Compose stack, use the real HTTPS origin and set `COOKIE_SECURE=true`.

3. Build and start the complete stack:

   ```bash
   docker compose up -d --build
   ```

4. Confirm migrations and service health:

   ```bash
   docker compose logs migrate
   docker compose ps
   ```

Open `http://localhost`. Nginx is the public same-origin entry point; the web
and API containers are intentionally private. API documentation is available
at `http://localhost/api/docs`.

Stop the stack without deleting persistent volumes:

```bash
docker compose down
```

The single Compose stack contains `web`, `api`, `migrate`, `postgres`, `minio`
and `nginx`. The one-shot migration service applies committed
migrations and runs the seed before the API starts. A database marker prevents
future starts from resetting users, prices, stock or historical demo records.
The production API image prunes development and migration tooling; Prisma CLI
remains only in the migration image.

## Vercel deployment

Vercel deploys the Next.js frontend **and** the NestJS API as a single
same-domain deployment. `vercel.json` configures this automatically:

```json
{
  "installCommand": "npm ci && npm --prefix apps/api ci",
  "buildCommand": "npm --prefix apps/api run prisma:generate && npm --prefix apps/api run build && npm run build"
}
```

[api/[...path].ts](api/[...path].ts) is a Vercel Serverless Function that
loads the compiled `apps/api/dist/app.js` Nest application and serves every
`/api/*` request on the same domain as the frontend, so `app/lib/api.ts`'s
default `/api` base URL works with no `NEXT_PUBLIC_API_URL` configuration.

### Required Vercel Environment Variables

The API needs a **publicly reachable** PostgreSQL instance. Your local Docker
Compose `postgres` container is not reachable from Vercel; use a managed
provider such as Neon or Supabase, then set for Production (and Preview, if
used):

```env
DATABASE_URL=postgresql://user:password@host:5432/wingsbalance?sslmode=require
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
DEMO_PASSWORD=<seed-only password>
```

`WEB_ORIGIN` is optional when same-origin, but set it to your production
domain for defense-in-depth CORS.

`DATABASE_URL` must be set **before the first build**, because
`prisma generate` reads it while resolving the schema.

### One-time migration and seed

Vercel does not run the Compose `migrate` service. The GitHub Actions workflow
`.github/workflows/production-migrate.yml` applies committed migrations on
pushes to `main` and can also be started manually. Configure a `DATABASE_URL`
secret in the repository's protected `Production` environment. The workflow
also accepts the legacy secret name `PRODUCTION`, but `DATABASE_URL` is the
recommended name. It must point to the same managed PostgreSQL database
configured in Vercel.

The migration workflow intentionally does not run the seed script. Seed only a
new development/demo database explicitly:

```bash
DATABASE_URL=<managed-postgres-url> npm --prefix apps/api run prisma:migrate
DATABASE_URL=<managed-postgres-url> DEMO_PASSWORD=<seed-password> npm --prefix apps/api run seed
```

The regular CI workflow starts PostgreSQL 17, applies all committed migrations,
and then runs API tests. This catches migration drift before a change reaches
the production migration workflow.

### Known risks of this deployment shape

- `argon2` ships a native binary; it must load correctly under Vercel's
  Node.js runtime. Verify a real login after the first deployment.
- Prisma's query engine binary target for Vercel
  (`rhel-openssl-3.0.x`, already added to `schema.prisma`) must match Vercel's
  runtime; if Prisma reports a missing engine, check Vercel's function logs.
- Serverless functions are stateless per invocation; PostgreSQL connections are
  created lazily per cold start, which is expected but adds latency on the
  first request after idle periods. Sessions are persisted in PostgreSQL.

### Alternative: separate API origin

If you would rather run the API on its own host (a VPS, Docker, or a managed
Node host) instead of as a Vercel function, set:

```env
NEXT_PUBLIC_API_URL=https://api.example.rw
```

and on the API host:

```env
WEB_ORIGIN=https://app.example.rw
COOKIE_SECURE=true
COOKIE_SAMESITE=none
```

Docker remains an optional self-hosted deployment and local dependency stack.
It is validated separately from the required application CI because Vercel
does not deploy the Compose web/API containers.

## Authentication troubleshooting

- Before login, `GET /api/v1/auth/me` should return `401`, not `404`. A `401`
  confirms the request reached NestJS and no session cookie was supplied.
- A `404` on `http://localhost/api/v1/auth/me` usually means the Nginx route is
  stale or the deployment is using an outdated image. Rebuild the stack.
- A proxy connection error means the API container is not healthy. Check
  `docker compose ps` and `docker compose logs api`.
- For `http://localhost:3001`, a proxy connection error means the host API is
  not running on port `4000`. Start it with
  `npm --prefix apps/api run dev`; do not use the Docker-only root `.env` as the
  host API configuration.
- Cookies are origin-specific. Use `localhost` consistently rather than mixing
  `localhost` and `127.0.0.1` in the browser.
- For the complete Docker stack, open `http://localhost`; for host development,
  open `http://localhost:3001`. Do not use `https://catering.example.rw` unless
  DNS and TLS are configured for that deployment.
- `COOKIE_SECURE=true` prevents cookies from being stored over plain HTTP. Use
  it only behind HTTPS.
- If login fails after changing `DEMO_PASSWORD`, reseed the development users
  or use the password with which they were originally seeded. The seed is
  intentionally one-time and does not overwrite existing password hashes.
- If Node reports `.env.local: not found`, update to the current scripts. The
  local launcher uses `.env.example` automatically and opens `.env.local` only
  after confirming it exists.
- The dedicated local dependency ports avoid accidentally connecting to another
  project's PostgreSQL or MinIO containers on their default ports.

Development demo accounts are `attendant@wings.rw`, `lead@wings.rw`,
`procurement@wings.rw`, `director@wings.rw` and `admin@wings.rw`. Their seeded
password is controlled by `DEMO_PASSWORD`. Persona shortcuts remain disabled
unless `NEXT_PUBLIC_DEMO_PERSONAS=true` is enabled at build time.

The fictional crew directory also contains `attendant2@wings.rw`,
`attendant3@wings.rw` and `attendant4@wings.rw`, using the same development
password. They allow Leads to exercise multi-crew assignment and completion
tracking on newly imported flights.

## Roles and demo behavior

- Attendant: edits operational quantities, switches cabin and sends an
  individual crew completion. Monetary item pricing is not exposed. The
  assigned purser is the only crew member who can submit the consolidated
  catering reconciliation.
- Lead: works only with assigned, non-overlapping flights; assigns one purser
  and the cabin crew, selects the matching Procurement catering list, reviews
  crew completion, uses explainable load planning, reviews the operational report and forwards it for
  reconciliation. The workspace refreshes every 15 seconds and creates an
  actionable notification for each crew completion and final report.
- Procurement: owns flight and catering imports, catering-list names, Lead
  assignment, prices, inventory, waste analytics and final ledger approval.
  Reconciliation is intentionally flight-centric: flight number, route/date and
  catering consumption, return, waste and unexplained totals. Crew management
  is not exposed in the Procurement workflow.
- Director: reads aggregate financial KPIs, savings opportunities and explainable insights.

Accounts, opaque sessions, and login throttling are stored in PostgreSQL with
Argon2 password hashes; state-changing requests require the session CSRF token.
Set `COOKIE_SECURE=true` behind production HTTPS.

### Crew reporting workflow

1. The Lead assigns the flight crew and exactly one purser. Assignment changes
   are locked as soon as any crew member reports, preventing the accountability
   roster from changing during reconciliation.
2. Each assigned attendant sends one idempotent crew completion from **My
   flight**. Optional service notes are retained against that crew member and
   the Lead receives a notification.
3. The Lead can search the roster by name/email, sort pending reports first and
   send reminders to missing crew.
4. The purser sends the single consolidated catering report. The API rejects it
   with `CREW_REPORTS_PENDING` and the missing names until every assigned crew
   member has reported.
5. The Lead receives a **final report ready** notification, reviews the
   flight-level totals, then forwards the report to Procurement. Only
   Procurement approval posts the stock ledger.

Relevant endpoints are `POST /api/v1/flights/:id/crew-submissions`,
`GET /api/v1/lead/flights/:id/crew-status`,
`POST /api/v1/lead/flights/:id/crew/:userId/remind`, and
`PATCH /api/v1/notifications/:id/read`.

## Stock invariants

`unexplained = loaded - consumed - returned - spoiled - discarded`.

Official inventory is changed only by Procurement approval. Consumption,
spoilage, discard and unexplained loss reduce stock; returns are informational
because loaded stock is not deducted before approval. Ledger records are
append-only, and report revisions remain available for audit. Procurement sees
on-hand, reserved and available quantities; reorder alerts use available stock.
Quantity requests carry an idempotency key and manifest version so retries are
safe and concurrent edits are rejected explicitly.

Only Attendant manifest drafts are queued offline. Final submission, approval,
price and administrative mutations require a live connection. Cached flight
manifests and queued drafts are isolated by signed-in user and cleared at
logout; Procurement and Director responses are never cached.

## Forecast model

The forecast adapter uses recent passenger-normalized consumption. It prefers a route sample of at least five flights, falls back to network history, applies a configurable safety buffer, and reports its method, sample size and confidence. There is no external AI or passenger-data transfer.

## Operations

- Health: `GET /api/health`; readiness: `GET /api/ready`.
- Backup: `docker compose exec -T postgres pg_dump -U wingsbalance -Fc wingsbalance > wingsbalance.dump`.
- Restore into an empty database: `pg_restore -U wingsbalance -d wingsbalance --clean --if-exists wingsbalance.dump`.
- Export MinIO data independently using the MinIO client and back up Docker volumes before upgrades.
- Rotate session, database and object-store secrets through environment or Docker secrets; never commit `.env` or TLS private keys.
- `RECOVERABLE_WASTE_PCT` controls the Director annualized-savings scenario
  (default `25`). It is an explicit planning assumption, not booked savings.
- The pre-remediation local safety backup is stored outside the repository at `/tmp/wingsbalance-backups/pre-remediation.dump`.

## Procurement CSV imports

Procurement users open **Upload data** from the desktop sidebar or mobile
workspace navigation and choose one of two audited workflows:

- `docs/flights-template.csv` creates a flight with one or more ordered sectors
  and cabin passenger counts.
- `docs/catering-template.csv` creates or updates a named catering list by
  flight date, sector, cabin and active catalog SKU. It never changes prices.
  A Lead can select that list only when its flight number and date match.

Crew assignment is intentionally not a CSV import. The assigned Lead selects
active attendants in the application and must designate exactly one purser;
the API rejects overlapping crew assignments.

Every upload has a preview stage with row-level errors. The server stores the
original CSV and parsed preview as an import batch, then reparses and revalidates
the stored source during commit. The browser cannot alter validated rows before
commit. Repeated previews of the same source reuse the pending batch, commits
claim the batch atomically, and the Lead can explicitly cancel an abandoned
preview. Completed and cancelled batches remain in Procurement import history and
all actions are written to the audit log.

The pilot accepts UTF-8 CSV files up to 1 MB and 1,000 data rows. Flight numbers
may be entered as `WB435` or `WB 435`; they are normalized to `WB 435`.
