# WhatsApp linked devices — test rollout

This is an unofficial Baileys integration, not Meta Cloud API and not an assurance against account restrictions. Use a test account first. Existing Cloud API code and business data remain intact.

## Runtime

- Node 24, one always-on Railway replica, Serverless OFF. No new paid plan selected.
- PostgreSQL session pooler (5432), not transaction pooler: a dedicated advisory-lock connection fences workers across rolling deployments.
- `WHATSAPP_ENCRYPTION_KEY`: independently generated 32-byte hex key, server-only Railway variable. Preserve it across deployments and encrypted database restores. Never rotate it without a credential migration/relink plan.
- Additive migration 010 stores per-employee sessions, encrypted Signal credentials and durable incoming events. Direct Data API access is denied by RLS and grants.
- npm postinstall removes libsignal console diagnostics that otherwise expose private session objects. It deliberately fails for an unreviewed libsignal version.
- Core support: new one-to-one incoming messages and manually sent text. Media is marked unsupported; group/history imports and bulk/automatic sending are not implemented.

## Reliability and isolation

- Only the signed-in admin/sales account can obtain its own QR and issue connect/reconnect/logout commands. QR responses are no-store, short-lived and suppressed without a worker heartbeat.
- Keys use AES-256-GCM and include employee/category/key identity in the authenticated ciphertext envelope; the API never returns Signal keys.
- Number uniqueness prevents binding another employee's number. Customer conflicts are retained for admin resolution, not silently reassigned.
- New messages are encrypted in a durable event queue, deduplicated per employee/provider ID, and processed transactionally. Unresolved LID-to-phone mappings remain encrypted for retry; no invented phone or name.
- Outgoing IDs are saved before network I/O. Unknown send results are not blindly resent. Delivery/read states use actual library receipt events.
- Socket reconnection uses bounded backoff. Logout deletes only linked-device credentials, never customer/chat records. If remote logout fails while offline, remove the CRM entry in the phone's Linked Devices list too.
- Platform delivery while the service is offline is not guaranteed. This does not promise complete history or lossless recovery of every platform event.

## Acceptance status

Automated tests use a transport double: QR ownership, spoofed employee ID rejection, encrypted persistence, swapped ciphertext rejection, duplicate inbound handling, owner assignment, manual reply receipts, worker recreation and logout retaining chat. They are NOT live WhatsApp evidence.

Before marking a number usable, record: test phone scans a real production QR; another agreed test contact sends text; CRM receives it under the correct owner; CRM sends a manual text; phone actually receives it; second salesperson cannot access the conversation; a real service restart restores the binding. QR must never be copied into logs or screenshots.
