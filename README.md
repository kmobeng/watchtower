# WatchTower

HTTP uptime and incident monitoring. Checks run from a regional worker fleet,
quorum decides when a monitor is down, and incidents escalate through
notification channels. Results feed uptime rollups, a live dashboard feed, and
public status pages.

## Quick start

The whole stack — Postgres, Redis, Mailpit, the API, a checker worker, and a
one-shot migration step — runs from the repo root:

```bash
$ docker compose up --build
```

`migrate` applies pending Prisma migrations and exits; `api` and `worker` only
start once it succeeds. The API is on http://localhost:3000 and Mailpit on
http://localhost:8025. Compose overrides `DATABASE_URL` and `REDIS_URL` to the
service names, so the `localhost:5433` values in `.env` only apply when running
the app on the host.

The image is a two-stage build: dev dependencies generate the Prisma client and
compile `dist`, and the runtime stage installs production dependencies only.

## Local development

Requires Node.js 24 plus Postgres, Redis, and (for email) Mailpit. The Compose
file can start just the dependencies:

```bash
$ docker compose up -d postgres redis mailpit
$ cp .env.example .env
$ npm install
$ npx prisma migrate dev
$ npx prisma generate
```

`prisma migrate dev` does not refresh the generated client in this setup, so
`prisma generate` is a separate step.

The API schedules checks but does not run them. Each region has its own worker
process, and checks only happen while a worker is running:

```bash
# terminal 1: API (schedules every region in CHECK_REGIONS)
$ npm run start:dev

# terminal 2: worker for the region in CHECK_REGION
$ npm run start:worker:dev
```

Set `CHECK_REGIONS` on the API to the comma-separated fleet and `CHECK_REGION`
on each worker to the region it probes. See `.env.example`.

For a production build:

```bash
$ npm run build
$ npm run start:prod
```

## How checks work

Each monitor chooses how it is probed:

| Field                     | Meaning                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `method`                  | `GET` (default), `HEAD` or `POST`                                     |
| `timeoutMs`               | Hard limit; a slower response is aborted and recorded as a timeout    |
| `responseTimeThresholdMs` | Optional slow limit. A successful response above it is recorded down  |
| `failureThreshold`        | Consecutive failures before a region counts as down                   |

`responseTimeThresholdMs` must be below `timeoutMs`, otherwise the timeout
always fires first and the slow limit could never apply. The worker stores the
derived `state` on the monitor — `up`, `suspicious`, `down` or `unknown` — and
`GET /monitors` returns it alongside the computed `flapping` flag. `suspicious`
means failures exist but have not reached `failureThreshold`, so no incident is
open yet.

Each scheduled check is claimed in Redis under
`check-lock:{region}:{monitor}:{scheduledTime}` before probing. A duplicate
delivery of the same slot within a region is skipped, and the claim is released
early only when an attempt fails so BullMQ's retry can run.
`CHECK_LOCK_TTL_SECONDS` (default 300) controls how long a successful claim is
retained.

## Flapping detection

Each verdict is recorded in Redis as an up/down transition for its monitor. More
than `FLAP_MAX_CHANGES` transitions (default 5) inside `FLAP_WINDOW_SECONDS`
(default 1800) marks the monitor as flapping: the escalation sweep and outbox
poller suppress alerts while the incident itself stays open. Once the monitor
stops changing state for a full window, the flag expires and the escalation
chain resumes from where it stopped. `GET /monitors` and `GET /monitors/:id`
expose the computed `flapping` boolean.

## Uptime rollups

Raw checks grow without bound, so graphs read from a pre-aggregated table
instead of scanning history. `check_rollups` stores additive counters per
monitor, region, granularity (`HOUR`/`DAY`) and UTC bucket start: check count,
up count, and the response-time sum of successful checks. Uptime percentage and
average response time are derived on read, so combining regions cannot
accumulate rounding drift.

The API process recomputes the previous two completed hourly buckets at five
minutes past each hour UTC, and the previous two completed days at 00:10 UTC.
A Redis lock per bucket keeps multiple API instances from doing the same work;
the upserts are idempotent, so a lost lock or a Redis outage only costs a
duplicate computation.

`GET /api/v1/monitors/:id/uptime` returns materialized buckets for the
authenticated owner:

```text
?granularity=hour|day   defaults to hour
&from=<ISO 8601>        defaults to 24h ago (hour) or 30d ago (day)
&to=<ISO 8601>          defaults to now
&region=<name>          optional; combined across regions when omitted
```

