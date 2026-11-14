const fs = require('node:fs');

module.exports = ({ config }) => {
  const firebase = process.env.GOOGLE_SERVICES_JSON;
  if (firebase && !fs.existsSync(firebase)) throw new Error('GOOGLE_SERVICES_JSON points to a missing file.');
  return { ...config, android: { ...config.android, ...(firebase ? { googleServicesFile: firebase } : {}) } };
};
