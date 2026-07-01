# Voxi — Design Direction (Mobbin synthesis)

> Working notes from the Mobbin exploration. Feeds the design section of the master plan.
> **Brand/IP (G5):** this doc is part of the copy corpus counsel clears — say **"the Guide" / "Voxi"**,
> never any third-party property; the persona stands on its own (see PLAN §8.1).
> Concept: **"The Guide" as a living, cosmic museum.** A real-world Pokédex narrated by a dry,
> omniscient-yet-charming, faintly absurd **British** narrator (an inspired-by register that must work
> with every outside reference removed). Dark, atmospheric, editorial. A luminous, characterful **orb**
> is the embodied agent. Camera-first. Motion-rich but never gimmicky.

## North-star aesthetic
- **Mood:** deep-space ink / observatory at night. Not sterile AI-white. Warm, literary, slightly
  absurd. Think: a planetarium gift shop run by a witty British AI.
- **Color:** near-black indigo base (`#0B0B14`–`#12121F`), luminous accent gradient on the orb
  (iridescent violet→cyan→warm gold), parchment/cream for "entry" reading surfaces (museum-card
  contrast moment). One restrained accent for actions.
- **Type:** an editorial serif for entry titles & the Guide's "voice" (museum-plaque feel), a clean
  geometric/grotesk sans for UI and body. Generous leading on reading surfaces.
- **Motion:** Reanimated 4 for UI transitions; Skia (or Rive) for the orb + particle/point-cloud
  processing. Everything breathes — slow idle motion on the orb, reactive amplitude while speaking.
- **The orb = Voxi.** It is the one persistent character across capture → reveal → podcast → chat.
  States: idle (slow drift), listening (inhale/ripple), thinking (denser particles), speaking
  (amplitude-reactive bloom), uncertain (dim/flicker). **Direction (DECIDED — PLAN §10.1 / D3): a
  Tolan-style crystalline gem with a luminous bloom**, built once in Rive with the 5 states + per-context
  dock behavior. (The earlier "prototype both" fork is closed.)

## Per-surface references (study these on Mobbin)
### Speaking orb / voice agent
- Tolan "Oracle" — crystalline gem + bloom + audio waveform + speech bubbles. *Most on-brand.*
  https://mobbin.com/screens/f46de34a-05c9-4fd5-b28e-7b5775830c89 ,
  https://mobbin.com/screens/5333ea64-0d16-4612-b414-1e85e2dc526c
- Perplexity particle sphere (minimal, dark): https://mobbin.com/screens/7e0cd49c-8056-4c75-85e4-e72b36704de4
- ChatGPT Voice soft sphere: https://mobbin.com/screens/64be7109-fd45-4292-9010-c6ad15a88d6d
- Meta AI `[cheerful]` emotion tag + "Talk or type" hybrid bar (voice+text in one): https://mobbin.com/screens/a13d716b-b9dc-4775-9934-b5c881b221a3

### Camera capture (open straight to this — primary screen)
- Apple Store object scanner, corner-arrow reticle "move iPhone": https://mobbin.com/screens/1c306f75-d3ed-475f-8faa-ce00ba540d9d
- IKEA Place corner-bracket frame "adjust frame to fit object" + search: https://mobbin.com/screens/d8d677f2-d740-4124-bcd0-d3cc1aee4192
- adidas "Aim your phone at a product" double-ring reticle: https://mobbin.com/screens/e63f6b2c-5c59-4c93-a9a4-a51202d6c7a4
- KAYAK bag scan — **point-cloud mesh overlay** (great "analyzing" texture): https://mobbin.com/screens/68443d21-977e-450d-a430-5696d18a601d

### Processing / "analyzing" transition (hide latency here)
- KAYAK point-cloud mesh mapping onto the object (above).
- Perplexity "Creating" forming particle torus: https://mobbin.com/screens/2b1e86ce-3802-4c41-8a81-f9e6767e0b3c
- Instagram twinkling star-field on dark: https://mobbin.com/screens/3390cde8-e413-4911-b364-b9a3c72535fe
- BitePal "Analyzing ✨" with peeking mascot (personality): https://mobbin.com/screens/7c4303aa-d4d6-4687-bf34-7da8875c94db
- Snapchat sparkle-burst generate: https://mobbin.com/screens/d447691b-00da-41eb-8654-1ddfd362353a
- **Pattern:** captured photo freezes → point-cloud constellation forms over it → particles converge
  into the orb as the entry card rises. Voxi narrates witty loading lines ("Consulting the Guide…").

