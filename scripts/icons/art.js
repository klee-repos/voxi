// Voxi app-icon art — the aurora Orb, as SVG. This is the same character the app renders in
// app/src/components/Orb.tsx (green hot core -> symmetric blue halo), so the icon is a literal promise of
// the Guide you meet inside the app. generate.js rasterizes this to every PNG the Expo config consumes.
//
// Craft was locked by an adversarial multi-critic review: ONE off-axis specular (no blown-out central bloom),
// an additive radially-symmetric blue halo behind the whole sphere (not a bottom-left-only rim seam), a
// green-dominant core cooled one notch toward teal with a strong symmetric cyan rim (so the hot-core -> blue-edge
// signature survives at 48px and doesn't read as a generic green status dot), and a grain layer to kill
// gradient step-banding against near-black.
//
// All geometry is on a 1024 canvas. Env variants shift only the deep-space GROUND hue + add a bottom band.

const C = 1024
const CX = 512
const CY = 470 // orb sits a touch above optical center

// Deep-space ground per environment. Orb identity (green/blue) stays constant; the ground hue is what
// differentiates the builds on the home screen. `dark` is the deeper ground for the iOS-18 dark appearance.
const GROUND = {
  prod: { g0: '#15192A', g1: '#0B0C15', g2: '#05050B' },
  dark: { g0: '#0C1018', g1: '#06080F', g2: '#020207' },
  beta: { g0: '#1B1440', g1: '#100B24', g2: '#070511' },
  dev: { g0: '#2A1A06', g1: '#181004', g2: '#0A0702' },
}

const stops = (arr) => arr.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')

// Sphere body gradient — green-dominant, core cooled toward mint-teal, edge teal-green (the blue comes from
// the rim + halo so it reads symmetrically). Grayscale ramp for the iOS tinted variant.
function sphereStops(mono) {
  return mono
    ? [[0, '#FFFFFF'], [0.09, '#ECECEC'], [0.24, '#C6C6C6'], [0.42, '#9A9A9A'], [0.60, '#767676'], [0.78, '#5C5C5C'], [0.90, '#4C4C4C'], [1, '#404040']]
    : [[0, '#E9FFF4'], [0.10, '#B4F0D2'], [0.24, '#63D598'], [0.42, '#2FB268'], [0.60, '#1E9A5C'], [0.78, '#1A8C6E'], [0.90, '#1E8F86'], [1, '#249B96']]
}

// A crisp full-width bottom band for at-a-glance env differentiation. The iOS squircle mask rounds its bottom
// corners, so a straight rect reads as a clean shelf. `ink` on the band clears WCAG AA on the band fill.
function bandSvg(label, fill, ink = '#0A0A0F') {
  const h = 150, y = C - h
  return `
  <rect x="0" y="${y}" width="${C}" height="${h}" fill="${fill}"/>
  <rect x="0" y="${y - 5}" width="${C}" height="5" fill="rgba(255,255,255,0.28)"/>
  <text x="${CX}" y="${y + h / 2 + 26}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="76" letter-spacing="14" fill="${ink}">${label}</text>`
}

// opts: { ground:'prod'|'dark'|'beta'|'dev', mono:bool, bg:bool, badge:{label,fill}|null }
//  bg:false  -> transparent (no ground rect, no grain) for the Android adaptive foreground (padded by generate.js)
//  mono:true -> grayscale luminance for the iOS tinted appearance
function orbSvg({ ground = 'prod', mono = false, bg = true, badge = null } = {}) {
  const gr = mono ? { g0: '#0A0A0A', g1: '#050505', g2: '#000000' } : GROUND[ground]
  const HALO = mono ? '120,120,120' : '78,162,250' // emissive halo (blue)
  const RIM = mono ? '255,255,255' : '150,225,255' // symmetric rim (cyan)
  const GRN = mono ? '175,175,175' : '70,205,150' // green outer bloom
  const rgba = (c, a) => `rgba(${c},${a})`

  const defs = `
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.46" r="0.85">${stops([[0, gr.g0], [0.42, gr.g1], [1, gr.g2]])}</radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">${stops([[0, rgba(GRN, 0.20)], [0.4, rgba(HALO, 0.14)], [0.7, rgba(HALO, 0.05)], [1, rgba(HALO, 0)]])}</radialGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">${stops([[0, rgba(HALO, 0.05)], [0.55, rgba(HALO, 0.16)], [0.70, rgba(HALO, 0.34)], [0.74, rgba(HALO, 0.30)], [0.86, rgba(HALO, 0.10)], [1, rgba(HALO, 0)]])}</radialGradient>
    <radialGradient id="sphere" cx="0.5" cy="0.44" r="0.6">${stops(sphereStops(mono))}</radialGradient>
    <radialGradient id="rim" cx="0.5" cy="0.5" r="0.5">${stops([[0, rgba(RIM, 0)], [0.9, rgba(RIM, 0)], [0.955, rgba(RIM, 0.6)], [0.99, rgba(RIM, 0.14)], [1, rgba(RIM, 0)]])}</radialGradient>
    <linearGradient id="shade" x1="0.2" y1="0.16" x2="0.84" y2="0.88">${stops([[0, 'rgba(255,255,255,0.04)'], [0.5, 'rgba(0,0,0,0)'], [1, 'rgba(2,10,20,0.34)']])}</linearGradient>
    <radialGradient id="glint" cx="0.5" cy="0.5" r="0.5">${stops([[0, 'rgba(255,255,255,0.9)'], [0.55, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']])}</radialGradient>
    <clipPath id="ball"><circle cx="${CX}" cy="${CY}" r="238"/></clipPath>
    <filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
  </defs>`

  const bgRect = bg ? `<rect width="${C}" height="${C}" fill="url(#bg)"/>` : ''
  const grain = bg ? `<rect width="${C}" height="${C}" filter="url(#grain)" opacity="0.028"/>` : ''
  const band = badge ? bandSvg(badge.label, badge.fill) : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${C}" height="${C}" viewBox="0 0 ${C} ${C}">
  ${defs}
  ${bgRect}
  <circle cx="${CX}" cy="${CY}" r="430" fill="url(#glow)"/>
  <circle cx="${CX}" cy="${CY}" r="330" fill="url(#halo)"/>
  <circle cx="${CX}" cy="${CY}" r="238" fill="url(#sphere)"/>
  <g clip-path="url(#ball)"><circle cx="${CX}" cy="${CY}" r="238" fill="url(#shade)"/></g>
  <circle cx="${CX}" cy="${CY}" r="238" fill="url(#rim)"/>
  <ellipse cx="${CX - 84}" cy="${CY - 96}" rx="58" ry="33" fill="url(#glint)" transform="rotate(-34 ${CX - 84} ${CY - 96})" filter="url(#soft)"/>
  <circle cx="${CX - 82}" cy="${CY - 100}" r="8" fill="rgba(255,255,255,0.82)"/>
  ${grain}
  ${band}
</svg>`
}

module.exports = { orbSvg, C }
