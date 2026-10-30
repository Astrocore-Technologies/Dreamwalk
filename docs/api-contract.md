# Dreamwalk platform API v1

Base `/api/v1`; cookie `dreamwalk_session`, HttpOnly SameSite=Lax. Browser requests include credentials; same-origin Next proxy. All mutations must send `Content-Type: application/json` (except multipart image). Error `{code,message,retryable:false}`. Objects use camelCase, ISO dates, string UUID ids. Lists return arrays unless specified. Auth me returns `{user}` where user is null if unauthenticated. No client-provided role or ownerId is accepted.

## Account

- POST `/auth/register` `{email,password,name,handle}` -> `{user}` and session. Password 10–128 chars; handle lowercase `[a-z0-9_]{3,30}`.
- POST `/auth/login` `{email,password}` -> `{user}`. POST `/auth/logout` `{}` -> `{ok:true}`.
- GET `/auth/me` -> `{user: User|null}`. User: id,email,name,handle,bio,avatarAssetId,role (`user|admin`),onboarded,settings,createdAt.
- PATCH `/account/profile` `{name,handle,bio,avatarAssetId?}` -> User.
- PATCH `/account/settings` any subset `{theme:'dark'|'light'|'system',language:'uk'|'en'|'ru',timezone,notifications,emailNotifications,reducedMotion,profilePublic,defaultVisibility:'private'|'public',genres:string[],purpose:'play'|'create'|'both',replyLength:'short'|'balanced'|'long',animationSpeed:'normal'|'slow'|'none',costHints,confirmExpensive,publicationNotifications,reportNotifications}` -> User.
- POST `/account/onboarding` `{name?,genres?,purpose?,profilePublic?}` -> User.
- GET `/account/sessions` -> `[{id,createdAt,lastSeenAt,userAgent,current}]`; DELETE `/account/sessions/:id` -> ok.
- POST `/account/password` `{currentPassword,newPassword}` -> ok (revokes other sessions).
- POST `/auth/reset-password` `{email}` -> `{ok:true,message}`; mail is unavailable in local prototype, no false delivery claim.
- POST `/account/export` `{}` -> export request `{id,status:'requested',createdAt}`.
- DELETE `/account` `{password,confirmation:'DELETE'}` -> ok, immediately anonymizes account and revokes sessions; queues deletion/purge request. Historical immutable versions/assets require administrative purge before public release; no claim of complete erasure.
- GET `/notifications` -> `[{id,type:'welcome'|'moderation'|'message',payload:{title?,reason?,decision?},title,message,read,createdAt}]`; translate built-in type client-side, retain authored reason verbatim; PATCH `/notifications/:id` `{read:true}` -> ok.

## Public catalog

- GET `/adventures?q=&genre=&sort=popular|new|updated` -> Adventure[]. Approved snapshots only; an edited draft does not replace the last approved public version. Search and filters inspect approved snapshot fields only.
- GET `/adventures/:slug` -> Adventure detail with `npcs` public preview, `versions` summaries. Private stories require owner or an accepted invitation; knowledge of a link never grants access. Public detail uses the approved snapshot; the author sees the current draft.
- GET `/creators/:handle` -> `{creator:{id,name,handle,bio,avatarAssetId},adventures:Adventure[]}`.
- GET `/genres` -> string[]. GET `/models` -> ModelProfile[] (public safe).
- Adventure: id,ownerId,slug,title,synopsis,genre,tags:string[],cover (`observatory|forest|sea|city`),coverAssetId,playersMin,playersMax,duration,difficulty,status,visibility,version,content:{world,rules,locations:[{id,name,description}],npcIds:string[],scenes:[{id,name,locationId,description}],startSceneId,boundaries:string[]},author:{name,handle},createdAt,updatedAt,favoriteCount.

## Personal content

