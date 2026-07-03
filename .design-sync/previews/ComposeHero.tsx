// Preview for ComposeHero — the LARGE Deep Dive "how long will this take" wait.
// A brand Orb centred inside a flat determinate dot-ring that fills on an HONEST
// eased estimate, the literal elapsed clock (big green tabular numerals), a title
// and honest copy. Fills the screen height; takes `surface` + `startedAt` props.
// Dark shell. We pin `startedAt` to ~48s ago so the ring reads mid-progress.
import { View } from 'react-native'
import { ComposeHero, dark } from 'voxi'

const Stage = ({ agoMs }: { agoMs: number }) => (
  <View style={{ backgroundColor: '#17181A', height: 560, padding: 24 }}>
    <ComposeHero
      startedAt={Date.now() - agoMs}
      title="Composing your Deep Dive"
      copy="Two voices, one Eames Lounge Chair. This usually takes about two minutes — feel free to wander."
      surface={dark as any}
      reduceMotion
    />
  </View>
)

// ~48s in → roughly two-thirds of the ring filled, elapsed reads "0:48".
export const Composing = () => <Stage agoMs={48_000} />
// Just started → an early ring + "0:04".
export const JustStarted = () => <Stage agoMs={4_000} />
