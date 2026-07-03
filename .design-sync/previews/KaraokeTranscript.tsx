// Preview for KaraokeTranscript — the Deep Dive player's hero: a two-voice
// read-along in large bold text with word-level highlight synced to the
// playhead. The current word sits in a translucent-green box. Dark surface.
import { View } from 'react-native'
import { KaraokeTranscript, dark } from 'voxi'

const transcript = [
  { speaker: 'ARLO', text: 'So this is the Eames Lounge Chair — a genuine icon of mid-century design.' },
  { speaker: 'MAVE', text: 'Right, and everyone assumes it was meant to be affordable. It absolutely was not.' },
  { speaker: 'ARLO', text: 'Charles and Ray Eames wanted it to feel like a well-worn baseball mitt — warm and receptive.' },
  { speaker: 'MAVE', text: 'A luxury object dressed up as something cosy. Clever, honestly.' },
]

const Stage = ({ positionSec }: { positionSec: number }) => (
  <View style={{ backgroundColor: '#17181A', height: 440, padding: 24 }}>
    <KaraokeTranscript transcript={transcript as any} positionSec={positionSec} durationSec={18} surface={dark} reduceMotion />
  </View>
)

export const MidPlayback = () => <Stage positionSec={4.5} />
export const Opening = () => <Stage positionSec={0.5} />
