---
version: alpha
name: Voxi (iOS)
description: >-
  Voxi's mobile design system. Two coordinated
  themes — the signature "Warm" (cream) light theme and a "Dark" charcoal
  theme — built on a friendly humanist sans UI, a heavy serif brand
  logotype, a green audio-first action color, and fully rounded pill controls.
  Colors were pixel-sampled from reference screens, then audited against live
  screens across 8 dimensions; type sizes are expressed on the iOS logical (pt)
  scale.

# ---------------------------------------------------------------------------
# COLOR TOKENS
# Primary/default theme = Warm (cream). Dark theme tokens are prefixed `dark-`.
# ---------------------------------------------------------------------------
colors:
  # — Warm (light) surfaces —
  background:        "#F4F1E8"   # app canvas — warm cream (range #F1EEE6…#F7F6F1)
  surface:          "#FFFFFF"    # cards, sheets, modals (newer era)
  surface-warm:     "#FBF9F3"    # softer off-white card used in the room feed (older era)
  surface-sunken:   "#EDEAE0"    # inset text fields, topic chips, ghost buttons, segmented tracks
  hairline:         "#E6E2D7"    # 1px dividers / separators
  scrim:            "rgba(20,18,14,0.35)"  # dim behind bottom sheets

  # — Warm text —
  text-primary:     "#262524"    # warm near-black (headings, names, body)
  text-secondary:   "#605E58"    # warm gray (supporting labels, meta)
  text-tertiary:    "#A3A19B"    # muted gray (placeholders, disabled, unit labels)

  # — Brand green (audio-first primary action) —
  green:            "#29AB60"    # PRIMARY pre-room CTA pill ("Start a Room", "Let's go")
  green-bright:     "#00C068"    # success/hero status banner ("You raised your hand!")
  green-soft:       "#57B871"    # secondary "+ Room" pill, ON toggles, "+ Add a Topic", some create-room pills
  green-badge:      "#2AAA60"    # moderator ✳ badge fill
  on-green:         "#FFFFFF"

  # — Blue (links, social, IN-ROOM & join actions) —
  blue:             "#3D89F5"    # inline links, Follow, join/mic FABs, in-room "ask to speak"
  blue-bright:      "#057ADE"    # redesign action buttons ("add back", "voice message")
  blue-muted:       "#5B74A2"    # FILLED "Following" active-state pill
  select-highlight: "#C9D6EE"    # periwinkle fill behind a selected Open/Social/Closed tile
  on-blue:          "#FFFFFF"

  # — Messaging / Backchannel —
  bubble-incoming:  "#E4F2FB"    # incoming DM bubble (pale blue; older builds may tint it mint)
  bubble-outgoing:  "#EFEDE7"    # outgoing DM bubble (cream-gray)
  send-active:      "#3B8AF0"    # active SEND button
  send-idle:        "#8794B5"    # idle SEND button (muted blue-gray)

  # — Indicators —
  online-dot:       "#2FB65A"    # green presence dot on avatars
  unread-dot:       "#3D89F5"    # blue unread dot on rows / tab badge

  # — Warm exit accent —
  terracotta:       "#C56A3E"    # "Leave quietly" text (burnt-orange; ~#C2603F–#C56A3E)

  # — Create-room pastel tiles (soft tints, flat illustrations) —
  pastel-peach:     "#FAEBCF"    # "Anyone on Voxi"
  pastel-mint:      "#E3F7E8"    # "My Friends"
  pastel-sky:       "#E6F1FB"    # "People I choose…" (light blue, not cyan)
  pastel-cream:     "#EDEAE1"    # "People I send a link to…"
  pastel-rose:      "#FBE6E4"    # "Schedule an Event"
  pastel-lavender:  "#EDE7FB"    # "Games"

  # — Dark theme —
  dark-background:      "#212325"   # charcoal canvas (range #1E2021…#242628)
  dark-header:          "#000000"   # top nav / status area on dark screens
  dark-surface:         "#2A2C2E"   # elevated cards (barely lighter than canvas)
  dark-surface-sunken:  "#2A2C2E"   # dark topic chips / sunken fills
  dark-hairline:        "#343638"
  dark-text-primary:    "#ECEEEE"   # near-white
  dark-text-secondary:  "#9D9E9E"
  dark-text-tertiary:   "#5E6061"