- GET `/library` -> `{favorites:Adventure[],drafts:Adventure[],heroes:Hero[]}`.
- PUT `/favorites/:adventureId` `{}` -> ok; DELETE same -> ok.
- GET/POST `/heroes`, PATCH/DELETE `/heroes/:id`. Hero body `{name,portraitAssetId?,backstory,notes,traits:string[]}`.
- GET/POST `/npcs`, GET/PATCH/DELETE `/npcs/:id`. NPC body `{name,age,role,personality,appearance,biography,secrets,greeting,modelProfileId?,visibility:'private',portraitAssetId?}`. Secrets owner/admin only.
- GET/POST `/studio/adventures`, GET/PATCH `/studio/adventures/:id`. POST requires title; defaults filled. PATCH accepts adventure metadata/content, visibility private/public, and author lifecycle draft/archived. Lifecycle pending_review/published is server-controlled. Editing published creates a draft without mutating published version.
- POST `/studio/adventures/:id/duplicate` `{}` -> new Adventure.
- GET `/studio/adventures/:id/versions` -> `[{id,version,createdAt,snapshot}]` owner only.
- POST `/studio/adventures/:id/submit` `{}` -> Adventure, pending_review. Requires title/synopsis/world/location/startScene and valid owned NPC references. Play remains unavailable.
- POST `/reports` `{adventureId,reason}` -> report.
- GET `/assets` -> Asset[]. POST `/assets` multipart `file` -> `{id,url,width,height,mime,createdAt}`. Raster PNG/JPEG/WebP only <=5MB <=4096 per dimension, reencoded webp, ACL. GET `/assets/:id/file` image (owner or attached to published public content).

## Wallet/admin

- GET `/wallet` -> `{balance,mode:'demo',ledger:[{id,amount,reason,sourceKey,createdAt}]}`.
- GET `/store/packages` -> `[{id,name,credits,demo:true,available:false}]`; there is NO checkout endpoint.
- Admin routes require admin DB role. GET `/admin/overview` -> counts. GET `/admin/users?q=`, `/admin/adventures?status=`, `/admin/npcs`, `/admin/reports`, `/admin/audit`, `/admin/models`, `/admin/runtimes` -> arrays.
- POST `/admin/adventures/:id/moderate` `{decision:'approve'|'reject'|'quarantine',reason}` -> Adventure. Approve snapshots immutable version and publishes; rejection returns draft.
- PATCH `/admin/users/:id` `{role:'user'|'admin'}` -> User (cannot remove own admin).
- PATCH `/admin/reports/:id` `{status:'resolved'|'dismissed',resolution}` -> report.
- POST/PATCH `/admin/models[/:id]` `{key,name,description,instructions,enabled}` -> ModelProfile (version increments). Initial Green Apple and Cookie.
- POST/PATCH `/admin/runtimes[/:id]` `{name,provider:'mock'|'openai'|'local',model,enabled,endpointId:'mock'|'openai'|'local',maxInputTokens,maxOutputTokens,timeoutMs,concurrency}` -> RuntimeProfile. Non-mock must remain disabled in this milestone; fixed endpoint identifiers prevent SSRF; no API keys accepted.
- POST `/admin/credits` `{userId,amount,reason,idempotencyKey}` -> wallet. Integer nonzero amount, bounded ±100000; atomic, nonnegative; repeat same key/payload no duplicate, mismatched replay 409. Append-only ledger; compensation via new signed entry. Every admin mutation audited.

## Additional safety semantics

Published adventure versions include a public-safe NPC preview snapshot. Later private NPC edits cannot alter the approved preview or reveal secrets. Owner studio responses remain current editable drafts. `GET /models` omits server-only behavior instructions. Errors include stable codes; frontend translates safe messages using locale and must not assume Russian UI. Email reset responds `code: EMAIL_DELIVERY_UNAVAILABLE` with no sent-mail claim.

## Taxonomy

`GET /admin/taxonomy` and `PATCH /admin/taxonomy` read/save `{genres:string[],tags:string[]}`. Genres 1–50, tags 0–100, each unique trimmed string 2–40 chars. Admin-only and audited. `GET /genres` and `GET /tags` expose active lists. Existing authored content strings are never destructively renamed.

## Mandatory publication policy (supersedes legacy link access)

