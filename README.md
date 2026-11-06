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

## Vercel deployment

Vercel deploys the Next.js frontend **and** the NestJS API as a single
same-domain deployment. `vercel.json` configures this automatically:

```json
{
  "installCommand": "npm ci && npm --prefix apps/api ci",
  "buildCommand": "npm --prefix apps/api run prisma:generate && npm --prefix apps/api run build && npm run build"
}
```

[pages/api/[...path].ts](pages/api/[...path].ts) is the Next.js API route that
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

Set `WEB_ORIGIN` to the production HTTPS origin. Remote production startup
requires this origin and `COOKIE_SECURE=true`; explicit localhost origins
remain supported for local Docker development.

`DATABASE_URL` must be set **before the first build**, because
`prisma generate` reads it while resolving the schema.

### One-time migration and seed

Vercel does not run the Compose `migrate` service. The consolidated GitHub
Actions workflow `.github/workflows/ci.yml` applies committed migrations on
pushes to `main` and can also be started manually. Configure a `DATABASE_URL`
secret in the repository's protected `Production` environment. Its value must
be the actual connection string copied from the managed database provider—not
the documentation example containing `host`, `user:password`, or `/database`.
The workflow requires exactly that secret name and it must point to the same
managed PostgreSQL database configured in Vercel. Do not create a second non-secret
repository/environment variable with the same name; the workflow reads the
secret only. If the provider supplies separate pooled and direct URLs, add an
optional `MIGRATION_DATABASE_URL` secret for GitHub Actions and keep the pooled
`DATABASE_URL` for Vercel runtime traffic. The migration workflow uses the
direct URL when present and otherwise falls back to `DATABASE_URL`.

The migration workflow intentionally does not run the seed script. Seed only a
new development/demo database explicitly:

```bash
DATABASE_URL=<managed-postgres-url> npm --prefix apps/api run prisma:migrate
DATABASE_URL=<managed-postgres-url> DEMO_PASSWORD=<seed-password> npm --prefix apps/api run seed
```

The regular CI workflow starts PostgreSQL 17, applies all committed migrations,
and then runs API tests. This catches migration drift before a change reaches
the production migration workflow.

To recover or bootstrap the Production admin account, add an `ADMIN_PASSWORD`
secret to the protected `Production` GitHub environment, then run the `CI and
deployment checks` workflow manually with `operation=reset-admin`. Optionally
set `ADMIN_EMAIL`; it defaults to `admin@wings.rw`. This operation targets the
managed Production database and invalidates existing sessions for that admin.

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
It is not part of the Vercel production pipeline.

## Authentication troubleshooting

- Before login, `GET /api/v1/auth/me` should return `401`, not `404`. A `401`
  confirms the request reached NestJS and no session cookie was supplied.
- A `404` on `http://localhost/api/v1/auth/me` usually means the Nginx route is
  stale or the deployment is using an outdated image. Rebuild the stack.
- A proxy connection error means the API container is not healthy. Check
  `docker compose ps` and `docker compose logs api`.
- `Database schema is out of date` or `Flight.serviceDate does not exist` means
  the API and database are on different migration versions. Run
  `DATABASE_URL=<same-database-url> npm --prefix apps/api run prisma:migrate`,
  then restart the API. For host development with `apps/api/.env.local`, use
  `npm --prefix apps/api run prisma:migrate:local`. For Docker, run
  `docker compose up -d --build` and confirm `docker compose logs migrate` ends
  successfully.
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
password. These are additional eligible Flight Purser accounts; each flight has
one assigned purser. Internal role codes remain unchanged for compatibility.

## Role quick guide

| Role | Use the application to |
| --- | --- |
| Flight Purser | Open the assigned flight after arrival, enter consumed/returned/spoiled/discarded/unexplained quantities, add notes, and submit one consolidated leftovers report. |
| Cabin Services | Assign one Flight Purser, attach the catering list matching flight number and service date, review every sector/cabin, return corrections, or forward the report to Catering. |
| Catering | Import flights first, import matching catering lists, assign Cabin Services leads, maintain stock/prices, review forwarded reports, and approve once to post the ledger. |
| Director | Read aggregate approved-cost, waste, savings, and operational KPI views; no raw report or crew-assignment edits. |
| Admin | Create/deactivate accounts, reset access, and review the audit log; do not perform operational approvals. |

Each person signs in with the account assigned to their role. Do not use another
role's account to bypass workflow ownership.

Accounts, opaque sessions, and login throttling are stored in PostgreSQL with
Argon2 password hashes; state-changing requests require the session CSRF token.
Set `COOKIE_SECURE=true` behind production HTTPS.

### Leftovers reporting workflow

