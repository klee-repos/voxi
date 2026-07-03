// Rasterize the Voxi Orb (art.js) into every PNG the Expo config consumes. See README.md.
//   cd scripts/icons && bun install && node generate.js
//
// Emits into app/assets/icon/** + app/assets/favicon.png, writing the source SVG next to each PNG, and
// ASSERTS the App Store icons are opaque (Apple rejects a 1024 marketing icon with an alpha channel).

const { Resvg } = require('@resvg/resvg-js')
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')
const { orbSvg } = require('./art')

const ROOT = path.resolve(__dirname, '..', '..')
const ICON = path.join(ROOT, 'app', 'assets', 'icon')
const ASSETS = path.join(ROOT, 'app', 'assets')

function rasterize(svg, size) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' },
  }).render().asPng()
}

function writeSvg(file, svg) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, svg)
}

// Opaque icon: render + flatten onto the ground so the PNG carries NO alpha channel, then assert it.
async function writeOpaque(file, svg, size = 1024) {
  writeSvg(file.replace(/\.png$/, '.svg'), svg)
  const buf = await sharp(rasterize(svg, size)).flatten({ background: '#000000' }).png().toBuffer()
  fs.writeFileSync(file, buf)
  const m = await sharp(buf).metadata()
  if (m.hasAlpha || m.width !== size || m.height !== size) {
    throw new Error(`${path.relative(ROOT, file)}: expected opaque ${size}x${size}, got alpha=${m.hasAlpha} ${m.width}x${m.height}`)
  }
  return m
}

async function main() {
  const targets = [
    // Production — iOS-18 appearance set (all opaque, no alpha)
    ['prod/light.png', orbSvg({ ground: 'prod' })],
    ['prod/dark.png', orbSvg({ ground: 'dark' })],
    ['prod/tinted.png', orbSvg({ mono: true })],
    // Preview / TestFlight + Development / local — single badged icon each
    ['preview/icon.png', orbSvg({ ground: 'beta', badge: { label: 'BETA', fill: '#B79BFF' } })],
    ['dev/icon.png', orbSvg({ ground: 'dev', badge: { label: 'DEV', fill: '#FFC46E' } })],
  ]
  for (const [rel, svg] of targets) {
    const m = await writeOpaque(path.join(ICON, rel), svg)
    console.log(`  ok  app/assets/icon/${rel}  ${m.width}x${m.height} opaque`)
  }

  // Android adaptive foreground — orb on TRANSPARENT, padded into the adaptive safe zone (~66%).
  const bare = orbSvg({ ground: 'prod', bg: false })
  writeSvg(path.join(ICON, 'android-foreground.svg'), bare)
  const inner = 680, pad = Math.round((1024 - inner) / 2)
  const fg = await sharp(rasterize(bare, inner))
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer()
  fs.writeFileSync(path.join(ICON, 'android-foreground.png'), fg)
  const fm = await sharp(fg).metadata()
  if (!fm.hasAlpha || fm.width !== 1024) throw new Error(`android-foreground: expected 1024 with alpha, got ${fm.width} alpha=${fm.hasAlpha}`)
  console.log(`  ok  app/assets/icon/android-foreground.png  ${fm.width}x${fm.height} transparent`)

  // Web favicon — small opaque orb (browsers don't squircle-mask, so a square is fine).
  fs.writeFileSync(path.join(ASSETS, 'favicon.png'), await sharp(rasterize(orbSvg({ ground: 'prod' }), 64)).flatten({ background: '#0B0C15' }).png().toBuffer())
  console.log('  ok  app/assets/favicon.png  64x64')

  console.log('\nDone. Run a fresh `expo prebuild --clean` or an EAS build to pick up the new icons.')
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
