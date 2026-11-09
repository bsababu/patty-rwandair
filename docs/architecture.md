# Architecture decisions

The browser PWA loads and saves signed-in catering runs through NestJS. Nginx exposes one origin, routing `/api` to NestJS and all other requests to the web interface. NestJS owns authorization, validation, optimistic concurrency and transactions. PostgreSQL is the source of truth for business data, audit records, idempotency results, opaque sessions, and login-throttle state. MinIO is provisioned for future supporting documents; CSV import sources currently remain in PostgreSQL with their validated import batch. The same NestJS app is exposed through `pages/api/[...path].ts` when deployed to Vercel, so the web and API share one origin.

The Catering approval is the accounting boundary. A generated leftovers report remains operational data until it is forwarded to Catering. Catering approval appends stock movements, updates report state and records the audit event in one database transaction. Catering and Director financial reports aggregate only approved ledger entries.

All financial amounts are integer minor units plus ISO currency code. Current prices have effective date ranges, preserving historical catering costs. All timestamps are UTC in storage and localized in the interface.

Each catering run is the workflow record. Catering imports create a run identified by flight number and service date, with catalog lines and quantities. Lead and Flight Purser assignments, leftovers drafts, report revisions, review decisions, exports, and approved stock movements reference the run directly. Flight schedules, aircraft, passenger counts, routes, and sectors are outside the Catering workflow. Imports and run mutations revalidate inside their transactions and preserve audit/idempotency guarantees.

The API is only compatible with a database after all committed Prisma migrations are applied. Deployment runs `prisma migrate deploy` before the API starts; a schema-drift response is a deployment/configuration issue, not a login credential issue.

Each run has one Cabin Services lead and may have many assigned Flight Pursers. Pursers share the run's loaded quantities and enter consumed quantities plus optional remarks; returned quantity is derived as loaded minus consumed. Pursers cannot submit final reports. The lead sees live per-run metrics, previews the current report, and generates the final report after service. Generated reports are forwarded to Catering for approval. Run row locks and versions serialize saves, reassignment, generation and review. Retry keys bind the actor, action, resource and operation ID, and a separate request hash rejects changed retry bodies.

Generated run report revisions preserve staff, catalog and quantity details. Approval events append their actor names, revision and decision without changing the generated snapshot. Preview data is not persisted until the lead generates the report. JSON, CSV, PDF and the report screen use the same report data.

Future integrations implement adapters for corporate identity, flight schedules, reservation passenger counts and forecasting. These adapters cannot bypass the same validation, authorization or audit boundary.