# ---------------------------------------------------------------------------
# TYPOGRAPHY TOKENS
# fontFamily values reference the two stacks defined in the Typography section:
#   sans  = "Nunito","Open Sans",-apple-system,"SF Pro Text",system-ui,sans-serif
#   serif = "Fraunces",Georgia,"Times New Roman",serif   (logo/display only)
# fontSize is on the iOS pt scale (≈ CSS px on a non-retina reference).
# ---------------------------------------------------------------------------
typography:
  logo:          { fontFamily: serif, fontSize: 22px, fontWeight: 800, letterSpacing: "-0.01em", lineHeight: 1.0 }   # "voxi" wordmark ONLY (≈40px on splash)
  heading:       { fontFamily: sans,  fontSize: 24px, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.15 }  # onboarding headings, large hero titles
  display:       { fontFamily: sans,  fontSize: 22px, fontWeight: 700, lineHeight: 1.15 }                            # profile display name (renders ~20–22pt)
  headline:      { fontFamily: sans,  fontSize: 17px, fontWeight: 600, lineHeight: 1.25 }                            # room-card titles, nav titles, button labels (max ~2 lines)
  name:          { fontFamily: sans,  fontSize: 16px, fontWeight: 600, lineHeight: 1.25 }                            # speaker / person / chat-row names
  body:          { fontFamily: sans,  fontSize: 16px, fontWeight: 400, lineHeight: 1.4 }                             # bios, messages, list-row labels
  callout-bold:  { fontFamily: sans,  fontSize: 15px, fontWeight: 700, lineHeight: 1.3 }                             # follower COUNT numbers ("8.7k", "500")
  section-label: { fontFamily: sans,  fontSize: 15px, fontWeight: 500, lineHeight: 1.3 }                             # PROFILE section labels ("Favorite Topics…","Clubs") — Title Case
  subhead:       { fontFamily: sans,  fontSize: 15px, fontWeight: 500, lineHeight: 1.3 }
  overline:      { fontFamily: sans,  fontSize: 13px, fontWeight: 600, letterSpacing: "0.06em", textTransform: uppercase, lineHeight: 1.2 }  # FEED/discovery section headers ("ROOMS YOU MISSED")
  footnote:      { fontFamily: sans,  fontSize: 13px, fontWeight: 400, lineHeight: 1.3 }                             # timestamps, "166 people / 11", durations, legal microcopy
  caption:       { fontFamily: sans,  fontSize: 12px, fontWeight: 500, lineHeight: 1.2 }                             # pastel-tile labels, small badges

# ---------------------------------------------------------------------------
# SHAPE (border radius)
# ---------------------------------------------------------------------------
rounded:
  sm:    8px      # inner elements, small chips, DM bubbles' tight corner
  md:    12px     # inset text fields, list-group containers
  lg:    16px     # cards, DM bubbles, interest cards
  xl:    20px     # pastel icon tiles (squircle), bottom-sheet top corners
  pill:  999px    # buttons, chips, segmented controls
  full:  9999px   # circular avatars, FABs, indicator dots

# ---------------------------------------------------------------------------
# SPACING (4pt base grid)
# ---------------------------------------------------------------------------
spacing:
  xs:  4px
  sm:  8px
  md:  12px       # gap between stacked cards
  lg:  16px       # screen gutter + card padding (canonical)
  xl:  24px
  xxl: 32px

