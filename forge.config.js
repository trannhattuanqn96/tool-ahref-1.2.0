const path = require('path');

module.exports = {
  packagerConfig: {
    asar: true,
    // Put both icons in ./build/: muatool.icns (mac), muatool.ico (win), muatool.png (linux optional)
    // Electron Packager will append the proper extension per platform if you pass a base path
    icon: path.resolve(__dirname, 'build/muatool'),

    // macOS signing/notarization (optional – uncomment and provide env vars when you’re ready)
    // osxSign: {
    //   identity: process.env.MAC_CODESIGN_IDENTITY, // e.g. "Developer ID Application: <Your Name> (<TEAMID>)"
    // },
    // osxNotarize: {
    //   appleId: process.env.APPLE_ID,
    //   appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    //   teamId: process.env.APPLE_TEAM_ID,
    // },
  },
  rebuildConfig: {},
  makers: [
    // Windows
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'muatool',
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] },

    // macOS
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: {} },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] }
  ],
};