### Reveal — the "entry" (museum knowledge card)
- Blue Bottle museum-object card: image + provenance caption + poetic line + rich body. *The
  reference for the Guide's editorial tone.* https://mobbin.com/screens/54bc214c-8d90-48a2-8031-e5a16f334919
- Moonlitt "Wolf Moon" — dark atmospheric hero + title + date + description + tags + carousel: https://mobbin.com/screens/8b47f8f9-3f47-41a7-9a13-f340f3370334
- Moonly "The Fool" card-as-entry: https://mobbin.com/screens/fe663803-42b7-4cb9-9767-5cfaba2bf47b
- Qantas spec-row sheet (for "practical application"/specs block): https://mobbin.com/screens/5d10a929-f160-44fd-9336-efca99648f62
- Zesty image-trio + bold highlights + "Ask Zesty" bar (conversational knowledge): https://mobbin.com/screens/0573c3fb-7c3f-4e00-9f86-fa00bbdffed4
- **Pattern (REVISED — PLAN §10.2 screen 5 / D5; supersedes the old photo-as-hero layout):** lead with
  (1) the **specific ID title** + a **confidence chip whose treatment changes by band** (solid CONFIDENT /
  warm-gold "confident maybe" PROBABLE), (2) one-line Guide quip, (3) succinct "what it is" + "what it's
  for"; the captured photo is a **thumbnail**, not the hero; **one primary action** (Generate story OR Ask
  Voxi); **"Add a tip" demoted** to a secondary/contextual affordance; **"How sure are you?" auto-elevates
  only in PROBABLE/low**. Extensible content slots (where-to-buy/where-found) for the future.

### Podcast player (two AI hosts)
- Otter.ai speaker-labeled transcript + inline player ("Speaker 1"): https://mobbin.com/screens/f1f3f387-0e73-4b60-bec0-31c2ef2fac74
- ElevenReader read-along (text highlights as spoken) + host name + scrubber: https://mobbin.com/screens/a056a95b-9dba-46c1-bc17-35e379cdcb50
- Spotify "Good Hang" episode player w/ live speaker transcript on colored bg: https://mobbin.com/screens/ae8b50df-79f2-4113-bce2-68a07e387fb3
- Fabric dark player + timestamped transcript + "Ask": https://mobbin.com/screens/0811382a-64f3-4e02-a022-66189be04c50
- **Pattern:** generative cover art for the episode, two-host transcript that highlights line-by-line
  as spoken, scrubber + 15s skip + speed. **REVISED — PLAN §6.2: single-call render → progressive
  *download* (not segment-in-seconds); own a 15–40s "composing your episode" wait.**

### Conversation (voice-default, keyboard optional)
- Meta AI talk-or-type + emotion tags (above).
- One / Gemini / Copilot clean text chat with mic in the bar: https://mobbin.com/screens/5d74df4a-22ec-4ec4-8880-d518819a4f2b ,
  https://mobbin.com/screens/ef2922b1-15ce-468e-b028-2ed58480b34f
- **Pattern:** default = full-screen orb voice mode (Tolan/ChatGPT-voice) with a small ⌨️ toggle that
  collapses to a text thread; mic always reachable. Persona identical to narration & podcast.

### Threads (1 photo = 1 thread)
- X "Chat History" — **image grid up top + auto-titled, timestamped conversations.** *Best template.*
  https://mobbin.com/screens/9d3a6801-addd-4a8f-8165-55d6205c681a
- Gemini date-grouped titled chats (note real titles like "Tumbler Identification…"): https://mobbin.com/screens/9e114d8f-6ebd-4c4a-859d-0617a100cbf7
- **Pattern:** grid of captured-object thumbnails (the "collection"/proto-Pokédex) + a list of
  auto-titled threads grouped by date. Sets up future gamification/badges naturally.

### Welcome / email auth (dead-simple)
- Sonos / Oura / Luma / Walmart single email-field "Continue": https://mobbin.com/screens/ae9eef3b-ab21-4b81-ae7b-f2cf0412ad3b ,
  https://mobbin.com/screens/e4338209-c613-4f81-a7ac-86b5c3fd4d7e , https://mobbin.com/screens/05e1c896-6b6b-4ed1-a6fd-03b3b2f98da9
- **Pattern:** one email field → magic-link / OTP, branded with the orb. No password friction.

## Screen inventory (v1)
1. Welcome/auth (email-first) → 2. Camera capture (default landing) → 3. Processing (point-cloud) →
4. Entry reveal (museum card + speaking orb) → 5. Podcast player → 6. Conversation (voice/text) →
7. Threads/collection → 8. Unknown-item interview → 9. Add-a-tip/contribution → 10. Settings/account.
