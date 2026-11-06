# Architecture decisions

The browser PWA stores only Flight Purser draft operations and assigned operational manifests in IndexedDB. Draft retries use stable operation IDs and are scoped to the signed-in user. Nginx exposes one origin, routing `/api` to NestJS and all other requests to the web interface. NestJS owns authorization, validation, optimistic concurrency and transactions. PostgreSQL is the source of truth for business data, audit records, idempotency results, opaque sessions, and login-throttle state. MinIO is provisioned for future supporting documents; CSV import sources currently remain in PostgreSQL with their validated import batch. The same NestJS app is exposed through `pages/api/[...path].ts` when deployed to Vercel, so the web and API share one origin.

The Catering approval is the accounting boundary. A submitted leftovers report remains operational data while Cabin Services reviews and forwards it. Catering approval appends stock movements, updates report state and records the audit event in one database transaction. Catering and Director financial reports aggregate only approved ledger entries.

All financial amounts are integer minor units plus ISO currency code. Current prices have effective date ranges, preserving historical flight costs. All timestamps are UTC in storage and localized in the interface.

Flight matching uses the date-only `serviceDate`; `flightDate` remains the departure timestamp for compatibility. The first sector establishes the service date and later sectors may cross midnight. Imports revalidate inside their commit transaction and the database enforces a unique flight number/service date.

The API is only compatible with a database after all committed Prisma migrations are applied. Deployment runs `prisma migrate deploy` before the API starts; a schema-drift response is a deployment/configuration issue, not a login credential issue.

One current Flight Purser owns each flight report. Loaded quantities freeze on the first draft save. Flight row locks and manifest versions serialize saves, reassignment, submission and review. Retry keys bind the actor, action, resource and operation ID, and a separate request hash rejects changed retry bodies.

Submitted `ReportRevision` snapshots preserve flight, staff, catalog and quantity details. Approval events append their actor names, revision and decision without changing the submitted snapshot. Returned reports display the current saved draft, while explicit revision requests display historical quantities. JSON, CSV, PDF and the report screen use the same report data. Offline drafts remain scoped to the signed-in purser; replay conflicts require visible review before submission.

Future integrations implement adapters for corporate identity, flight schedules, reservation passenger counts and forecasting. These adapters cannot bypass the same validation, authorization or audit boundary.
