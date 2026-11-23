# GAZVA Vision Guard — Firestore Security Specification

## 1. Data Invariants
1. **Default-Deny Catch-All**: All unspecified paths under `/databases/{database}/documents` are strictly denied (`allow read, write: if false;`).
2. **Email Verification Mandate**: Every read/write requires `request.auth != null && request.auth.token.email_verified == true`.
3. **PII Isolation**: User `email` and `photoURL` are stored strictly in `/users/{userId}/private/info` and are only readable/writable by `userId == request.auth.uid` (no `list`).
4. **Master Gate Integrity**: Subcollections (`missions`, `waypoints`, `chatMessages`) require the parent `/users/{userId}` anchor document to exist (`exists(/databases/$(database)/documents/users/$(userId))`) on single-doc operations, while `allow list` validates `resource.data.ownerId == request.auth.uid` directly without `get()`/`exists()`.
5. **Identity Integrity & Immutability**: `uid`/`ownerId` must equal `request.auth.uid` on create and remain unchanged on update. `createdAt` and `updatedAt` must equal `request.time`.
6. **Strict Schema & Size Boundaries**: Every write validates required + allowed keys (`hasAll` + `hasOnly`), exact types, bounded list lengths (`sourceUrls.size() <= 8`), and strict string `.size()` limits to prevent 1MB exhaustion attacks.
7. **ID Poisoning Guard**: Single-doc path IDs (`userId`, `missionId`, `waypointId`, `messageId`) must pass `^[a-zA-Z0-9_\\-]+$` and `<= 128` chars.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: `{}` without `request.auth` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: Auth token with `email_verified: false` writing `/users/u1` -> `PERMISSION_DENIED`.
3. **Identity Spoofing on Create**: User `u1` creating `/users/u1/missions/m1` with `{ ownerId: "u2", ... }` -> `PERMISSION_DENIED`.
4. **Cross-Tenant PII Read**: User `u2` reading `/users/u1/private/info` -> `PERMISSION_DENIED`.
5. **Ghost / Shadow Field Injection**: Creating `/users/u1` with `{ uid: "u1", displayName: "Op", isAdmin: true, createdAt: serverTime, updatedAt: serverTime }` -> `PERMISSION_DENIED`.
6. **ID Poisoning Attack**: Creating `/users/u1/missions/${'A'.repeat(200)}` or `/users/u1/missions/bad$id` -> `PERMISSION_DENIED`.
7. **Orphaned Subcollection Write**: Creating `/users/u1/waypoints/w1` when `/users/u1` does not exist -> `PERMISSION_DENIED`.
8. **Client-Forged Timestamp**: Creating `/users/u1/missions/m1` with `createdAt: Timestamp(1999-01-01)` -> `PERMISSION_DENIED`.
9. **Immutable Owner Tampering on Update**: Updating `/users/u1/missions/m1` to change `ownerId` or `createdAt` -> `PERMISSION_DENIED`.
10. **Value Poisoning on Update**: Updating `classification` in `waypoints` to `"admin_override"` or `score` to `"100"` -> `PERMISSION_DENIED`.
11. **Array Exhaustion / Invalid Element Type**: Creating `chatMessages` with `sourceUrls: [12345]` or 12 items -> `PERMISSION_DENIED`.
12. **Blanket List Query Scraping**: Querying `/users/u1/missions` without owner constraint as user `u2` -> `PERMISSION_DENIED`.
