# AWS infrastructure (design only)

> **Status: design, not deployed.** The assignment does not ask for a cloud deployment. This folder shows how the production setup in [docs/12-cloud-deployment.md](../../docs/12-cloud-deployment.md) would be written as infrastructure-as-code with the AWS CDK (TypeScript). It has not been deployed or tested, and its dependencies are not installed. It is also not part of the npm workspaces, so it adds nothing to the project's install, build or tests.

| File                                           | What it defines                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`bin/flash-sale.ts`](bin/flash-sale.ts)       | Entry point: picks an environment (`dev`, `staging`, `prod`) and creates the three stacks                                 |
| [`lib/config.ts`](lib/config.ts)               | Sizes per environment                                                                                                     |
| [`lib/network-stack.ts`](lib/network-stack.ts) | VPC, subnets, security groups                                                                                             |
| [`lib/data-stack.ts`](lib/data-stack.ts)       | MemoryDB, Amazon MQ (RabbitMQ), RDS PostgreSQL + RDS Proxy, secrets                                                       |
| [`lib/app-stack.ts`](lib/app-stack.ts)         | API on ECS + load balancer, worker and reconcile Lambdas, jobs task, EventBridge Scheduler group, S3 + CloudFront, alarms |

To actually use it, you would run `npm install`, then `npx cdk synth -c env=staging` to check the template, and `npx cdk deploy --all -c env=staging` to deploy.
