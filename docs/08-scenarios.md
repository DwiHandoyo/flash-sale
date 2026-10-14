# 8. Scenarios

> **In short:** every race and every failure has a defined outcome. No unit is ever sold twice, nobody gets two, and nobody who was told "you got it" loses their order. The worst case is a short pause in sales.

## Races: many requests at the same moment

| Scenario                                                                 | What happens                                                                                | Why it is safe                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 500 users try to buy the last unit                                       | One script runs first and takes it. The other 499 see stock 0 and get `sold_out`            | Checking and taking happen in one atomic script              |
| A user double-clicks, or buys from several tabs                          | The first request reserves the unit. The others get `already_purchased` with the same order | The buyer check is part of the same atomic script            |
| A user types `Alice@Mail.com` in one tab and `alice@mail.com` in another | Both are treated as the same buyer                                                          | User IDs are normalised before the script runs               |
| A request arrives at `endsAt`, on a server whose clock is slow           | Rejected with `sale_ended`                                                                  | The window uses Redis's clock, not the server's              |
| Thousands click before the sale opens                                    | The API answers `sale_not_started` from its cache, without touching Redis                   | A shortcut, because nobody can own an order before the start |

## Failures: something breaks

| What fails                                       | What users notice                                     | What the system does                                                                                    | Orders safe?               |
| ------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------- |
| One API server crashes                           | Nothing, or one failed request                        | nginx retries on another server. This is safe because purchases are idempotent                          | Yes                        |
| All API servers crash                            | The sale is unreachable                               | Docker or the orchestrator restarts them. No data is lost                                               | Yes                        |
| The response is lost after a successful purchase | "Could not confirm", briefly                          | The app asks "did I get one?". A retry returns the same order                                           | Yes                        |
| The API crashes between reserving and publishing | An error, then "you already have one" on retry        | The retry publishes the order again. End-of-sale reconciliation catches the rest                        | Yes                        |
| RabbitMQ is down (rare)                          | 503, "try again"                                      | Reservations made meanwhile are completed once RabbitMQ is back                                         | Yes                        |
| A worker crashes before acknowledging            | Nothing                                               | RabbitMQ redelivers its messages to another worker right away. Duplicates are skipped                   | Yes                        |
| PostgreSQL is down                               | Nothing                                               | Orders wait in RabbitMQ, and workers retry until they catch up                                          | Yes                        |
| Redis restarts                                   | 503 for a moment                                      | Its data is reloaded from disk, intact                                                                  | Yes                        |
| Redis loses data, or fails over to a replica     | The sale pauses for a few seconds (`503 sale_paused`) | Recovery: pause, drain, rebuild, resume. See [Consistency and recovery](06-consistency-and-recovery.md) | Yes, every confirmed order |
| A message keeps failing to save                  | Nothing                                               | After 10 tries it moves to the dead-letter queue, and an alarm goes off                                 | Kept for inspection        |
| Traffic exceeds capacity                         | Some "busy, please retry" (503)                       | Overloaded servers reject quickly instead of slowing down for everyone                                  | Yes                        |

## The "unknown outcome" problem

A timeout after sending a purchase does not tell us whether it happened. Instead of guessing, we make it safe to ask:

1. Buying again returns your original order (rule 1 in [Purchase flow](03-purchase-flow.md)).
2. When a purchase request fails, the app calls `GET /api/purchases/:userId` before reporting a failure.

## Known gaps

- **One region.** A regional outage stops the sale.
- **The local demo runs on one machine.** Redis and RabbitMQ there are single nodes without replicas. In production both would run replicated, as clusters or managed services.

---

Previous: [7. Decisions](07-decisions.md) · Next: [9. Testing](09-testing.md)
