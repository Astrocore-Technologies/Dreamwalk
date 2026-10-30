# Account data operations

Account holders request an export from Privacy settings, or confirm account deletion using their password. Deletion immediately ends sessions, anonymizes identity and hides content. It does not silently run an irreversible bulk purge.

Only a trusted operator with database access processes an explicit request. Verify the request and authority before running a command. There is no public processing endpoint or automatic all-queue scan.

```sh
# Substitute the verified request UUID and a non-secret operator reference.
npm run data:process -- --request REQUEST_UUID --operator OPERATOR_REFERENCE
# Physical erasure additionally requires the same UUID as confirmation.
npm run data:process -- --request REQUEST_UUID --operator OPERATOR_REFERENCE --confirm-purge REQUEST_UUID
# Remove a completed export artifact only after its recorded expiry.
npm run data:process -- --request REQUEST_UUID --operator OPERATOR_REFERENCE --expire
```

`DATABASE_URL` and the correct `ASSET_DIR` must point to the intended installation. Never run a test command against the production or preview database. The operator launcher reads local environment configuration; secrets do not belong in command arguments, version control or support messages.

Exports contain an explicit allowlist of the owner's profile, authored data, own activity and media. Password/session/email-token hashes and internal moderation material are excluded. The completed artifact is stored privately in PostgreSQL; only its authenticated owner can download it from Privacy settings for seven days. Expired downloads fail closed before an operator deletes the stored artifact. Schedule expiry processing according to retention policy; this prototype does not run a permanent background worker.

Purge requires a previously confirmed deleted account and matching explicit confirmation. It removes private media/files, NPCs, heroes, invitations, notifications and export artifacts. Historical content is replaced by fixed irreversible tombstones. Database triggers permit only that exact projection for deleted owners; arbitrary history or financial amount changes remain prohibited. Pseudonymous accounting/event/version identifiers remain for integrity. User identity is not reconstructed. Backups, downloaded copies and third-party copies require separate retention procedures.

Each specified operation is audited. Advisory locking serializes processing of the same request. Failure leaves a retryable state; missing files are safe on retry, unsafe stored paths fail closed. Re-running a completed request does not duplicate effects. Never remove database constraints or edit ledger amounts to make processing succeed.

The integration suite uses disposable synthetic accounts and covers ownership, expiry, file deletion, safe failure/retry and immutable-field protection. It does not process real user requests.
