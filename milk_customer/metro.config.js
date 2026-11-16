const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const previousResolveRequest = config.resolver.resolveRequest;

// Expo SDK 58 can evaluate its web HMR setup after document.currentScript is
// cleared. Resolve its URL helper to a web-only fallback that finds the entry
// script, so it doesn't send Metro a root URL that crashes the HMR server.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === 'web' &&
    moduleName === '../utils/getFullBundlerUrl' &&
    /[/\\]node_modules[/\\]expo[/\\]src[/\\]/.test(context.originModulePath)
  ) {
    return { type: 'sourceFile', filePath: require.resolve('./src/platform/getFullBundlerUrl.web.js') };
  }
  return previousResolveRequest
    ? previousResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
