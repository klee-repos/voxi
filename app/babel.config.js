// Expo SDK 55 babel config. `babel-preset-expo` handles expo-router + RN; the worklets plugin (Reanimated 4
// uses react-native-worklets) MUST be last.
module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  }
}