Exactly two visibility values are supported: `private` and `public`. Lifecycle is separately `draft | pending_review | published | archived`. Migration 004 converts every former unlisted item to private with no implicit recipients; standalone NPCs are always private definitions. New adventures default to private. Public visibility alone does not publish anything: only moderation approval creates a public snapshot. Editing an already-public adventure retains its last approved immutable version until re-review. Switching visibility withdraws the public snapshot and revokes active invitations; switching back to public requires a fresh moderation approval.

Private previews and media require the author or an explicitly accepted invitation; administrator role does not bypass private content ACL. Admin moderation can inspect public submitted content, never publish a private adventure. Invited readers cannot use studio editing/version endpoints or direct NPC-secret endpoints. Shared previews omit NPC secrets and biography. Asset responses use `Cache-Control: no-store` so a new request after revocation rechecks authorization; copies already downloaded cannot be remotely revoked.

### Invitation contract

- `GET /studio/adventures/:id/invitations` → `Invitation[]`, owner-only.
- `POST /studio/adventures/:id/invitations` `{handle}` → pending Invitation for an existing user. Private non-archived story only, maximum 50 active recipients. Repeating a pending/accepted invitation does not duplicate it or spam notifications.
- `DELETE /studio/adventures/:id/invitations/:inviteId` → `{ok:true}`, owner revokes immediately.
- `GET /invitations` → current user's pending/accepted invitations to active private stories.
- `POST /invitations/:id/respond` `{decision:'accept'|'decline'}` → Invitation. Pending is not access; only acceptance grants read-only preview. Decline or owner revocation removes access immediately; revoked invitation cannot be accepted without a new owner invitation.
- `GET /library` adds `shared: Adventure[]` for accepted private invitations. Favorites are filtered through the same ACL on every read.
- `GET /adventures/:slug` adds `access:'owner'|'invited'|'public'|'reviewer'` and `readOnly:boolean`. Reviewer applies only to administrators viewing PUBLIC moderation submissions.

Invitation shape: `{id,adventureId,adventureSlug,adventureTitle,owner:{id,name,handle},recipient:{id,name,handle},status:'pending'|'accepted'|'declined'|'revoked',createdAt,updatedAt}`.

New notification `type:'invitation'`, payload `{adventureId,adventureTitle,inviter}` is stored transactionally on first invitation/reopening. Frontend translates the notification shell, not the authored title/name.

Upload quota is 200 assets / 100 MiB per user in addition to the 5 MiB individual upload and 4096×4096 decode limits. Session guard precedes multipart parsing; authoritative quota checks serialize on the owner row. Quota failure is HTTP 413 with `ASSET_QUOTA_EXCEEDED`.

## Adventure metadata languages — original authored once

Only adventure `title` and `synopsis` have optional translations. Scene, world and NPC text remain original. No translator, provider call, paid generation, job worker or automatic translation is implemented/enabled in this platform milestone. New stories are source-only; writing one original is sufficient.

Adventure metadata adds:

- `sourceLanguage: 'uk' | 'en' | 'ru'`. New creation without an explicit value uses the authenticated account language. Legacy stories default to `ru`.
- `sourceRevision: number`, server-controlled, initially 1.
- `translations: {uk?:{title?:string,synopsis?:string,sourceRevision:number},en?:...,ru?:...}`.

`selectAdventureText(metadata, locale)` from `@dreamwalk/contracts` returns `{title,synopsis,sourceLanguage,translationStatus:'disabled'|'ready'|'stale',isFallback}`. It selects each nonempty field only if its translation revision matches the original revision, otherwise falls back to the original field. Originals stay stored and are always the values in author editing forms. Status `disabled` means there is no valid prepared translation for that locale; it does not promise background translation. Curated demo translations are clearly fixtures, not provider output.

Changing original title, synopsis or source language increments the revision atomically. Existing translations remain in author storage as stale drafts. Ordinary adventure PATCH ignores client-supplied `sourceRevision` and `translations` even in a full-form resubmit: it cannot reconfirm or forge them. Reader DTOs retain stale revision markers but omit stale translated text.

