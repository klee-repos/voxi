// Preview for BucketCard — the reveal morph card: a bottom-flush glass reading
// sheet that rises from the dock. A grab handle + top-right close X; a horizontally
// scrolling section-TITLE tab bar (the heading AND the in-place section switch);
// the grounded body (or the fact rows + per-fact source links); a pinned green
// audio transport (filled play/pause + state label + a calm static level meter).
// OVERLAY: absolute-fill, so each cell is a FIXED 390x560 dark stage rendered OPEN.
// Takes surface + reduceMotion as PROPS (not context).
//   Orchestrator: add cfg.overrides.BucketCard = {"cardMode":"single","viewport":"390x560"}
import { View } from 'react-native'
import { BucketCard, dark } from 'voxi'

const Stage = ({ children }: { children: React.ReactNode }) => (
  <View style={{ width: 390, height: 560, backgroundColor: '#17181A' }}>{children}</View>
)

const tabs = ['what', 'purpose', 'maker', 'facts'] as any

const facts = [
  {
    text: 'Designed in 1956 by Charles and Ray Eames — their only foray into luxury seating.',
    sourceUrl: 'https://www.hermanmiller.com/eames-lounge',
    sourceTitle: 'Herman Miller',
    quote: 'The Eames Lounge Chair and Ottoman, introduced in 1956.',
  },
  {
    text: 'The shells are seven-ply moulded rosewood veneer; the cushions, down-filled leather.',
    sourceUrl: 'https://www.moma.org/collection/works/2827',
    sourceTitle: 'MoMA',
    quote: 'Moulded plywood, rosewood veneer, leather, and cast aluminium.',
  },
  {
    text: 'Charles wanted it to have "the warm, receptive look of a well-used first baseman’s mitt".',
    sourceUrl: 'https://www.eamesoffice.com/the-work/lounge-chair/',
    sourceTitle: 'Eames Office',
    quote: 'The warm receptive look of a well-used first baseman’s mitt.',
  },
] as any

// The prose "What it is" bucket, audio idle — the play transport reads "Hear it".
export const WhatIdle = () => (
  <Stage>
    <BucketCard
      bucket="what"
      body="A moulded plywood-and-leather lounge chair — the Eames Lounge, that mid-century icon of considered comfort. Rosewood shells, a cast-aluminium base, and cushions you sink into rather than perch upon."
      facts={facts}
      audioUrl={null}
      audioState="idle"
      playing={false}
      reduceMotion
      surface={dark as any}
      tabs={tabs}
      onTab={() => {}}
      onPlayToggle={() => {}}
      onClose={() => {}}
    />
  </Stage>
)

// The "Curious facts" bucket: the divider fact list, each fact with its own tappable
// blue source link. Audio playing → the transport shows Pause + a bright level meter.
export const FactsPlaying = () => (
  <Stage>
    <BucketCard
      bucket="facts"
      body=""
      facts={facts}
      audioUrl={null}
      audioState="ready"
      playing
      reduceMotion
      surface={dark as any}
      tabs={tabs}
      onTab={() => {}}
      onPlayToggle={() => {}}
      onClose={() => {}}
    />
  </Stage>
)

// Honest empty "Who made it" bucket — an answer, not a broken icon. No audio bar.
export const MakerEmpty = () => (
  <Stage>
    <BucketCard
      bucket="maker"
      body=""
      facts={[] as any}
      audioUrl={null}
      audioState="idle"
      playing={false}
      reduceMotion
      surface={dark as any}
      tabs={tabs}
      onTab={() => {}}
      onPlayToggle={() => {}}
      onClose={() => {}}
    />
  </Stage>
)
