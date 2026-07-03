// Preview for AudioElement — the web audio playback element. On web it renders a
// REAL DOM <audio> carrying the testID (controls:false), so it is intentionally
// NOT a visual component: it draws nothing. We render it inside a labelled dark
// frame so the card shows the (empty) frame it occupies; the read is "renders, no
// chrome, as designed". Takes {id, src, playing, …} — no theme.
import { View, Text } from 'react-native'
import { AudioElement } from 'voxi'

const Stage = ({ label, playing }: { label: string; playing: boolean }) => (
  <View style={{ backgroundColor: '#17181A', padding: 32, gap: 12 }}>
    <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13 }}>{label}</Text>
    <View
      style={{
        height: 56,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.14)',
        borderStyle: 'dashed',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>invisible &lt;audio&gt; (headless)</Text>
      <AudioElement id="podcast.audio" src="" playing={playing} />
    </View>
  </View>
)

export const Paused = () => <Stage label="Deep Dive audio — paused" playing={false} />
export const Playing = () => <Stage label="Deep Dive audio — playing" playing />
