const { existsSync } = require('node:fs');
const { resolveBackendPort } = require('./scripts/backend-port.cjs');

module.exports = ({ config }) => {
  const configuredFile = process.env.GOOGLE_SERVICES_JSON;
  if (configuredFile && !existsSync(configuredFile)) {
    throw new Error('GOOGLE_SERVICES_JSON points to a missing Firebase configuration file.');
  }
  const googleServicesFile = configuredFile || (existsSync('./google-services.json') ? './google-services.json' : undefined);
  const developmentApiPort = process.env.EXPO_PUBLIC_API_URL?.trim()
    ? undefined
    : resolveBackendPort({ explicitPort: process.env.EXPO_PUBLIC_API_PORT });
  return {
    ...config,
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
    extra: { ...config.extra, ...(developmentApiPort ? { developmentApiPort } : {}) },
  };
};
