/**
 * DESIGN ONLY: not deployed or tested.
 *
 * Sizes per environment. They are starting points, to be confirmed with load tests in staging.
 * The same code builds every environment; only these numbers change.
 */
export type EnvironmentName = 'dev' | 'staging' | 'prod';

export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  readonly availabilityZones: number;
  readonly api: {
    readonly cpu: number;
    readonly memoryMiB: number;
    readonly minTasks: number;
    readonly maxTasks: number;
  };
  readonly worker: {
    /** Caps concurrent Lambda instances so PostgreSQL connections stay bounded. */
    readonly maxConcurrency: number;
    readonly batchSize: number;
  };
  readonly memoryDb: { readonly nodeType: string; readonly replicasPerShard: number };
  readonly rabbitMq: {
    readonly instanceType: string;
    readonly deploymentMode: 'SINGLE_INSTANCE' | 'CLUSTER_MULTI_AZ';
  };
  readonly postgres: { readonly instanceType: string; readonly multiAz: boolean };
  /** Protects stateful resources from being deleted by a stack update or removal. */
  readonly protectData: boolean;
}

export const environments: Record<EnvironmentName, EnvironmentConfig> = {
  dev: {
    name: 'dev',
    availabilityZones: 2,
    api: { cpu: 512, memoryMiB: 1024, minTasks: 1, maxTasks: 2 },
    worker: { maxConcurrency: 2, batchSize: 100 },
    memoryDb: { nodeType: 'db.t4g.small', replicasPerShard: 0 },
    rabbitMq: { instanceType: 'mq.t3.micro', deploymentMode: 'SINGLE_INSTANCE' },
    postgres: { instanceType: 't4g.small', multiAz: false },
    protectData: false,
  },
  staging: {
    name: 'staging',
    availabilityZones: 2,
    api: { cpu: 1024, memoryMiB: 2048, minTasks: 2, maxTasks: 6 },
    worker: { maxConcurrency: 5, batchSize: 100 },
    memoryDb: { nodeType: 'db.r7g.large', replicasPerShard: 1 },
    rabbitMq: { instanceType: 'mq.m5.large', deploymentMode: 'CLUSTER_MULTI_AZ' },
    postgres: { instanceType: 'r7g.large', multiAz: true },
    protectData: false,
  },
  prod: {
    name: 'prod',
    availabilityZones: 3,
    api: { cpu: 1024, memoryMiB: 2048, minTasks: 2, maxTasks: 20 },
    worker: { maxConcurrency: 5, batchSize: 100 },
    memoryDb: { nodeType: 'db.r7g.large', replicasPerShard: 1 },
    rabbitMq: { instanceType: 'mq.m5.large', deploymentMode: 'CLUSTER_MULTI_AZ' },
    postgres: { instanceType: 'r7g.large', multiAz: true },
    protectData: true,
  },
};
