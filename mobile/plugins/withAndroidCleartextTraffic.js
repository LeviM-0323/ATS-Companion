const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('Android manifest does not contain an application entry.');
    }

    application.$['android:usesCleartextTraffic'] = 'true';
    return modConfig;
  });
};
