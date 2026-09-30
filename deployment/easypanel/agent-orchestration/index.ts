import { Output, randomPassword, Services } from "~templates-utils";
import { Input } from "./meta";

// ENCRYPTION_KEY must be 64 hex characters; randomString() only yields [a-z0-9].
function randomHex(bytes: number) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generate(input: Input): Output {
  const services: Services = [];
  const mongoPassword = randomPassword();
  const redisPassword = randomPassword();
  const mongoHost = `$(PROJECT_NAME)_${input.appServiceName}-mongo`;
  const redisHost = `$(PROJECT_NAME)_${input.appServiceName}-redis`;

  services.push({
    type: "app",
    data: {
      serviceName: input.appServiceName,
      env: [
        `JWT_SECRET=${randomHex(32)}`,
        `ENCRYPTION_KEY=${randomHex(32)}`,
        `MONGODB_URI=mongodb://mongo:${mongoPassword}@${mongoHost}:27017/agent_orchestration?authSource=admin`,
        `REDIS_URL=redis://default:${redisPassword}@${redisHost}:6379`,
        `PUBLIC_URL=https://$(PRIMARY_DOMAIN)`,
        `WEB_URL=https://$(PRIMARY_DOMAIN)`,
        `CORS_ORIGINS=https://$(PRIMARY_DOMAIN)`,
        `TRUST_PROXY=true`,
        `NODE_ENV=production`,
        `METRICS_ENABLED=true`,
        `LOG_LEVEL=info`,
        // Set only to close registration: a value here locks the setting in the dashboard.
        ...(input.allowRegistration === false ? [`ALLOW_REGISTRATION=false`] : []),
      ].join("\n"),
      source: {
        type: "image",
        image: input.appServiceImage,
      },
      domains: [
        {
          host: "$(EASYPANEL_DOMAIN)",
          port: 4000,
        },
      ],
      mounts: [
        {
          type: "volume",
          name: "data",
          mountPath: "/app/data",
        },
      ],
    },
  });

  services.push({
    type: "mongo",
    data: {
      serviceName: `${input.appServiceName}-mongo`,
      image: "mongo:7",
      user: "mongo",
      password: mongoPassword,
    },
  });

  services.push({
    type: "redis",
    data: {
      serviceName: `${input.appServiceName}-redis`,
      image: "redis:7-alpine",
      password: redisPassword,
    },
  });

  return { services };
}