The range is capped at 1000 buckets. Buckets are aligned to UTC boundaries, and
only buckets that have already been materialized are returned. Average response
time covers successful checks only; uptime counts every check.

Backfill existing history from the CLI (it boots no cron jobs; the npm script
compiles the project first, then runs the compiled CLI):

```bash
# hourly buckets for the last 7 days
$ npm run rollup:backfill -- --granularity hour

# an explicit window
$ npm run rollup:backfill -- --granularity day \
    --from 2026-01-01T00:00:00Z --to 2026-03-01T00:00:00Z
```

## Live dashboard feed

Dashboard clients subscribe to the Socket.IO namespace `/dashboard` and receive
incident changes pushed from the API and worker processes. No polling is
involved.

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/dashboard', {
  auth: { token: accessToken }, // Bearer prefix is also accepted
});
```

The handshake token is verified before the client joins any room; an invalid or
missing token is disconnected immediately. A connection also closes when the
token's `exp` passes. Each client joins `user:{sub}` and receives only its own
incidents.

On connect the server emits `dashboard:snapshot` with the authoritative open
incident set (`OPEN`, `ACKNOWLEDGED`, `ESCALATED`). Replace the local open set
with that snapshot, then apply the lifecycle events idempotently:

| Event                   | When                                                     |
| ----------------------- | -------------------------------------------------------- |
| `incident:opened`       | Quorum opened an incident                                 |
| `incident:acknowledged` | A user acknowledged it                                    |
| `incident:escalated`    | An escalation step after the first alert fired            |
| `incident:resolved`     | Quorum resolved it                                        |
| `incident:updated`      | Escalation step 0 fired (status is still `OPEN`)          |

Every event carries `{ event, incident, occurredAt }`. The incident payload
includes `userId`, `status`, `cause`, `startedAt`, `acknowledgedAt`,
`resolvedAt`, `downtimeSeconds`, `escalationStep` and `nextEscalationAt`
(ISO-8601 strings, nullable where appropriate).

The worker opens and resolves incidents, so it publishes to the Redis channel
`dashboard:incident-events`. Every API instance subscribes and fans the message
out to its own sockets. Publishing is best-effort: the database transition is
already committed, and a reconnecting client recovers from the snapshot.
`WS_CORS_ORIGIN` (comma-separated) controls the namespace's allowed origins and
defaults to `*`.

## Public status pages

A status page publishes uptime and incident history for a chosen set of monitors
at a guessable URL. Create one (authenticated), then embed it anywhere.

```bash
# create; the slug is normalized to lowercase
$ curl -X POST http://localhost:3000/api/v1/status-pages \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"slug":"acme","monitorIds":["<uuid>"],"isPublic":true,"title":"Acme Status"}'
```

| Method   | Path                        | Auth | Purpose                    |
| -------- | --------------------------- | ---- | -------------------------- |
| `GET`    | `/api/v1/status-pages/:slug` | none | the public page            |
| `GET`    | `/api/v1/status-pages`       | JWT  | list your pages            |
| `POST`   | `/api/v1/status-pages`       | JWT  | create                     |
| `PATCH`  | `/api/v1/status-pages/:id`   | JWT  | update                     |
| `DELETE` | `/api/v1/status-pages/:id`   | JWT  | delete                     |

There is intentionally no authenticated `GET /status-pages/:id`: the public read
owns `GET /status-pages/:slug`, and two param routes at the same depth would
collide. Use the list endpoint for editing.

The public response carries, per listed monitor: its `url`, a derived `status`
(`up`, `down` or `unknown`), the 24-hour `uptimePct` and `avgResponseTimeMs`, the
hourly `buckets`, and the newest 10 incidents from the last 30 days. Uptime comes
from the materialized rollups, so it covers completed hourly buckets only; the
current `status` comes from an open incident, else the latest check, else
`unknown` when the monitor has not been checked in 24 hours.

`GET /status-pages/:slug` is the only route in the API with a CORS header
(`Access-Control-Allow-Origin: *`, plus `Cache-Control: public, max-age=30`), so
external sites can embed it. Every other route stays without CORS.

Two details worth knowing:

- An unpublished or unknown slug both return `404`, so the endpoint does not
  reveal whether a page exists.
- `monitorIds` is validated on write: listing a monitor you do not own is
  rejected, since it would publish someone else's uptime. On read the list is
  re-scoped to the page owner, so a deleted monitor silently drops off the page.

The page exposes each monitor's `url` as its label, because monitors have no
`name` field yet.

## Tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```
