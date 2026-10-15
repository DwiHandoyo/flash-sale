# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A take-home flash sale system: one product, limited stock, one item per user, a configurable sale window. The scope is the assignment only: anything beyond it goes under "Not built" (docs/07, D17), not into the code.

All documentation, README text, code comments and docstrings are written in English.

## Documentation is part of every change

The design documents in [docs/](docs/README.md) are the source of truth for how the system behaves. Read the relevant document before changing code. When you change anything they describe (behaviour, an endpoint or response code, a key, queue or table, a timeout or limit, a service, a command or a test), update the matching document, and [README.md](README.md) if it mentions the same thing, in the same change. A change is not done while code and docs disagree.

| If you change…                                                               | Update                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Scope, requirements, assumptions                                             | [01-overview](docs/01-overview.md)                                                                        |
| Components, how they connect, the system diagram                             | [02-architecture](docs/02-architecture.md) and the diagram in README                                      |
| The purchase rules, the reserve script, publishing, the worker's batching    | [03-purchase-flow](docs/03-purchase-flow.md)                                                              |
| Redis keys, RabbitMQ queues, PostgreSQL tables or constraints, the lifecycle | [04-data-model](docs/04-data-model.md)                                                                    |
| Endpoints, status values, response codes, `Retry-After`                      | [05-api](docs/05-api.md) and the API table in README                                                      |
| Recovery, draining, reconciliation, consistency guards                       | [06-consistency-and-recovery](docs/06-consistency-and-recovery.md)                                        |
| A design decision or trade-off                                               | [07-decisions](docs/07-decisions.md) (add or edit a numbered decision) and the trade-offs table in README |
| What happens in a failure or race                                            | [08-scenarios](docs/08-scenarios.md)                                                                      |
| Tests, the stress test, its checks or chaos faults                           | [09-testing](docs/09-testing.md) and the test and stress sections in README                               |
| Docker Compose services, ports, images, scheduling, local vs production      | [10-infrastructure](docs/10-infrastructure.md)                                                            |
| Folder layout, the `shared` package, layers, patterns                        | [11-code-structure](docs/11-code-structure.md)                                                            |
| The production design or `infra/aws/`                                        | [12-cloud-deployment](docs/12-cloud-deployment.md)                                                        |

If the change affects numbers quoted in the README (test counts, stress-test results), rerun what produced them and update them, or say in the change that they are now out of date. Keep each document's "In short" summary true, and keep the docs short: change the sentence that is wrong rather than appending a new one.

## Commands

npm workspaces (`packages/*`, `apps/*`, `tools/*`), Node.js 22.12 or newer.

```bash
npm ci
npm test                    # unit tests in every workspace, no infrastructure needed
npm run infra:up            # Redis, RabbitMQ and PostgreSQL from docker-compose.yml
npm run test:integration    # needs infra:up
npm run lint && npm run typecheck
npm run format              # Prettier
npm run build               # esbuild bundles each backend app to dist/main.mjs; web: tsc + vite build
```

- **One test file or one test:** `npm test -w @flash-sale/api -- test/unit/use-cases.test.ts -t "repeat purchase"`. For integration tests, use `npm run test:integration -w @flash-sale/jobs -- -t "recover"`.
- **Vitest projects:** the backend packages (`api`, `worker`, `jobs`, `shared`) have separate `unit` and `integration` projects, with tests in `test/unit` and `test/integration`. `web` and `tools/stress` have a single project.
- **Integration test isolation:** the tests use Redis database 1, the `flash_sale_test` database and their own queue names, so they never touch a running demo. A global setup fails fast with a hint when the infrastructure is down.
- **Development without Docker images:** run `npm run jobs -w @flash-sale/jobs -- bootstrap` once, then `npm run dev -w @flash-sale/api` (port 3000), `npm run dev -w @flash-sale/worker` and `npm run dev -w @flash-sale/web` (port 5173, proxies `/api` to 3000). Dev mode connects to PostgreSQL directly on port 15432.
- **Whole system:**
  - `docker compose up --build -d --wait`, then open http://localhost:8080.
  - One-off jobs: `docker compose run --rm jobs reset --stock 100 --starts-in 10 --duration 3600`; `reconcile` and `recover` work the same way.
  - An existing volume keeps its old sale, so reset it before a demo.
- **Stress test:** `npm run stress`.
  - Options: `--users`, `--stock`, `--connections`, `--double-click`, `--pollers` (users polling the status, to measure the CDN cache), `--chaos kill-api|kill-worker|stop-postgres|restart-redis|wipe-redis`.
  - Environment variables: `REDIS_APPENDFSYNC=everysec` for the fsync comparison, `WORKER_REPLICAS=20` to scale the workers out.
  - It rebuilds the images (cached), starts the stack and resets the sale. It exits with 1 if any of the 8 data-store checks fails.
  - The orchestrator runs on the host (`tools/stress/src/run.ts`). The load generator (`load.ts`) runs as the `stress` Compose service inside the Docker network.

## Architecture

**Redis decides, RabbitMQ and PostgreSQL record.**

