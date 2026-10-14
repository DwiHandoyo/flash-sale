# 1. Overview

> **In short:** a flash sale for one product with limited stock. It is open for a fixed time window and sells at most one unit per person. It has to stay correct when thousands of people press "Buy" in the same second, and it must never tell someone "you got it" and then lose their order.

## The problem

When a limited drop opens, thousands of requests arrive at once and compete for a few units. Two rules must hold no matter how heavy the traffic gets:

1. **No overselling.** We never sell more units than we have.
2. **One per user.** Nobody ends up with two units, even if they click twice or open several tabs.

On top of the rules there is one promise: **"you got it" is never taken back.** Once a user is told they secured an item, their order is stored safely.

## What we build

| Requirement                                       | How it is met                                                                     | More                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| The sale opens and closes at configured times     | Every purchase is checked against the time window, using Redis's clock            | [Purchase flow](03-purchase-flow.md) |
| Limited stock, no overselling                     | Checking and taking a unit happen in one atomic step in Redis                     | [Purchase flow](03-purchase-flow.md) |
| One item per user                                 | Checked in that same step, and again by a database constraint                     | [Data model](04-data-model.md)       |
| "You got it" is never lost                        | RabbitMQ confirms the order is stored safely before the user is told              | [Purchase flow](03-purchase-flow.md) |
| Endpoints for status, buying and "did I get one?" | A small REST API                                                                  | [API](05-api.md)                     |
| Simple frontend                                   | A React page with status, countdown, user ID, Buy button and result               | —                                    |
| High throughput, scalable                         | Stateless API servers. Redis decides, and the database stays off the request path | [Architecture](02-architecture.md)   |
| Resilient to failures                             | Every race and failure has a defined, safe outcome                                | [Scenarios](08-scenarios.md)         |

## Out of scope (on purpose)

- **Login.** Users type a username or email. A real system would take the user from the login session.
- **Payment.** "Purchased" means a unit is reserved for that user.
- **Several products or sales at once.** There is one sale per deployment. Data is already keyed by sale ID, so more sales can be added later.
- **Bot protection and rate limiting.** These are discussed in [Decisions](07-decisions.md) but not built.

## Assumptions

- Users are identified by what they type, after it is normalised. `Alice@Mail.com ` and `alice@mail.com` are the same person.
- Stock only goes down during a sale. There are no cancellations or returns.
- The sale is open from `startsAt` (inclusive) until `endsAt` (exclusive).
- **RabbitMQ outages are rare**, because in production it runs as a cluster or a managed service. If it does go down, purchases pause until it is back (see [Decisions](07-decisions.md)).

## Terms used in these docs

| Term              | Meaning here                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| Hot path          | Code that runs on every purchase request, so it must be fast                |
| Atomic            | Done as one step that nothing else can interrupt                            |
| Idempotent        | Doing it twice has the same effect as doing it once                         |
| Reservation       | A unit set aside for a user in Redis, at the moment the purchase is decided |
| Order record      | The permanent copy of an order: one row in PostgreSQL                       |
| Publisher confirm | RabbitMQ's reply to the API: "your message is stored safely"                |

---

Next: [2. Architecture](02-architecture.md)