Optional advanced correction endpoint:
`PATCH /studio/adventures/:id/translations/:locale` body `{title?,synopsis?,expectedSourceRevision}`.
It is owner-only. This explicit save/reconfirm updates that locale's stored revision; a mismatched original revision returns HTTP409 `SOURCE_REVISION_CONFLICT`. It is not a required authoring step. The action creates an author draft and never updates the last public approved snapshot. Public translation changes require moderation like original changes. Old immutable adventure versions stay unchanged.

Public catalog search matches original or valid translated fields only from the approved snapshot. Invitations add optional `adventureMetadata` of the same source/translation shape; new invitation notifications include a safe metadata snapshot. Old notifications keep their original title fallback.

Migration005 adds metadata defaults only to editable records, not historical immutable version rows. Seed fixtures include curated RU/UK/EN titles and synopses. Existing unchanged editorial fixtures receive a new immutable version for this metadata upgrade; repeated seed is a no-op, and user-edited records are not overwritten.

### Account data operator processing

- `GET /account/exports`: authenticated owner's request metadata `{id,status,createdAt,completedAt,expiresAt}`; expired artifacts never appear ready.
- `GET /account/exports/:id/download`: owner-only JSON attachment; completed/unexpired only, otherwise 404; no bearer sharing URLs or caching.
- Explicit operator command: `node scripts/env-run.mjs node scripts/process-data-request.mjs --request <UUID> --operator <audit-reference>`.
- Deletion requires the previously confirmed/deleted account plus `--confirm-purge <same-UUID>`. No implicit queue draining. Processing failures retain retryable request state; rerun the exact request. Completed requests are no-ops.
- Exports expire after seven days. An operator explicitly runs the same command with `--expire` to physically clear an expired artifact. Expired artifacts cannot be downloaded even before cleanup. Schedule this retention operation in production; no scheduler is silently installed.
- Exports are private PostgreSQL JSON artifacts with an explicit allowlist and owned media bytes, not public filesystem links. They exclude password/session hashes, internal audit and other users' private content.
- Purge removes media files and mutable personal content, revokes/removes invitations, clears export artifacts, tombstones immutable owned story snapshots and personal ledger reasons/source keys while preserving amounts/version IDs and minimal audit history. The DB trigger allows only exact irreversible tombstone projections for a confirmed deleted account; arbitrary historical changes remain forbidden.
- Database backups and independently downloaded copies are not erased by this command. Backup expiry and lawful retention require an operator policy. Pseudonymous account/event IDs and monetary history remain; this is not a promise of removing every third-party mention or all copies globally.

### NPC original language and optional localized public text

NPC originals now include `description`, `sourceLanguage` (`uk|en|ru`), server-owned `sourceRevision` and optional `translations[locale]` containing `name/description/role/personality/appearance/greeting` plus `sourceRevision`. Biography and secrets are not valid translation fields. Authors still write once; translation providers remain disabled.

- `selectNpcText(metadata, locale)` selects nonempty revision-matching fields independently, otherwise originals; `safeNpcMetadata` removes stale text from reader DTOs.
- `PATCH /npcs/:id/translations/:locale` accepts optional public fields and required `expectedSourceRevision`; owner only, stale revision409. This advanced correction API is not a required publication step.
- Ordinary NPC create forces revision1/empty translations; original edits increment revision and cannot reconfirm variants by resending them. Source language defaults to account preference.
- Public adventure approval pins safe NPC originals and localized variants into the immutable version. Subsequent NPC edits cannot change already approved previews; new publication approval is required. Seed translations are curated first-party content only, upgraded append-only without changing historical versions.

## Local hybrid game prototype (protocol 1)

All routes below use the existing authenticated cookie session and remain scoped to
accepted campaign membership. `POST /api/v1/game/campaigns` accepts only
`{"template":"observatory-v1"}`; it does not launch arbitrary public/private stories.

