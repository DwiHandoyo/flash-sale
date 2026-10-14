/**
 * DESIGN ONLY: not deployed or tested.
 *
 * Everything that keeps state: MemoryDB (live sale state), Amazon MQ (orders on their way) and
 * RDS PostgreSQL (permanent records), with their passwords in Secrets Manager. This stack changes
 * rarely, and in production its resources are protected from deletion.
 */
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as amazonmq from 'aws-cdk-lib/aws-amazonmq';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as memorydb from 'aws-cdk-lib/aws-memorydb';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

import type { EnvironmentConfig } from './config';
import type { NetworkStack } from './network-stack';

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly network: NetworkStack;
}

export class DataStack extends Stack {
  readonly redis: memorydb.CfnCluster;
  readonly redisSecret: secretsmanager.Secret;
  readonly rabbitMq: amazonmq.CfnBroker;
  readonly rabbitMqSecret: secretsmanager.Secret;
  readonly postgresProxy: rds.DatabaseProxy;
  readonly postgresSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, { ...props, terminationProtection: props.config.protectData });
    const { config, network } = props;
    const { vpc, securityGroups } = network;
    const dataSubnetIds = vpc.isolatedSubnets.map((subnet) => subnet.subnetId);
    const keep = config.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const name = `flash-sale-${config.name}`;

    // --- Redis: MemoryDB --------------------------------------------------------------------
    // MemoryDB commits every write to a multi-AZ transaction log before acknowledging it, so
    // "Redis lost data" becomes very unlikely. The recovery job still exists for that case.
    this.redisSecret = generatedSecret(this, 'RedisSecret', 'flash-sale');
    const redisUser = new memorydb.CfnUser(this, 'RedisUser', {
      userName: 'flash-sale',
      // Only this application's keys.
      accessString: 'on ~flash-sale:* +@all',
      authenticationMode: {
        Type: 'password',
        Passwords: [this.redisSecret.secretValueFromJson('password').unsafeUnwrap()],
      },
    });
    const redisAcl = new memorydb.CfnACL(this, 'RedisAcl', {
      aclName: name,
      userNames: [redisUser.userName],
    });
    redisAcl.addDependency(redisUser);

    const redisSubnets = new memorydb.CfnSubnetGroup(this, 'RedisSubnets', {
      subnetGroupName: name,
      subnetIds: dataSubnetIds,
    });
    this.redis = new memorydb.CfnCluster(this, 'Redis', {
      clusterName: name,
      // Valkey speaks the Redis protocol; the purchase script runs unchanged.
      engine: 'valkey',
      nodeType: config.memoryDb.nodeType,
      // One sale is one hash tag, which lives on one shard.
      numShards: 1,
      numReplicasPerShard: config.memoryDb.replicasPerShard,
      aclName: redisAcl.aclName,
      tlsEnabled: true,
      subnetGroupName: redisSubnets.subnetGroupName,
      securityGroupIds: [securityGroups.redis.securityGroupId],
      snapshotRetentionLimit: 7,
    });
    this.redis.addDependency(redisAcl);
    this.redis.addDependency(redisSubnets);
    this.redis.applyRemovalPolicy(keep);

    // --- RabbitMQ: Amazon MQ ----------------------------------------------------------------
    // In a cluster deployment, three nodes spread over the zones replicate the quorum queues,
    // so a publisher confirm means the order is stored on a majority of nodes.
    this.rabbitMqSecret = generatedSecret(this, 'RabbitMqSecret', 'flash-sale', ',:=%');
    const cluster = config.rabbitMq.deploymentMode === 'CLUSTER_MULTI_AZ';
    this.rabbitMq = new amazonmq.CfnBroker(this, 'RabbitMq', {
      brokerName: name,
      engineType: 'RABBITMQ',
      // Pin to the newest RabbitMQ version Amazon MQ offers at deploy time (quorum queues: 3.13+).
      engineVersion: '3.13',
      hostInstanceType: config.rabbitMq.instanceType,
      deploymentMode: config.rabbitMq.deploymentMode,
      publiclyAccessible: false,
      autoMinorVersionUpgrade: true,
      subnetIds: cluster ? dataSubnetIds : dataSubnetIds.slice(0, 1),
      securityGroups: [securityGroups.rabbitMq.securityGroupId],
      users: [
        {
          username: 'flash-sale',
          password: this.rabbitMqSecret.secretValueFromJson('password').unsafeUnwrap(),
        },
      ],
      logs: { general: true },
    });
    this.rabbitMq.applyRemovalPolicy(keep);
    // The queues themselves (orders + dead-letter) are declared in code by the bootstrap job and
    // the worker, exactly as they are locally, so there is one definition of the topology.

    // --- PostgreSQL: RDS + RDS Proxy ------------------------------------------------------
    const postgres = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: new ec2.InstanceType(config.postgres.instanceType),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [securityGroups.postgres],
      multiAz: config.postgres.multiAz,
      databaseName: 'flash_sale',
      credentials: rds.Credentials.fromGeneratedSecret('flash_sale'),
      allocatedStorage: 50,
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      deletionProtection: config.protectData,
      removalPolicy: config.protectData ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });
    this.postgresSecret = postgres.secret!;
    // Lambdas open and close connections often; the proxy pools them so PostgreSQL never sees
    // a connection storm.
    this.postgresProxy = postgres.addProxy('PostgresProxy', {
      secrets: [this.postgresSecret],
      vpc,
      securityGroups: [securityGroups.postgres],
      requireTLS: true,
    });
  }
}

function generatedSecret(
  scope: Construct,
  id: string,
  username: string,
  excludeCharacters?: string,
): secretsmanager.Secret {
  return new secretsmanager.Secret(scope, id, {
    generateSecretString: {
      secretStringTemplate: JSON.stringify({ username }),
      generateStringKey: 'password',
      passwordLength: 32,
      excludePunctuation: excludeCharacters === undefined,
      ...(excludeCharacters ? { excludeCharacters } : {}),
    },
  });
}
