import { afterEach, describe, expect, it } from 'bun:test'

// The dynamic config (app.config.js) resolves display name, bundle id, and icon by APP_VARIANT.
// This is the one silent-failure surface (a dropped nested key → wrong bundle shipped), so we pin every branch.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const makeConfig = require('./app.config.js') as (arg: { config: any }) => any

// A minimal stand-in for what Expo passes from app.json — includes nested keys we must NOT drop.
const base = () => ({
  slug: 'voxi',
  scheme: 'voxi',
  ios: {
    bundleIdentifier: 'com.kvnlee.voxi',
    appleTeamId: 'DRJEJC9KRM',
    infoPlist: { NSCameraUsageDescription: 'cam', NSAllowsLocalNetworking: true },
  },
  android: { package: 'com.kvnlee.voxi', adaptiveIcon: { backgroundColor: '#000000' } },
  extra: { eas: { projectId: '12b59473-2cb0-4703-9003-7b1e294f17f3' } },
})

const withVariant = (v?: string) => {
  if (v) process.env.APP_VARIANT = v
  else delete process.env.APP_VARIANT
  return makeConfig({ config: base() })
}

afterEach(() => {
  delete process.env.APP_VARIANT
})

describe('app.config variant resolution', () => {
  it('production (default / unset) keeps the live bundle id and full appearance set', () => {
    const c = withVariant(undefined)
    expect(c.name).toBe('Voxi')
    expect(c.ios.bundleIdentifier).toBe('com.kvnlee.voxi')
    expect(c.ios.icon).toEqual({
      light: './assets/icon/prod/light.png',
      dark: './assets/icon/prod/dark.png',
      tinted: './assets/icon/prod/tinted.png',
    })
    expect(c.icon).toBe('./assets/icon/prod/light.png')
    expect(c.android.package).toBe('com.kvnlee.voxi')
  })

  it('development suffixes the bundle id and ships a single badged icon', () => {
    const c = withVariant('development')
    expect(c.name).toBe('Voxi Dev')
    expect(c.ios.bundleIdentifier).toBe('com.kvnlee.voxi.dev')
    expect(c.ios.icon).toBe('./assets/icon/dev/icon.png')
    expect(c.android.package).toBe('com.kvnlee.voxi.dev')
  })

  it('preview suffixes the bundle id and ships the beta icon', () => {
    const c = withVariant('preview')
    expect(c.name).toBe('Voxi Beta')
    expect(c.ios.bundleIdentifier).toBe('com.kvnlee.voxi.preview')
    expect(c.ios.icon).toBe('./assets/icon/preview/icon.png')
  })

  it('an unknown APP_VARIANT falls back to production (never ships a broken id)', () => {
    const c = withVariant('staging-nonsense')
    expect(c.name).toBe('Voxi')
    expect(c.ios.bundleIdentifier).toBe('com.kvnlee.voxi')
  })

  it('preserves nested ios/extra keys through the spread (regression guard)', () => {
    const c = withVariant('development')
    // the P1 finding: a naive override that replaces `ios` wholesale would drop these.
    expect(c.ios.infoPlist.NSCameraUsageDescription).toBe('cam')
    expect(c.ios.appleTeamId).toBe('DRJEJC9KRM')
    expect(c.extra.eas.projectId).toBe('12b59473-2cb0-4703-9003-7b1e294f17f3')
    expect(c.scheme).toBe('voxi')
  })

  it('differentiates the Android adaptive background per variant', () => {
    expect(withVariant('development').android.adaptiveIcon.backgroundColor).toBe('#231508')
    expect(withVariant('preview').android.adaptiveIcon.backgroundColor).toBe('#12102A')
    expect(withVariant('production').android.adaptiveIcon.backgroundColor).toBe('#0B0B14')
    // foregroundImage is shared across variants
    expect(withVariant('production').android.adaptiveIcon.foregroundImage).toBe('./assets/icon/android-foreground.png')
  })
})