# ---------------------------------------------------------------------------
# COMPONENT TOKEN MAPPINGS
# ---------------------------------------------------------------------------
components:
  # — Buttons —
  button-primary:            # pre-room green CTA ("Start a Room", "Let's go", "Start Room")
    backgroundColor: "{colors.green}"
    textColor: "{colors.on-green}"
    typography: "{typography.headline}"
    rounded: "{rounded.pill}"
    height: 52px
    padding: "0 24px"
  button-primary-pressed:
    backgroundColor: "#238C4F"
    textColor: "{colors.on-green}"
  button-secondary:          # positive non-audio action ("add back", "voice message")
    backgroundColor: "{colors.blue-bright}"
    textColor: "{colors.on-blue}"
    typography: "{typography.headline}"
    rounded: "{rounded.pill}"
    height: 44px
  button-follow:             # filled Follow CTA
    backgroundColor: "{colors.blue}"
    textColor: "{colors.on-blue}"
    typography: "{typography.subhead}"
    rounded: "{rounded.pill}"
    height: 34px
    padding: "0 18px"
  button-follow-outline:     # compact outlined Follow in the profile top action row
    backgroundColor: "transparent"
    textColor: "{colors.blue}"
    borderColor: "{colors.blue}"
    rounded: "{rounded.pill}"
    height: 30px
  button-following:          # FILLED active state (NOT a ghost)
    backgroundColor: "{colors.blue-muted}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.pill}"
    height: 34px
  button-request:            # request access to a private house/club
    backgroundColor: "{colors.blue}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.pill}"
  button-member:             # joined/member state
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
  button-ghost:              # tertiary cream pill ("message","maybe later","Remove")
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    typography: "{typography.subhead}"
    rounded: "{rounded.pill}"
    height: 44px
  banner-cta:                # WHITE pill CTA sitting on a green-bright banner ("Join!")
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"

  # — In-room controls —
  fab-raise-hand:            # in-room PRIMARY action ("ask to speak" / "join in") — BLUE, not green
    backgroundColor: "{colors.blue}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.full}"
    size: 56px
  chip-chat:                 # bottom "Chat"/"Share"/"Clip" pills
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"

  # — Cards & structure —
  room-card:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 16px
  interest-card:             # Explore "find conversations about…" grid card
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 14px
  section-header-feed:       # feed/discovery headers — uppercase overline
    textColor: "{colors.text-tertiary}"
    typography: "{typography.overline}"
  section-header-profile:    # profile section labels — Title Case
    textColor: "{colors.text-primary}"
    typography: "{typography.section-label}"
  topic-chip:                # Favorite-Topic chip — UPPERCASE label + leading emoji
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    typography: "{typography.footnote}"
    rounded: "{rounded.pill}"
    height: 30px
    padding: "0 12px"
  text-field:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    height: 48px
    padding: "0 16px"
  segmented-control:         # "all/events", "Chats/Requests", "all/DMs"
    backgroundColor: "{colors.surface-sunken}"
    rounded: "{rounded.pill}"
  segmented-thumb:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"
  toggle-on:
    backgroundColor: "{colors.green-soft}"
  select-tile-highlight:     # selected Open/Social/Closed audience tile
    backgroundColor: "{colors.select-highlight}"
    rounded: "{rounded.lg}"
  pastel-tile:
    rounded: "{rounded.xl}"
    size: 96px

  # — Messaging —
  chat-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
  dm-bubble-incoming:
    backgroundColor: "{colors.bubble-incoming}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
  dm-bubble-outgoing:
    backgroundColor: "{colors.bubble-outgoing}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
  dm-input:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"
  compose-fab:               # circular blue compose button (inbox)
    backgroundColor: "{colors.blue}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.full}"
    size: 52px

  # — Chrome —
  nav-home:                  # root screens: LEFT-aligned serif wordmark, transparent bar
    backgroundColor: "transparent"
    typography: "{typography.logo}"
  nav-modal:                 # modal/pushed screens: CENTERED title
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.headline}"
  hero-banner:               # full-bleed status banner
    backgroundColor: "{colors.green-bright}"
    textColor: "{colors.on-green}"
    typography: "{typography.body}"

  # — Indicators —
  avatar:
    rounded: "{rounded.full}"
  online-dot:
    backgroundColor: "{colors.online-dot}"
    rounded: "{rounded.full}"
    size: 12px
  unread-dot:
    backgroundColor: "{colors.unread-dot}"
    rounded: "{rounded.full}"
    size: 10px
---

## Overview

