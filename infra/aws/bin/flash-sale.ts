/**
 * DESIGN ONLY: not deployed or tested. See ../README.md and docs/12-cloud-deployment.md.
 *
 * Creates the three stacks for one environment:
 *   npx cdk synth -c env=prod
 */
import { App } from 'aws-cdk-lib';

import { AppStack } from '../lib/app-stack';
import { environments, type EnvironmentName } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { NetworkStack } from '../lib/network-stack';

const app = new App();
const config = environments[(app.node.tryGetContext('env') ?? 'dev') as EnvironmentName];
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const prefix = `FlashSale-${config.name}`;

// Split by how often a stack changes and how costly a mistake would be:
// network and data rarely change and are protected; the app stack is deployed on every release.
const network = new NetworkStack(app, `${prefix}-Network`, { env, config });
const data = new DataStack(app, `${prefix}-Data`, { env, config, network });
new AppStack(app, `${prefix}-App`, { env, config, network, data });