1. **The API** (Fastify) runs a Lua script, `apps/api/src/adapters/redis/reserve-script.ts`. The script checks, in order: is the sale initialised, is it paused, has this user already bought, is it inside the window (by Redis `TIME`), is there stock. Then it reserves the unit.
2. **The API publishes the order** to the RabbitMQ quorum queue `orders`. It answers `201` only after the publisher confirm.
3. **Workers save orders in batches** with one SQL statement: an insert with `ON CONFLICT DO NOTHING`, plus `sold_count += inserted`, guarded by `CHECK (sold_count <= total_stock)`.

The API never touches PostgreSQL, and the worker never touches Redis.

- **Reservations are completed, never cancelled.**
  - A repeat purchase (`already_purchased`) publishes the order again.
  - The `reconcile` job, which the scheduler runs at `endsAt` and 5 minutes later, publishes every Redis buyer that has no PostgreSQL order.
  - Duplicates are harmless: `order_id` is the primary key, and the worker counts duplicates as skipped.
- **Worker failure handling** (`apps/worker/src/adapters/rabbitmq/order-consumer.ts`):
  - On `DependencyUnavailableError` it retries the batch in place with backoff and never nacks, so the delivery limit (10) is not used up during a database outage.
  - When data is refused (SQLSTATE class 22 or 23, see `classifyPgError`), it splits the batch and dead-letters only the culprit.
- **Recovery** (`apps/jobs/src/app/recover.ts`): set the `paused` flag → wait until the queue is drained → stop if the dead-letter queue is not empty → rebuild Redis from PostgreSQL → resume.
  - Bootstrap runs this procedure itself when Redis is empty while orders exist, or when the sale is still paused.
  - Otherwise bootstrap _merges_ PostgreSQL buyers into Redis. It never overwrites Redis, which may hold reservations not yet saved.
- **Apps per role:** `api`, `worker`, `jobs` (a CLI: bootstrap, reconcile, recover, reset, schedule) and `web`, plus `packages/shared`.
  - `shared` exports TypeScript source through subpath imports, such as `@flash-sale/shared/order`. tsx runs it in development, and esbuild inlines it into each app's bundle.
  - Code moves into `shared` only when a second backend app needs it.
  - `web` does not import `shared`; its response types are duplicated in `apps/web/src/api.ts`.
- **Layers in a backend app:** `domain/` (only the API has one) → `app/` (use cases and port interfaces) → `adapters/` → `main.ts` as the composition root (manual wiring).
  - Business outcomes are discriminated unions such as `{ kind: 'sold_out' }`.
  - Only infrastructure failures throw. `DependencyUnavailableError` becomes a 503 in the API, or a retry in the worker.
- **Contract test:** `apps/api/test/contracts/sale-store-contract.ts` runs against the in-memory fake in the unit tests and against Redis in the integration tests. Keep both implementations in step.
- **Docker:**
  - A single root `Dockerfile` has one target per app (`api`, `worker`, `jobs`, `stress`, `web`). Backend images contain only Node.js and the bundle.
  - `web` is nginx (`apps/web/nginx.conf`). It serves the React build, plays the CDN (caches API responses as their `Cache-Control` allows, adds `X-Cache-Status`), and balances `/api` over 3 API replicas. It retries failed requests, including `POST`, on another server, which is safe because purchases are idempotent.
  - The worker and the jobs reach PostgreSQL through PgBouncer, the local stand-in for RDS Proxy.

## Constraints that are easy to break

- **PgBouncer runs in transaction pooling mode, so nothing may rely on session state:** no session advisory locks, `SET` or `LISTEN`. The schema migration takes `pg_advisory_xact_lock` inside a transaction for this reason.
- **RabbitMQ's management API counts are sampled.** They can be several seconds old; Compose sets 1-second intervals. The drain logic in `waitUntilDrained` relies on a settle period after the pause, not on one reading.
- **The images run `node main.mjs` without `--enable-source-maps` on purpose.** Source-mapped stack traces blocked the event loop during a Redis outage and caused `503 overloaded`.
- **The API's "not started yet" shortcut uses the server clock.** This is a documented exception to "Redis's clock decides" (docs/07, D6).
- **`docker kill` counts as a manual stop, so Docker does not restart the container.** To simulate a crash, kill the process inside the container: `pkill -9 -f main.mjs`.
- **The CDN cache time for `GET /api/sale` is chosen by the API** in `apps/api/src/adapters/http/cache-control.ts`, and capped by `maxTtl` in the CloudFront cache policy (`infra/aws/lib/app-stack.ts`, 30 s). Change both together. Keep 1 s before the opening: the buy button unlocks from `serverTime`. A job that changes the sale outside a purchase (`reset`, `recover`) must refresh the cached status (`StatusCache`), after the API's own 0.5 s cache has expired.
- **`infra/aws/` is a design-only AWS CDK app.** It is not a workspace, its dependencies are not installed, and it has never been synthesised or deployed. Keep its environment variable names aligned with each app's `config.ts`.
