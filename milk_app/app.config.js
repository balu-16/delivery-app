const { existsSync } = require('node:fs');

module.exports = ({ config }) => {
  const configuredFile = process.env.GOOGLE_SERVICES_JSON;
  if (configuredFile && !existsSync(configuredFile)) {
    throw new Error('GOOGLE_SERVICES_JSON points to a missing Firebase configuration file.');
  }
  const googleServicesFile = configuredFile || (existsSync('./google-services.json') ? './google-services.json' : undefined);
  return {
    ...config,
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
  };
};