| Route below `/api/v1/game`              | Behavior                                                      |
| --------------------------------------- | ------------------------------------------------------------- |
| `GET /campaigns`                        | Own accepted/pending campaign list                            |
| `POST /campaigns`                       | New isolated pinned fixture campaign                          |
| `GET /campaigns/:id/members`            | Accepted member roster, no session data                       |
| `POST /campaigns/:id/invitations`       | Owner invites existing `username` (handle)                    |
| `POST /campaigns/:id/accept`            | Intended recipient accepts membership                         |
| `DELETE /campaigns/:id/members/:userId` | Owner revokes another member                                  |
| `GET /campaigns/:id/snapshot`           | Viewer-specific map/entities/own inventory                    |
| `POST /campaigns/:id/move`              | Strict target input with epoch, generation and input sequence |
| `POST /campaigns/:id/stop`              | Stop at authoritative position, not client coordinates        |
| `POST /campaigns/:id/commands`          | Versioned idempotent action, encounter or mock-NPC command    |
| `WS /socket?campaignId=:id`             | Cookie/Origin authenticated private snapshots/deltas          |

Commands carry `protocolVersion:1`, UUID `operationId`, type (`action`,
`encounter.begin`, `encounter.intent`, `npc.request`), corresponding typed payload
and optional `expectedRevision`. The actor comes from the session, never the body.
A repeated actor/operation/payload returns its stored result; a different canonical
payload with the same operation ID returns `IDEMPOTENCY_CONFLICT`. Rejected domain
actions have `status:rejected` and a semantic code, never invented success narration.

Movement is a bounded path goal processed on fixed server ticks. It does not accept
speed or elapsed client time. Server stop clears the path and advances generation.
Opening a new control socket rotates the actor's lease; the superseded socket closes
with `4001` without stopping its replacement. Access/session revocation closes with
`1008`. Ping/pong detects silent connections. Each outbound projection rechecks access.

Deltas currently contain a complete allowed projection, with stream-local revision
and base revision rather than raw cross-campaign event payloads. A gap requests a fresh
snapshot. Global event sequence, other inventories and NPC private context are not
part of this public transport. Snapshot/command state is derived from server rules;
the client cannot submit a replacement world.

The prototype's encounter is one coordinated round followed by exploration. Full
combat, author map publishing, paid providers, billing and Discord are not implemented
by these endpoints. See `game-acceptance.md` for actual verification and remaining gates.

### Authored playable versions (mock-only extension)

Playable authoring is separate from public narrative DTOs. An ordinary story is not
implicitly a playable map. Only a validated, compiled immutable package can start a
new authored campaign.

- `GET /studio/adventures/:id/playable-draft`: owner-only `{draft,revision}`, null/0 initially.
- `PUT /studio/adventures/:id/playable-draft`: `{expectedRevision,draft}`; bounded strict
  authored-grid schema, owned NPC/location references and domain map validation. A stale
  revision is rejected. Changing a map invalidates a pending submission but preserves
  the last approved public version.
- `POST /studio/adventures/:id/playable-versions`: `{expectedRevision}` freezes a private
  test package and returns `{versionId}`. Identical packages are reused; versions are
  immutable and bounded per story. Compilation is not public approval.
- `GET /studio/adventures/:id/playable-versions`: owner-only version metadata.
- `GET /game/adventures/:id/playable-versions`: only versions available to that reader;
  private invitees require accepted source-story invitation, public readers see the
  current approved version. No raw package or private NPC memory is returned.
- `POST /game/campaigns`: legacy `{template:"observatory-v1"}` or new
  `{playableVersionId}`. Each campaign pins the chosen source package, initial maps,
  NPC/item definitions and a fixed bundled asset ID/checksum. Author edits do not
  silently upgrade existing campaigns. New public starts require the latest approved
  package; already-running campaigns retain their previous approved package while the
  source remains available.
- Story submit freezes the exact playable package for review. Approval binds that
  package to the immutable narrative version. Moderator inspection uses
  `GET /admin/adventures/:id/playable-review`, admin/public/pending only: the submitted
  map topology and safe entity labels/placements, never private NPC brains or secrets.
  Narrative-only submissions return `compiled:null`; read failures do not enable approval.
  Playable approval requires `reviewedPlayableVersionId` matching the pending immutable
  version under the locked submission row; missing or stale review binding returns
  `409 STALE_REVIEW`. Narrative-only approval does not require this field.