1. Cabin Services assigns exactly one Flight Purser.
2. After the final scheduled arrival, the Flight Purser opens the flight and
   confirms the prepared report from the saved quantities.
3. The report contains the date, purser name, flight number, route, sectors,
   cabins, item quantities, variance notes and review status.
4. Cabin Services reviews and forwards the report to Catering. Only Catering
   approval posts the stock ledger.

The purser reviews all sectors and cabins before confirming submission. Reports
can be completed after a flight is marked completed; cancelled flights cannot
be edited. Pending reports become overdue after the last scheduled arrival.
There is no scheduled submission or email service.

Report endpoints are `GET /api/v1/flights/:id/report`,
`GET /api/v1/flights/:id/report.csv`, and `GET /api/v1/flights/:id/report.pdf`.
Submission uses `POST /api/v1/flights/:id/reports`. The former individual
`crew-submissions` mutation is retired. Submitted revisions retain their own
flight, purser, item and quantity snapshots. Returned reports open the current
saved draft, while earlier submitted revisions remain available for audit.

## Stock invariants

`unexplained = loaded - consumed - returned - spoiled - discarded`.

Official inventory is changed only by Procurement approval. Consumption,
spoilage, discard and unexplained loss reduce stock; returns are informational
because loaded stock is not deducted before approval. Ledger records are
append-only, and report revisions remain available for audit. Procurement sees
on-hand, reserved and available quantities; reorder alerts use available stock.
Quantity requests carry an idempotency key and manifest version so retries are
safe and concurrent edits are rejected explicitly.

Only Flight Purser manifest drafts are queued offline. Final submission, approval,
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

## Catering CSV imports

Catering users open **Upload data** from the desktop sidebar or mobile
workspace navigation. Import Flights first, then the matching Catering file:

- `docs/flights-template.csv` creates a flight with one or more ordered sectors
  and cabin passenger counts.
- `docs/catering-template.csv` creates or updates a named catering list by
  flight date, sector, cabin and active catalog SKU. It never changes prices.
  Cabin Services can select that list only when its flight number and date match.

Crew assignment is intentionally not a CSV import. Cabin Services selects one
active Flight Purser in the application;
the API rejects overlapping crew assignments.

Every upload has a preview stage with row-level errors. The server stores the
original CSV and parsed preview as an import batch, then reparses and revalidates
the stored source during commit. The browser cannot alter validated rows before
commit. Repeated previews of the same source reuse the pending batch, commits
claim the batch atomically, and Catering can explicitly cancel an abandoned
preview. Completed and cancelled batches remain in Catering import history and
all actions are written to the audit log.

The pilot accepts UTF-8 CSV files up to 1 MB and 1,000 data rows. Flight numbers
may be entered as `WB435` or `WB 435`; they are normalized to `WB 435`.

Both UI downloads come from `packages/contracts/src/import-templates.ts` and
match the examples in `docs/`. The service date is a calendar date independent
of UTC departure time. Only the first sector must depart on that calendar date;
later sectors can depart on subsequent days. Departure/arrival timestamps need
explicit UTC offsets, and sectors must connect in route and time order.
Re-previewing refreshes row errors after dependencies change. Invalid previews
offer a row-error CSV download.

## Verification and release

The API integration suite runs only when `TEST_DATABASE_URL` is supplied and
must target an isolated test database. It creates its own fixture users,
sessions, flights and stock. Ordinary unit tests do not connect to a database.

Run `npm test` for unit tests. With a migrated isolated database, run
`TEST_DATABASE_URL=<isolated-test-url> npm test` to include PostgreSQL workflow
and migration checks. Run
`TEST_DATABASE_URL=<isolated-test-url> npm run test:e2e` for the browser workflow;
it starts its own API and web servers on ports 4401 and 4301. Install Chromium
with `npx playwright install chromium`, or set `PLAYWRIGHT_CHROME_CHANNEL=chrome`
to use an installed Chrome. CI runs both the database and browser suites.

Before releasing the service-date migration, restore a production backup into
staging and apply migrations there. The migration derives service dates from
unambiguous committed flight imports where available and otherwise preserves
the existing UTC calendar date. It aborts on flight/date collisions instead of
merging records. Resolve collisions from reviewed source data before retrying.
Historical schedule inconsistencies are flagged for correction rather than
silently changing flight times or financial records.
Legacy report snapshots preserve the historical quantities and metadata still
retained in the database. The report identifies reconstructed historical records;
metadata absent from older revisions is not invented.

Verify a complete import, purser assignment, report submission, returned
correction, Cabin Services forwarding and Catering approval in staging. Confirm
PDF/CSV totals match the report and retrying approval leaves the ledger unchanged.
Production requires HTTPS, secure session cookies and an explicit web origin.
