<!-- Fictional example used by `council verify-m2` to test private teammate context. Not real client data. -->

# Client Migration Constraint Audit: BillingService (`/v1/invoices` -> `/v2/invoices`)

## Verified Client Findings
- **Client:** `iOS-FieldApp v3.4` (deployed on offline field-service tablets via enterprise MDM).
- **Release Window Constraint:** `iOS-FieldApp v3.4` follows a strict **quarterly release cycle** and **cannot be upgraded until Q3**. A single-weekend cutover that turns off `/v1/invoices` immediately will break active field tablets in production.
- **Wire & Payload Incompatibilities:**
  1. `iOS-FieldApp v3.4` sends `idempotency_key` inside the JSON request body, whereas `/v2/invoices` requires the `Idempotency-Key` HTTP header.
  2. `iOS-FieldApp v3.4` expects HTTP `200` with integer `amount_cents`, whereas `/v2/invoices` returns HTTP `201` with decimal `amount`.

## Required Migration Constraint
- Keep a `/v1/invoices` compatibility shim running in parallel with `/v2/invoices` until the Q3 `iOS-FieldApp` upgrade completes, translating `idempotency_key` -> `Idempotency-Key` and converting `amount` <-> `amount_cents` with HTTP `200` responses for `/v1/invoices` callers.
