/**
 * DESIGN ONLY: not deployed or tested.
 *
 * The network: a VPC over several availability zones with three subnet tiers, plus one security
 * group per role. The security group rules spell out exactly who may talk to whom
 * (docs/12-cloud-deployment.md, "Network and security").
 */
import { Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

import type { EnvironmentConfig } from './config';

export interface NetworkStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly securityGroups: Record<
    'api' | 'worker' | 'jobs' | 'redis' | 'rabbitMq' | 'postgres',
    ec2.SecurityGroup
  >;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: config.availabilityZones,
      // One NAT gateway per zone in production, so losing a zone does not cut outbound traffic.
      natGateways: config.name === 'prod' ? config.availabilityZones : 1,
      subnetConfiguration: [
        // Load balancer and NAT gateways only.
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // API tasks, Lambdas and jobs. Outbound through NAT, to reach AWS APIs.
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        // MemoryDB, Amazon MQ and RDS. No route to or from the internet at all.
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const group = (name: string, description: string) =>
      new ec2.SecurityGroup(this, `${name}SecurityGroup`, {
        vpc: this.vpc,
        description,
        allowAllOutbound: true,
      });

    this.securityGroups = {
      api: group('Api', 'API tasks'),
      worker: group('Worker', 'Worker Lambda'),
      jobs: group('Jobs', 'Bootstrap, reconcile and recover jobs'),
      redis: group('Redis', 'MemoryDB'),
      rabbitMq: group('RabbitMq', 'Amazon MQ brokers'),
      postgres: group('Postgres', 'RDS Proxy and PostgreSQL'),
    };
    const { api, worker, jobs, redis, rabbitMq, postgres } = this.securityGroups;

    // The load balancer's access to the API tasks is added by the ECS pattern in the app stack.
    // The worker never needs Redis; only the API and the jobs do.
    for (const client of [api, jobs]) {
      redis.addIngressRule(client, ec2.Port.tcp(6379), 'Redis over TLS');
    }
    for (const client of [api, worker, jobs]) {
      rabbitMq.addIngressRule(client, ec2.Port.tcp(5671), 'AMQPS');
    }
    // The API never talks to PostgreSQL.
    for (const client of [worker, jobs]) {
      postgres.addIngressRule(client, ec2.Port.tcp(5432), 'PostgreSQL through RDS Proxy');
    }
    postgres.addIngressRule(postgres, ec2.Port.tcp(5432), 'RDS Proxy to the database');
  }
}
