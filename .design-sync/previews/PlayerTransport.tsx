// Preview for PlayerTransport — the Deep Dive player's compact control row:
//   [⟲15]  ( ▶ / ❚❚ big green )  [15⟳]
// The ±15 are rotate-arrow glyphs with a small "15"; the centre is the large
// green (audio-lane) play/pause disc. Lucide glyphs render as small stub boxes in
// the bundle sandbox — decorative, the "15" numeral + green disc carry the read.
// Takes an explicit `surface` prop. Dark shell.
import { View } from 'react-native'
import { PlayerTransport, dark } from 'voxi'

const Stage = ({ playing }: { playing: boolean }) => (
  <View style={{ backgroundColor: '#17181A', padding: 32, alignItems: 'center' }}>
    <PlayerTransport
      playing={playing}
      onPlayPause={() => {}}
      onSkipBack={() => {}}
      onSkipForward={() => {}}
      surface={dark as any}
    />
  </View>
)

export const Playing = () => <Stage playing />
export const Paused = () => <Stage playing={false} />
