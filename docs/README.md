# Design documentation

Twelve short documents. Each one answers a single question. Read them in order, or jump to the one you need.

|     | Document                                                   | Question it answers                                                                 |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | [Overview](01-overview.md)                                 | What are we building, and what is out of scope?                                     |
| 2   | [Architecture](02-architecture.md)                         | What are the parts, and how do they work together?                                  |
| 3   | [Purchase flow](03-purchase-flow.md)                       | What happens on "Buy now", and why can it never oversell?                           |
| 4   | [Data model](04-data-model.md)                             | What data do we keep, and where?                                                    |
| 5   | [API](05-api.md)                                           | Which endpoints exist, and what do they return?                                     |
| 6   | [Consistency and recovery](06-consistency-and-recovery.md) | How do Redis and PostgreSQL stay in sync, and what if Redis loses data?             |
| 7   | [Decisions](07-decisions.md)                               | Why these choices, and what did we trade off?                                       |
| 8   | [Scenarios](08-scenarios.md)                               | What happens in each race and failure, case by case?                                |
| 9   | [Testing](09-testing.md)                                   | How do we prove it works, even under heavy load?                                    |
| 10  | [Infrastructure](10-infrastructure.md)                     | What runs where, locally and in production, and what runs on a schedule?            |
| 11  | [Code structure](11-code-structure.md)                     | How is the code organised, and which patterns does it use?                          |
| 12  | [Cloud deployment](12-cloud-deployment.md)                 | How would it run on AWS, and what does the infrastructure-as-code design look like? |

**Short on time?** Read 1, 2 and 3. Together they cover the core idea.

The diagrams use [Mermaid](https://mermaid.js.org/). GitHub renders them automatically. In VS Code, install the _Markdown Preview Mermaid Support_ extension to see them in the preview.