Campaign membership is not permission to read a private source. Source permission is
checked at entry, each outgoing projection and durable mutation. Private invitation
revocation closes access; archive/withdrawal suspends source access without deleting
party progress. Pending mock jobs are cancelled on source invalidation/revocation.

### Multiple local rounds and persistent mock decisions

Authored `hybrid-v2` campaigns add `encounter.join` with `encounterId` and
`encounter.end` commands, using the existing operation ID/version envelope. Join is
queued until a safe round boundary; blocked/remote joins cannot teleport. Ending is
an explicit participant vote, with a bounded configured maximum round count. Flee is
a checked action from the boundary, not unrestricted movement out of a conflict.
Each round consumes locked intentions once, persists the next deadline and defaults
missing intentions safely. Other maps keep exploring. Legacy `observatory-v1` saves
retain the previously tested one-round behavior.

`npc.request` may identify an authored `npcId`. It queues a durable mock-only proposal,
with context/target revisions and a deadline. On acceptance, at most three allowlisted
steps execute through normal world rules. The NPC may approach, transfer an item it
already owns and patrol; it cannot mint currency/items or execute generated code.
Every step revalidates current conditions. Bounded observed-event facts (16) and plan
cursor are private saved state; projection schemas exclude them. Recovery can replan
an unfinished accepted NPC movement from its checkpoint, but never resumes old player
input or connection leases. No autonomous unbounded planning or paid background work.

Account export contains an author's own playable drafts/packages separately and a
player's own mock-request metadata only (not proposals/other players' inventories).
Confirmed source-author erasure tombstones the source package and dependent campaign
state/history, pauses those campaigns and clears contextual jobs; deleting a party
member preserves the remaining world while removing that actor's current references.

### Studio draft autosave concurrency

Existing adventure and NPC owner DTOs expose `editRevision`. Their ordinary PATCH and
optional translation correction accept `expectedEditRevision`; under a row lock a
stale token returns HTTP409 `STALE_STATE` without changing data. Actual narrative/NPC
changes increment the token, including translation changes. Narrative and playable-map
revisions are independent; map saves do not manufacture narrative conflicts. Save
responses contain the exact committed row/revision, not a later post-commit SELECT.

The client debounces valid existing drafts and serializes requests. Edits made while a
request is in flight remain local and are sent using its acknowledged revision. Manual
save/playtest uses the same pending work rather than issuing a concurrent write.
Invalid fields remain local; a visible status explains why they are not yet saved.
Network failure has an explicit retry; a version conflict stops automatic retry and
never silently replaces local input. Reloading server data requires confirmation.
First creation of a new adventure/NPC remains an explicit save, clearly indicated;
subsequent edits autosave. Publication and approval remain explicit operations.

### Connection grace and offline simulation

The gateway checks session/source authorization every second. Peer silence has a
2-second movement-stop threshold sampled by that loop (not a hard 2.000-second wall
clock guarantee) and a 5-second close threshold. A temporarily stalled browser keeps
its connection during the grace period but must use the updated movement generation;
old input cannot resume. A peer that never responds is closed and its lease stopped.

When the last live player disconnects, the campaign checkpoints and pauses immediately.
HTTP-only inactive presence expires after five seconds. A paused hot lease may remain
cached briefly for heartbeat recovery, but simulation and NPC ticks do not advance.
Migration 015 stores remaining round durations and queued mock-job due/expiry durations
atomically with the authoritative checkpoint. First authorized resume restores deadlines
as current time plus the saved remainder, once under the campaign writer; reconnect does
not consume offline time or replay missed rounds. Process crash recovery uses the last
durable remaining-time checkpoint, conservatively recovering up to a checkpoint interval
rather than inventing elapsed offline play. Other connected participants keep their
campaign running, including players on other maps.

No client access means no endless background NPC simulation/provider loop. Autonomous
event-driven NPC decision starts are a future approved direction; current mock decisions
remain explicitly requested and bounded.
