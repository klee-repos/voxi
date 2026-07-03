// Dynamic Expo config — env-specific bundle id / display name / icon per APP_VARIANT.
//
// app.json stays the static base. Expo loads it and passes it here as `config`; we spread it and override ONLY
// the per-variant keys. Everything else (infoPlist, plugins, scheme, extra.eas.projectId, splash, ...) rides
// through the spread untouched. Production keeps the ORIGINAL bundle id (already live on App Store Connect) so
// existing TestFlight builds are unaffected; dev/preview get suffixed ids so all three coexist on one device.
//
// APP_VARIANT is read at call time (not import) so app.config.test.ts can exercise every branch.

const BASE_ID = 'com.kvnlee.voxi'

const VARIANTS = {
  development: { suffix: '.dev', name: 'Voxi Dev', dir: './assets/icon/dev', ground: '#231508' },
  preview: { suffix: '.preview', name: 'Voxi Beta', dir: './assets/icon/preview', ground: '#12102A' },
  production: { suffix: '', name: 'Voxi', dir: './assets/icon/prod', ground: '#0B0B14' },
}

function resolveVariant() {
  return VARIANTS[process.env.APP_VARIANT] || VARIANTS.production
}

module.exports = ({ config }) => {
  const v = resolveVariant()
  const bundleId = BASE_ID + v.suffix
  const isProd = v === VARIANTS.production
  // Prod ships the full iOS-18 appearance set; dev/preview ship a single badged icon.
  const iosIcon = isProd
    ? { light: `${v.dir}/light.png`, dark: `${v.dir}/dark.png`, tinted: `${v.dir}/tinted.png` }
    : `${v.dir}/icon.png`
  const topIcon = isProd ? `${v.dir}/light.png` : `${v.dir}/icon.png`

  return {
    ...config,
    name: v.name,
    icon: topIcon,
    ios: {
      ...config.ios,
      bundleIdentifier: bundleId,
      icon: iosIcon,
    },
    android: {
      ...config.android,
      package: bundleId,
      adaptiveIcon: {
        ...(config.android && config.android.adaptiveIcon),
        foregroundImage: './assets/icon/android-foreground.png',
        backgroundColor: v.ground,
      },
    },
  }
}
