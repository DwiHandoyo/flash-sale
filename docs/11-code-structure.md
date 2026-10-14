# 11. Code structure

> **In short:** one repository with a separate app for each role (API, worker, jobs, web) and one small shared package. Inside each backend app, code is split into three layers: pure business rules, use cases, and adapters for Redis, RabbitMQ, PostgreSQL and HTTP. Business rejections are plain return values; only infrastructure failures throw.

## Repository layout

```
apps/
  api/        Fastify HTTP API
  worker/     RabbitMQ consumer that saves orders
  jobs/       Command-line jobs: bootstrap, reconcile, recover, reset, plus the local scheduler
  web/        React app
packages/
  shared/     Code used by more than one app
tools/
  stress/     Stress-test runner (not deployed)
infra/
  postgres/   Local database set-up (creates the test database)
  aws/        Production infrastructure as code: a design, not deployed
docs/         These documents
docker-compose.yml
```

| App      | Uses                           | Does not use       | Runs as (local → production)           |
| -------- | ------------------------------ | ------------------ | -------------------------------------- |
| `api`    | Redis, RabbitMQ (publish)      | PostgreSQL         | Container → ECS                        |
| `worker` | RabbitMQ (consume), PostgreSQL | Redis, Fastify     | Container → Lambda                     |
| `jobs`   | Redis, PostgreSQL, RabbitMQ    | Fastify            | One-off container → ECS task or Lambda |
| `web`    | The API, over HTTP             | Any infrastructure | nginx → S3 + CloudFront                |

### What goes into `shared`

| Module (`@flash-sale/shared/…`)                    | Used by                                                      | Why it is shared                           |
| -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| `order`: order type, message format and validation | `api` sends it, `worker` receives it, `jobs` re-publishes it | Sender and receiver cannot disagree        |
| `sale`: the sale definition type                   | All backend apps                                             | One shape for the sale                     |
| `redis-keys`: key names and buyer record format    | `api`, `jobs`                                                | Both read and write the same keys          |
| `rabbitmq`: queue names and settings               | `api`, `worker`, `jobs`                                      | One definition of the topology             |
| PostgreSQL schema and repositories                 | `worker`, `jobs`                                             | SQL lives in one place                     |
| `config` helpers and `logger`                      | All backend apps                                             | Validated once, in the same way everywhere |

**Rule:** code moves into `shared` only when a second app needs it. That is why the purchase rules stay in the `api` app: the sale status and the user ID normalisation are only ever used there.

## Layers inside a backend app

```
entrypoint (main.ts)     wires everything together (composition root)
      │
adapters/   http · redis · rabbitmq · postgres     the only code that knows a technology
      │ implement
app/        use cases + ports (interfaces)          the steps of each flow
      │ use
domain/     pure rules and types                    no I/O, no framework
```

- **Dependencies point inward.** The domain knows nothing about the other layers, and use cases only know the ports.
- **Only adapters import Redis, RabbitMQ, PostgreSQL or Fastify.**

Example: the purchase use case in the `api` app.

```ts
async function purchase(rawUserId: string): Promise<PurchaseResult> {
  const userId = normalizeUserId(rawUserId); // domain rule
  const result = await saleStore.reserve(userId, newOrderId()); // port → Redis adapter
  if (result.kind === 'reserved' || result.kind === 'already_purchased') {
    await orderPublisher.publish(result.order); // port → RabbitMQ adapter, waits for the confirm
  }
  return result; // sold_out, not_started, ended and paused are returned as they are
}
```

| App      | Use cases                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`    | `getSaleStatus`, `purchase`, `getPurchase`                                                                                                          |
| `worker` | `saveOrders`                                                                                                                                        |
| `jobs`   | `bootstrap`, `reconcile`, `recover`, `resetSale`. Locally, a `schedule` command runs `reconcile` at `endsAt`, standing in for EventBridge Scheduler |

The API app, for example:

```
apps/api/src/
  app/          purchase.ts, get-sale-status.ts, get-purchase.ts, ports.ts
  adapters/
    http/       routes, JSON schemas, mapping outcomes to HTTP status codes
    redis/      sale store and the Lua script
    rabbitmq/   order publisher (waits for the confirm)
  main.ts       composition root
```

## Patterns we use

| Pattern                                        | Where                                                                            | Why                                                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Ports and adapters                             | `SaleStore`, `OrderPublisher`, `OrderRepository`                                 | Use cases can be tested without infrastructure, and `saveOrders` runs the same in a container or a Lambda                                    |
| Use case (application service)                 | One function per flow                                                            | Every flow in these docs has one obvious place in the code                                                                                   |
| Repository                                     | PostgreSQL access                                                                | SQL stays in one place                                                                                                                       |
| Outcome as a value (discriminated union)       | `{ kind: 'sold_out' }`, `{ kind: 'purchased', order }`, …                        | Rejections are not errors, and TypeScript forces every case to be handled. Exceptions are kept for infrastructure failures, which become 503 |
| Idempotency                                    | A repeated purchase returns the same order; inserts skip duplicates              | Retries are safe everywhere                                                                                                                  |
| Competing consumers + idempotent consumer      | Workers on the RabbitMQ queue                                                    | More workers can be added, and a message delivered twice still produces one row                                                              |
| Dead letter channel + retry                    | Dead-letter queue after 10 failed deliveries                                     | One bad message cannot block the rest                                                                                                        |
| Reconciliation                                 | The `reconcile` job                                                              | Closes the gap between Redis and RabbitMQ                                                                                                    |
| Cache with single flight                       | Sale status, cached for 0.5 s                                                    | Thousands of polls cost about 2 Redis reads per second                                                                                       |
| Fail fast + load shedding                      | Timeouts to Redis and RabbitMQ; 503 when overloaded                              | Latency stays predictable                                                                                                                    |
| Composition root (manual dependency injection) | Each app's `main.ts`                                                             | Dependencies are visible in one place, with no container or decorators                                                                       |
| Contract tests                                 | One test suite for a port, run against the real adapter and an in-memory version | The in-memory version used in unit tests cannot drift from the real one                                                                      |

## Patterns we leave out

| Pattern                                                        | Why not                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A DI container or NestJS-style decorators                      | Too much machinery for a handful of use cases                                                      |
| Full clean architecture (entity classes, mappers, many layers) | Three layers are enough                                                                            |
| CQRS or event sourcing                                         | No need for an event history                                                                       |
| Saga                                                           | The only cross-system step is publishing, which confirms, retries and reconciliation already cover |
| A circuit-breaker library                                      | Timeouts plus failing fast are enough                                                              |
| Class hierarchies and generic repositories                     | Plain functions and small objects read better                                                      |

## Frontend

- **Function components plus two custom hooks:** `useSaleStatus` polls the status, backs off on errors and pauses in hidden tabs. `useServerClock` runs the countdown from `serverTime`.
- **One API client module.**
- **One table that maps each response code to the message shown to the user.**
- **No state library.**

## Conventions

- TypeScript in strict mode, ES modules.
- Configuration is read and validated once at start-up. An app with invalid configuration refuses to start.
- Logs are structured JSON.
- Comments explain _why_. The code itself should explain _what_.

---

Previous: [10. Infrastructure](10-infrastructure.md) · Next: [12. Cloud deployment](12-cloud-deployment.md)