Voxi is a live-audio social app, and its visual language is deliberately
**warm, editorial, and low-chrome** — it gets out of the way so voices lead.
Three ideas define the look:

1. **A warm cream canvas, not a cold white one.** The signature surface is a
   soft, paper-like cream (`background #F4F1E8`). White is reserved for cards
   and sheets that float above it. This gives the whole app a cozy,
   analog-radio feeling rather than a clinical SaaS feeling.
2. **Green for pre-room action, blue for people & in-room action.** Starting or
   scheduling a room is green (`green #29AB60`); *joining*, following, raising a
   hand, and messaging are blue (`blue #3D89F5`). Keep the two lanes separate —
   green never does an in-room job, blue never replaces the "Start a Room" CTA.
3. **A serif logotype over a friendly sans UI.** The `voxi` wordmark is a
   heavy, ball-terminal **serif** — the only serif in the product. Everything
   else (names, titles, body, labels) is a rounded humanist **sans-serif**.
   The contrast is what makes the brand feel hand-made.

The app ships in two themes: **Warm** (the default documented here) and **Dark**
(charcoal `#212325`). A cooler, lighter light variant (`#F7F6F1`) also appears
in later builds; treat it as a temperature shift of the Warm theme, not a third
system.

## Colors

### Warm (light) — default

| Role | Token | Hex | Notes |
|------|-------|-----|-------|
| App canvas | `background` | `#F4F1E8` | Warm cream. Sampled range `#F1EEE6`→`#F7F6F1`. |
| Card / sheet | `surface` | `#FFFFFF` | Newer era — crisp white floating on cream. |
| Feed card | `surface-warm` | `#FBF9F3` | Older era — warm-white, a hair off the canvas. |
| Inset / chip / ghost | `surface-sunken` | `#EDEAE0` | Text fields, topic chips, segmented tracks, tertiary buttons. |
| Divider | `hairline` | `#E6E2D7` | Hairline separators. |
| Primary text | `text-primary` | `#262524` | Warm near-black — never pure `#000`. |
| Secondary text | `text-secondary` | `#605E58` | Warm gray. |
| Tertiary / muted | `text-tertiary` | `#A3A19B` | Placeholders, "followers" unit label, timestamps. |

### Brand green — *pre-room actions only*

| Role | Token | Hex | Where |
|------|-------|-----|-------|
| Primary CTA | `green` | `#29AB60` | "Start a Room", "Start Room", "Let's go", "Choose People…". |
| Success / hero | `green-bright` | `#00C068` | Full-bleed status banners. *Renders vivid; some captures read a warmer grass-green.* |
| Soft accent | `green-soft` | `#57B871` | "+ Room" pill, ON toggles, "+ Add a Topic", and softer create-room pills. |
| Moderator badge | `green-badge` | `#2AAA60` | The ✳ asterisk beside a moderator's name. |

> The `green` and `green-soft` values render close together in practice; the
> "+ Room" and some "Start Room" pills sit between the two. Text on all greens
> is white.

### Blue — *links, people & in-room actions*

| Role | Token | Hex | Where |
|------|-------|-----|-------|
| Links / follow / join | `blue` | `#3D89F5` | Inline links, filled "Follow", follow "+" badges, the in-room **"ask to speak"** FAB, mic/join FABs, compose. |
| Bright action | `blue-bright` | `#057ADE` | Redesign buttons ("add back", "voice message"). |
| Following (active) | `blue-muted` | `#5B74A2` | The **filled** already-following pill (not a ghost). |
| Selected tile | `select-highlight` | `#C9D6EE` | Periwinkle fill behind the chosen Open/Social/Closed audience. |

### Accents, indicators & pastels

- `terracotta #C56A3E` — the "Leave quietly" exit label. A warm, low-alarm
  burnt-orange rather than a red.
- Indicators: `online-dot #2FB65A` (green presence dot on avatars),
  `unread-dot #3D89F5` (blue dot on message rows / tab badge).
- Messaging bubbles: `bubble-incoming #E4F2FB` (pale blue — the color seen on
  current DM screens; older builds may tint it mint), `bubble-outgoing #EFEDE7`
  (cream-gray).
