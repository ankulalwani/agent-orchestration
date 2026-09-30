#!/usr/bin/env node
// Prints an Easypanel template schema (JSON) with fresh secrets, for installations that don't use the
// official template: Easypanel → project → Templates → Create from Schema → paste the output.
//   node deployment/easypanel/generate-schema.mjs [--name agent-orchestration] [--image ghcr.io/...:0.2.1]
// Mirrors deployment/easypanel/agent-orchestration/index.ts; keep the two in sync.
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const name = arg('--name', 'agent-orchestration');
const image = arg('--image', 'ghcr.io/ankulalwani/agent-orchestration:0.2.1');
// Easypanel passwords: letters and digits only, so they need no escaping in connection URLs.
const password = () => randomBytes(15).toString('base64url').replace(/[-_]/g, '').slice(0, 20).padEnd(20, '0');
const hex = (bytes) => randomBytes(bytes).toString('hex');

const mongoPassword = password();
const redisPassword = password();
const mongoHost = `$(PROJECT_NAME)_${name}-mongo`;
const redisHost = `$(PROJECT_NAME)_${name}-redis`;

const schema = {
  services: [
    {
      type: 'app',
      data: {
        serviceName: name,
        env: [
          `JWT_SECRET=${hex(32)}`,
          `ENCRYPTION_KEY=${hex(32)}`,
          `MONGODB_URI=mongodb://mongo:${mongoPassword}@${mongoHost}:27017/agent_orchestration?authSource=admin`,
          `REDIS_URL=redis://default:${redisPassword}@${redisHost}:6379`,
          'PUBLIC_URL=https://$(PRIMARY_DOMAIN)',
          'WEB_URL=https://$(PRIMARY_DOMAIN)',
          'CORS_ORIGINS=https://$(PRIMARY_DOMAIN)',
          'TRUST_PROXY=true',
          'NODE_ENV=production',
          'METRICS_ENABLED=true',
          'LOG_LEVEL=info',
        ].join('\n'),
        source: { type: 'image', image },
        domains: [{ host: '$(EASYPANEL_DOMAIN)', port: 4000 }],
        mounts: [{ type: 'volume', name: 'data', mountPath: '/app/data' }],
      },
    },
    { type: 'mongo', data: { serviceName: `${name}-mongo`, image: 'mongo:7', user: 'mongo', password: mongoPassword } },
    { type: 'redis', data: { serviceName: `${name}-redis`, image: 'redis:7-alpine', password: redisPassword } },
  ],
};

process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
