# Architecture decisions

The browser PWA stores only Attendant draft operations and assigned operational manifests in IndexedDB. Draft retries use stable operation IDs and are scoped to the signed-in user. Nginx exposes one origin, routing `/api` to NestJS and all other requests to the web interface. NestJS owns authorization, validation, optimistic concurrency and transactions. PostgreSQL is the source of truth for business data, audit records, idempotency results, opaque sessions, and login-throttle state. MinIO is provisioned for future supporting documents; CSV import sources currently remain in PostgreSQL with their validated import batch. The same NestJS app is exposed through `pages/api/[...path].ts` when deployed to Vercel, so the web and API share one origin.

Procurement approval is the accounting boundary. A submitted report remains operational data while the assigned Lead reviews and forwards it. Procurement approval appends stock movements, updates report state and records the audit event in one database transaction. Procurement and Director financial reports aggregate only approved ledger entries.

All financial amounts are integer minor units plus ISO currency code. Current prices have effective date ranges, preserving historical flight costs. All timestamps are UTC in storage and localized in the interface.

Future integrations implement adapters for corporate identity, flight schedules, reservation passenger counts and forecasting. These adapters cannot bypass the same validation, authorization or audit boundary.
