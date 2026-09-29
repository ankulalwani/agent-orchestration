// Metro config for the pnpm monorepo. Workspace packages (packages/*) are TypeScript ESM source that
// imports siblings as './x.js' (the TS convention for './x.ts'); Metro needs that mapping spelled out.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const packagesDir = path.resolve(__dirname, '../../packages') + path.sep;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js') && context.originModulePath.startsWith(packagesDir)) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return context.resolveRequest(context, moduleName.slice(0, -3) + ext, platform);
      } catch {
        // try the next extension, then fall back to the default resolution
      }
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
