// Preview for Scrubber — the Deep Dive player's seekable progress bar: a filled
// track + round thumb, elapsed clock left, remaining clock right (Spotify-podcast
// pattern). Tap/drag-to-seek. Static layout. Takes an explicit `surface` prop and
// position/duration in seconds. Dark shell. Give it a stretched-width container.
import { View } from 'react-native'
import { Scrubber, dark } from 'voxi'

const Stage = ({ positionSec, durationSec }: { positionSec: number; durationSec: number }) => (
  <View style={{ backgroundColor: '#17181A', padding: 32 }}>
    <View style={{ width: 320 }}>
      <Scrubber positionSec={positionSec} durationSec={durationSec} onSeek={() => {}} surface={dark as any} />
    </View>
  </View>
)

// ~40% through a ~2:52 Deep Dive → "1:08" / "-1:44".
export const MidTrack = () => <Stage positionSec={68} durationSec={172} />
// Near the start → "0:05" / "-2:47".
export const NearStart = () => <Stage positionSec={5} durationSec={172} />
