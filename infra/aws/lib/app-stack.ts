/**
 * DESIGN ONLY: not deployed or tested.
 *
 * The stateless part, deployed on every release:
 * - the API on ECS Fargate behind a load balancer,
 * - the worker and reconcile Lambdas,
 * - the jobs task (bootstrap, recover),
 * - the EventBridge Scheduler group,
 * - the React app on S3 + CloudFront,
 * - the alarms.
 *
 * Simplifications, as a design:
 * - The Lambda entry files (apps/worker/src/lambda.ts, apps/jobs/src/lambda-reconcile.ts) would
 *   wrap the same use cases as the container entry points. They are referenced but not built.
 * - CloudFront reaches the load balancer over HTTP. A real setup adds a domain and an ACM
 *   certificate and uses HTTPS.
 * - Lambdas would read their passwords from Secrets Manager at start-up (ARNs passed below).
 */
import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy, Stack, Token, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import type { EnvironmentConfig } from './config';
import type { DataStack } from './data-stack';
import type { NetworkStack } from './network-stack';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export interface AppStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly network: NetworkStack;
  readonly data: DataStack;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, network, data } = props;
    const { vpc, securityGroups: sg } = network;
    const name = `flash-sale-${config.name}`;
    const appSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    // The variables the apps read (each app's config.ts), pointing at the managed services. The
    // user names are in the URLs; the passwords come from Secrets Manager as REDIS_PASSWORD,
    // RABBITMQ_PASSWORD and DATABASE_PASSWORD, and the apps add them to the URLs.
    const mqHost = `${data.rabbitMq.attrId}.mq.${this.region}.amazonaws.com`;
    const endpoints = {
      SALE_ID: 'limited-edition-drop',
      LOG_LEVEL: 'info',
      REDIS_URL: `rediss://flash-sale@${data.redis.attrClusterEndpointAddress}:${Token.asString(data.redis.attrClusterEndpointPort)}`,
      RABBITMQ_URL: `amqps://flash-sale@${mqHost}:5671`,
      // The recovery job reads the queue counts from RabbitMQ's management API.
      RABBITMQ_MANAGEMENT_URL: `https://flash-sale@${mqHost}`,
      DATABASE_URL: `postgres://flash_sale@${data.postgresProxy.endpoint}:5432/flash_sale`,
    };

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // --- API: ECS Fargate behind an Application Load Balancer ---------------------------------
    const api = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster,
      cpu: config.api.cpu,
      memoryLimitMiB: config.api.memoryMiB,
      desiredCount: config.api.minTasks,
      securityGroups: [sg.api],
      taskSubnets: appSubnets,
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(repoRoot, { target: 'api' }),
        containerPort: 3000,
        environment: {
          REDIS_URL: endpoints.REDIS_URL,
          RABBITMQ_URL: endpoints.RABBITMQ_URL,
          SALE_ID: endpoints.SALE_ID,
        },
        secrets: {
          REDIS_PASSWORD: ecs.Secret.fromSecretsManager(data.redisSecret, 'password'),
          RABBITMQ_PASSWORD: ecs.Secret.fromSecretsManager(data.rabbitMqSecret, 'password'),
        },
      },
    });
    api.targetGroup.configureHealthCheck({
      path: '/health/ready',
      interval: Duration.seconds(10),
      healthyThresholdCount: 2,
    });
    // Reactive scaling between min and max. Before each sale, the jobs app adds a one-off
    // scheduled action (out 10 minutes before startsAt, back in after endsAt), because the sale's
    // time is data, not infrastructure. See docs/10-infrastructure.md, "Scheduling".
    const apiScaling = api.service.autoScaleTaskCount({
      minCapacity: config.api.minTasks,
      maxCapacity: config.api.maxTasks,
    });
    apiScaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    // --- Worker: Lambda fed by Amazon MQ -------------------------------------------------------
    const worker = new lambdaNodejs.NodejsFunction(this, 'Worker', {
      entry: `${repoRoot}/apps/worker/src/lambda.ts`,
      runtime: lambda.Runtime.NODEJS_22_X, // the newest Node.js runtime Lambda offers
      memorySize: 512,
      timeout: Duration.seconds(30),
      // Bounded concurrency keeps PostgreSQL connections bounded, even during a burst.
      reservedConcurrentExecutions: config.worker.maxConcurrency,
      vpc,
      vpcSubnets: appSubnets,
      securityGroups: [sg.worker],
      environment: {
        DATABASE_URL: endpoints.DATABASE_URL,
        DATABASE_SECRET_ARN: data.postgresSecret.secretArn,
      },
    });
    data.postgresSecret.grantRead(worker);
    data.rabbitMqSecret.grantRead(worker);
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['mq:DescribeBroker'],
        resources: [data.rabbitMq.attrArn],
      }),
    );
    // Lambda polls the queue and hands over batches. A failed batch goes back to the queue, and
    // the quorum queue's delivery limit moves a message that keeps failing to the dead-letter queue.
    new lambda.EventSourceMapping(this, 'WorkerOrders', {
      target: worker,
      eventSourceArn: data.rabbitMq.attrArn,
      queues: ['orders'],
      batchSize: config.worker.batchSize,
      maxBatchingWindow: Duration.seconds(1),
      sourceAccessConfigurations: [
        {
          type: lambda.SourceAccessConfigurationType.BASIC_AUTH,
          uri: data.rabbitMqSecret.secretArn,
        },
        { type: lambda.SourceAccessConfigurationType.VIRTUAL_HOST, uri: '/' },
      ],
    });

    // --- Jobs: reconcile (Lambda) and bootstrap / recover (ECS task) --------------------------
    const jobSecretArns = {
      REDIS_SECRET_ARN: data.redisSecret.secretArn,
      RABBITMQ_SECRET_ARN: data.rabbitMqSecret.secretArn,
      DATABASE_SECRET_ARN: data.postgresSecret.secretArn,
    };
    const reconcile = new lambdaNodejs.NodejsFunction(this, 'Reconcile', {
      entry: `${repoRoot}/apps/jobs/src/lambda-reconcile.ts`,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.minutes(5),
      reservedConcurrentExecutions: 1, // one reconciliation at a time
      vpc,
      vpcSubnets: appSubnets,
      securityGroups: [sg.jobs],
      environment: { ...endpoints, ...jobSecretArns },
    });

    const jobsTask = new ecs.FargateTaskDefinition(this, 'JobsTask', {
      family: `${name}-jobs`,
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    for (const secret of [data.redisSecret, data.rabbitMqSecret, data.postgresSecret]) {
      secret.grantRead(reconcile);
      secret.grantRead(jobsTask.taskRole);
    }

    // --- Scheduling: one group; per-sale schedules are created at runtime by the jobs app -----
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'SaleSchedules', { name });
    const schedulerDeadLetters = new sqs.Queue(this, 'SchedulerDeadLetters', {
      retentionPeriod: Duration.days(14),
    });
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    reconcile.grantInvoke(schedulerRole);
    schedulerDeadLetters.grantSendMessages(schedulerRole);
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [jobsTask.taskDefinitionArn],
      }),
    );
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [jobsTask.taskRole.roleArn, jobsTask.obtainExecutionRole().roleArn],
      }),
    );

    jobsTask.addContainer('jobs', {
      image: ecs.ContainerImage.fromAsset(repoRoot, { target: 'jobs' }),
      // Overridden per run: bootstrap, recover, reset.
      command: ['bootstrap'],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'jobs' }),
      environment: {
        ...endpoints,
        // What the jobs app needs to create a sale's schedules and scaling actions.
        SCHEDULE_GROUP: name,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
        SCHEDULER_DEAD_LETTER_ARN: schedulerDeadLetters.queueArn,
        RECONCILE_FUNCTION_ARN: reconcile.functionArn,
        JOBS_TASK_FAMILY: `${name}-jobs`,
        ECS_CLUSTER_ARN: cluster.clusterArn,
        API_SCALING_RESOURCE_ID: `service/${cluster.clusterName}/${api.service.serviceName}`,
      },
      secrets: {
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(data.redisSecret, 'password'),
        RABBITMQ_PASSWORD: ecs.Secret.fromSecretsManager(data.rabbitMqSecret, 'password'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(data.postgresSecret, 'password'),
      },
    });
    jobsTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
        ],
        resources: [
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`,
        ],
      }),
    );
    jobsTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [schedulerRole.roleArn] }),
    );
    jobsTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Application Auto Scaling has no resource-level permissions for scheduled actions.
        actions: [
          'application-autoscaling:PutScheduledAction',
          'application-autoscaling:DeleteScheduledAction',
        ],
        resources: ['*'],
      }),
    );

    // --- Frontend: S3 + CloudFront, with /api/* forwarded to the load balancer ----------------
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      // Follow the API's Cache-Control header: GET /api/sale (max-age=1) is cached for one
      // second at the edge, and responses without the header are not cached at all.
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.LoadBalancerV2Origin(api.loadBalancer, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    // apps/web/dist is built by the pipeline before `cdk deploy`.
    new s3deploy.BucketDeployment(this, 'WebFiles', {
      sources: [s3deploy.Source.asset(`${repoRoot}/apps/web/dist`)],
      destinationBucket: webBucket,
      distribution,
    });

    // --- Alarms ----------------------------------------------------------------------------
    const alarms = new sns.Topic(this, 'Alarms'); // subscribe the on-call channel here
    const alarm = (
      id: string,
      description: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      evaluationPeriods = 1,
    ) =>
      new cloudwatch.Alarm(this, id, {
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(alarms));

    const queueDepth = (queue: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/AmazonMQ',
        metricName: 'MessageCount',
        dimensionsMap: { Broker: data.rabbitMq.brokerName, VirtualHost: '/', Queue: queue },
        statistic: 'Maximum',
        period: Duration.minutes(1),
      });

    alarm(
      'DeadLetters',
      'An order could not be saved and is waiting in the dead-letter queue',
      queueDepth('orders.dead-letter'),
      0,
    );
    alarm(
      'OrderBacklog',
      'Orders keep piling up: are the workers or PostgreSQL down?',
      queueDepth('orders'),
      1_000,
      5,
    );
    alarm(
      'Api5xx',
      'The API is returning server errors',
      api.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(1),
        statistic: 'Sum',
      }),
      50,
    );
    alarm(
      'WorkerErrors',
      'The worker keeps failing to save orders',
      worker.metricErrors({ period: Duration.minutes(1) }),
      0,
      3,
    );
    alarm(
      'ScheduledJobFailed',
      'A scheduled bootstrap or reconcile run failed',
      schedulerDeadLetters.metricApproximateNumberOfMessagesVisible(),
      0,
    );
    alarm(
      'OrdersMissingInPostgres',
      'Redis has buyers without an order record after reconciliation',
      // Would be published by the reconcile job in production (locally it is only logged).
      new cloudwatch.Metric({
        namespace: 'FlashSale',
        metricName: 'OrdersMissingInPostgres',
        statistic: 'Maximum',
      }),
      0,
    );
  }
}