- Create-room tiles use soft pastel fills, each holding a flat illustration:
  `pastel-peach #FAEBCF`, `pastel-mint #E3F7E8`, `pastel-sky #E6F1FB`,
  `pastel-cream #EDEAE1`, `pastel-rose #FBE6E4`, `pastel-lavender #EDE7FB`.

### Dark theme

| Role | Token | Hex |
|------|-------|-----|
| Canvas | `dark-background` | `#212325` |
| Top nav / status | `dark-header` | `#000000` |
| Card | `dark-surface` | `#2A2C2E` |
| Primary text | `dark-text-primary` | `#ECEEEE` |
| Secondary text | `dark-text-secondary` | `#9D9E9E` |
| Tertiary text | `dark-text-tertiary` | `#5E6061` |

Green, blue, and pastel accents carry over unchanged; only the neutrals invert.
Dark cards are only marginally lighter than the canvas — depth comes from
spacing and hairlines, not heavy elevation. (Topic chips render dark
`~#2A2C2E` here; the light-theme cream chip fill is inferred.)

## Typography

Two families:

- **`sans` (UI — everything):**
  `"Nunito", "Open Sans", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`
  Voxi's UI runs on **Nunito** — a friendly humanist/rounded sans — with
  **Open Sans** and the platform system font (**SF Pro** on iOS) as fallbacks.
  All three are humanist sans, so the character stays true regardless of which
  loads. Weights used: 400 / 500 / 600 / 700 / 800. (All free — see
  *Fonts & access* below.)
- **`serif` (logo / display only):**
  `"Fraunces", Georgia, "Times New Roman", serif`, weight 800.
  Used *exclusively* for the `voxi` wordmark — a heavy serif with rounded
  **ball terminals** (≈40px on the splash, ≈22px as the home wordmark).
  **Fraunces** is the free, loadable stand-in for that logotype. Do **not** use
  serif for any body or heading text — even page titles are sans.

> **Serif trap:** bold-serif runs you see *inside* user bios (e.g.
> "𝐁𝐮𝐬𝐢𝐧𝐞𝐬𝐬 | 𝐁𝐫𝐚𝐧𝐝𝐢𝐧𝐠") are **user-typed Unicode math-bold characters**, not an
> app font — the surrounding bio and the sans display name are unaffected. The
> product UI is 100% sans-serif apart from the logo.

### Type ramp

| Token | Size / Weight | Used for |
|-------|---------------|----------|
| `logo` | 22 / 800 serif, `-0.01em` | `voxi` wordmark |
| `heading` | 24 / 700 | Onboarding headings, large hero titles |
| `display` | 22 / 700 | Profile display name (renders ~20–22pt) |
| `headline` | 17 / 600 | Room-card titles, nav titles, button labels (≤2 lines) |
| `name` | 16 / 600 | Speaker, person & chat-row names |
| `body` | 16 / 400 | Bios, messages, list-row labels |
| `callout-bold` | 15 / 700 | Follower/following **counts** (unit label stays muted) |
| `section-label` | 15 / 500, Title Case | **Profile** section labels ("Favorite Topics…", "Clubs") |
| `subhead` | 15 / 500 | Secondary labels, small button text |
| `overline` | 13 / 600, `+0.06em`, UPPERCASE | **Feed/discovery** section headers ("ROOMS YOU MISSED") |
| `footnote` | 13 / 400 | Timestamps, participant meta, durations, legal microcopy |
| `caption` | 12 / 500 | Pastel-tile labels, badges |

> **Two kinds of section header.** Feed/discovery headers ("CLUBS FOR YOU",
> "ROOMS YOU MISSED", "PEOPLE TO FOLLOW") are the small uppercase tracked
> `overline`. **Profile** section labels ("Favorite Topics…", "Member of",
> "Clubs") are the larger Title-Case `section-label`. Don't uppercase the
> profile ones.

Sizes are on the iOS **pt** scale (anchored: the wordmark measures ~22pt).
Values ≤13pt carry ±1–2pt measurement tolerance at reference resolution.

### Fonts & access

Every family and weight above is **free and loadable** — no licensed fonts.
In this repo they're wired up and ready to use.

**Expo / React Native** (this app) — fonts are bundled via `@expo-google-fonts`
and loaded once at the root (`app/app/_layout.tsx` calls `useVoxiFonts()`).
Reference them through `app/src/lib/fonts.ts`:

```ts
import { typeStyles, sans, serif } from "@/lib/fonts"

<Text style={typeStyles.headline}>Room title</Text>   // ready-made ramp styles
<Text style={{ fontFamily: sans("600") }}>…</Text>      // pick a weight explicitly
<Text style={{ fontFamily: serif("800") }}>voxi</Text>  // the wordmark
```

> RN ignores `fontWeight` on a named static instance — always choose the
> **weight-specific family** (`sans("600")`, `type.family.sans["700"]`, …) rather
> than pairing one base family with a `fontWeight` prop.

Weight → loaded family (all confirmed present as bundled `.ttf`):

| Token style | Weight | Family constant |
|-------------|--------|-----------------|
| sans regular | 400 | `Nunito_400Regular` |
| sans medium | 500 | `Nunito_500Medium` |
| sans semibold | 600 | `Nunito_600SemiBold` |
| sans bold | 700 | `Nunito_700Bold` |
| sans extrabold | 800 | `Nunito_800ExtraBold` |
| serif title | 700 | `Fraunces_700Bold` |
| serif logo | 800 | `Fraunces_800ExtraBold` |
| serif black | 900 | `Fraunces_900Black` |

Install (already added): `@expo-google-fonts/nunito`,
`@expo-google-fonts/fraunces`, `@expo-google-fonts/open-sans`, `expo-font`.

**Web** (docs / marketing) — load the same families from Google Fonts:

```css
@import url("https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&family=Open+Sans:wght@400;600;700&family=Fraunces:opsz,wght@9..144,700;9..144,800;9..144,900&display=swap");
```

## Layout

- **Screen gutter:** `spacing.lg` (16px) left/right.
- **Card padding:** 16px all sides; **card-to-card gap:** `spacing.md` (12px).
- **Grids:** single-column feeds; create-room picker is a 3-column tile grid;
  the Explore interest grid is 2-column.
- **Avatar sizes:** profile header ~64–72px; in-room speaker ~64px; list-row
  ~40–44px; overlapping feed clusters ~44px.
- **In-room speaker grid:** 3 columns of circular avatars, name centered below,
  a muted-mic glyph overlaid bottom-right, a green ✳ moderator badge to the
  left of the name, and a blue "+" follow badge top-right.
- **Nav bar:** transparent, borderless, line-icon.
  - *Root/home screens:* **left-aligned `voxi` serif wordmark** (not a
    centered title), with right-aligned action icons (compose/paper-plane,
    bell with red dot, history/clock).
  - *Modal / pushed screens:* **centered title** ("activity", "BACKCHANNEL",
    a conversation name).
- **Tab bar:** line icons, **no text labels** (universal). Icon *count and set*
  are context-dependent — e.g. explore stack = globe / search / calendar /
  avatar; a home/search/people/chat set and a 3-icon home/search/messages set
  also exist. The messages/backchannel tab can carry a blue unread badge.
- **Bottom sheets:** rounded top corners (`rounded.xl` ~20px), a grab handle,
  content padded 16–20px, primary pill pinned near the bottom.

## Elevation & Depth

Depth is intentionally **shallow** — the app reads as flat paper with cards
lifted just off the surface.

- **Card shadow (Warm):** `y 2px, blur 12px, color rgba(20,18,14,0.06)`. The
  white-on-cream contrast does most of the separation work.
- **Bottom sheet:** standard iOS sheet lift plus a `scrim` (`rgba(20,18,14,0.35)`)
  over the content behind it.
- **Dark theme:** almost no shadow; rely on `dark-surface` vs `dark-background`
  and `dark-hairline`.
- Avoid glows, gradients, and stacked/heavy shadows — they read as off-brand.

## Shapes

- **Cards, DM bubbles, interest cards:** `rounded.lg` (16px).
- **Buttons, chips, segmented controls, FABs:** `rounded.pill` (fully rounded).
  Primary CTA height 52px; follow/secondary 34–44px; in-room raise-hand FAB
  ~56px circle.
- **Text fields & list groups:** `rounded.md` (12px).
- **Pastel icon tiles:** `rounded.xl` (~20px squircle), ~96px.
- **Avatars & indicator dots:** always circular (`rounded.full`).
- **Sheets/modals:** `rounded.xl` (~20px) top corners only.

## Components

### Buttons
- **Primary (green pill)** — **pre-room** actions only. Green `#29AB60`, white
  `headline` text, 52px pill, often emoji-prefixed (🎉 "Start Room",
  ✌️ "Let's go"). Pressed → `#238C4F`.
- **Secondary (blue)** — `blue-bright #057ADE` pill for positive non-audio
  actions ("add back", "voice message").
- **Follow** — filled `blue #3D89F5` pill (CTA). A compact **outlined** variant
  (transparent fill, blue border + blue text) appears in the profile top action
  row on other-user profiles.
- **Following** — a **filled** `blue-muted #5B74A2` pill with white text (it is
  *not* a ghost/outline).
- **Request / Member** — blue `request` pill for private houses → cream
  `button-member` "Member" once joined.
- **Ghost / tertiary** — `surface-sunken #EDEAE0` pill, near-black text
  ("message", "maybe later", "Remove", "share", "settings").
- **Banner CTA** — on a green-bright banner the buttons are **white pills**
  ("Join!", "Maybe later?"), never green.

### In-room controls
The **primary in-room action is blue, not green**: the "ask to speak" / "join
in" / raise-hand control is a **blue circular FAB** (`fab-raise-hand`, ~56px,
`blue #3D89F5`) with a white hand/join glyph. The bottom bar carries cream
`chip-chat` pills ("Chat" with speech-bubble icon, "Share", "Clip"). "Leave
quietly" sits top-right (or bottom-left in feed rooms) as `terracotta` text.

### Room card (feed)
`surface-warm` card, 16px radius/padding. Order: **overline** club label
(uppercase, muted) + 🏠 glyph → **headline** room title (≤2 lines) →
overlapping circular speaker avatars with `name`-weight names and 💬 glyphs →
`footnote` meta row ("166 people / 11"). A "…" overflow sits top-right.

### Section headers
- **Feed/discovery:** `overline` — uppercase, `+0.06em`, `text-tertiary`, often
  with a hand-drawn squiggle rule and a trailing blue "View All" link.
- **Profile:** `section-label` — **Title Case**, near-black, e.g.
  "Favorite Topics…" with a blue "View all".

### Topic chip
`surface-sunken` pill, `footnote` text, **UPPERCASE** label with a leading emoji
("🎬 MOVIES", "📷 PHOTOGRAPHY"). 30px tall, 12px horizontal padding.

### Segmented control
Pill track (`surface-sunken`) with a white pill thumb on the selected segment
("all / events", "Chats / Requests", "all / DMs 1"); unselected labels muted.

### Text field
`surface-sunken` fill, `rounded.md`, 48px, placeholder in `text-tertiary`
("Add a Room Title (Optional)"). Caret/selection in `green`.

### Toggle
iOS switch; ON track = `green-soft #57B871`, white knob.

### Create-room picker
3-column grid of `pastel-tile`s (~96px, ~20px squircle) — soft pastel fill +
flat illustration + `caption` label. The audience selector is three circular
icons (🌍 Open · 👥 Social · 🔒 Closed); the **selected** one sits on a light
**periwinkle** `select-highlight #C9D6EE` rounded square, with a green
"+ Add a Topic" text action.

### Hero banner
Full-bleed `green-bright #00C068` strip, white `body` text with a leading emoji
("✋ You raised your hand!", "👋 …wants to hear from you!"). CTAs on it are white
pills. A two-button ping variant ("X pinged you 👋") pairs a translucent
"Dismiss" with a white "Go to room". Temporary/status only.

### Messaging (chat rows, bubbles, input)
- **Chat row:** circular avatar + bold `name` + muted "You: …" preview +
  `footnote` timestamp. Two eras: older *BACKCHANNEL* rows end in a chevron;
  redesigned *messages* rows use a blue `unread-dot` instead (the two don't
  co-occur).
- **DM bubbles:** incoming = `bubble-incoming #E4F2FB`, outgoing =
  `bubble-outgoing #EFEDE7`; both `rounded.lg`. A centered `footnote` day/time
  divider ("Today 10:37 AM").
- **Input:** sunken `dm-input` pill ("Say Something…") with a trailing SEND
  button — `send-active #3B8AF0` when there's text, `send-idle #8794B5` idle.
- **Compose FAB:** circular `blue` button on the inbox.

### Chrome & indicators
Transparent, borderless bars with line-weight icons. Header actions
(compose/paper-plane, bell with red dot, history/clock) are right-aligned.
Presence uses a green `online-dot`; unread uses a blue `unread-dot`. Empty
contact slots are dashed-outline circular "+" add-tiles ("best friend",
"partner", "roomies").

## Screen Patterns

- **Messaging / Backchannel** — inbox titled "BACKCHANNEL" (uppercase, older) or
  "messages" (lowercase, redesign); "Chats / Requests" and "all / DMs" pill
  segments; blue compose FAB. Conversation view as in *Messaging* above.
- **Search & Discover** — search field with placeholder variants ("Search
  Voxi", "Find People and Clubs", "search messages") over a segmented
  control directly beneath it: "Top · People · Clubs · Rooms · Events" (newer)
  or "top · people · rooms · houses" (older); selected = white pill on cream
  track, unselected muted gray.
- **Onboarding** — phone-number entry: bold-sans `heading` ("what's your
  number?"), a sunken cream pill field with country flag + dial code, and a
  **blue** "next →" pill (the onboarding CTA is blue, *not* the green primary),
  with muted `footnote` Terms/Privacy microcopy.
- **Explore** — a "FIND CONVERSATIONS ABOUT…" 2-column `interest-card` grid
  (white card, leading emoji, bold title, gray descriptor). An "IN YOUR FRIEND
  GROUP" activity feed — avatar + activity text + a nested event/club card with
  thumbnail, title, date, and an inline Join/RSVP pill — also appears in this
  surface *(pattern; confirm exact layout on-device)*.
- **Create-room flow** — the "Start a Room With…" pastel entry grid (Anyone on
  Voxi / My Friends / People I choose / People I send a link to / Schedule
  an Event / Games) → "people I choose" audience-scope screen with a green
  "Choose People…" pill → **Room Set Up** sheet with disclosure rows (Pinned
  Link, Game, Topics, Language, Hand Raising), a room-title field, green ON
  toggles, and the green "🎉 Start Room" pill.

## Do's and Don'ts

**Do**
- Keep the canvas warm cream and reserve pure white for floating cards/sheets.
- Use green for **pre-room** actions and blue for **join / follow / in-room /
  message** actions — keep the two lanes distinct.
- Pair the serif wordmark with a sans UI — that contrast *is* the brand.
- Make every button, chip, avatar, and FAB fully rounded.
- Keep chrome quiet: transparent bars, label-less tabs, shallow shadows.
- Use warm near-black (`#262524`) and warm grays for text.

**Don't**
- Don't use pure `#000000` text or a cold `#FFFFFF` app background.
- Don't set headings or body in a serif — the serif is the logo, and only the
  logo. (Watch for Unicode-bold bio text masquerading as a font.)
- Don't make the in-room raise-hand button green, or a green banner's CTA green
  — those are blue and white respectively.
- Don't render "Following" as an outline/ghost — it's a filled muted-blue pill.
- Don't uppercase profile section labels (feed headers only) or lowercase feed
  headers.
- Don't introduce a second accent hue; green + blue + warm neutrals is the whole
  palette (pastels are illustration-only). No sharp corners or heavy shadows.
