// Preview for ErrorState — in-persona error block (bordered surface panel) with
// an optional secondary "Try again" retry Button. On parchment, ~360 wide.
import { View } from 'react-native'
import { ErrorState } from 'voxi'

const Cream = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#F4F1E8', padding: 24, gap: 12, alignItems: 'stretch' }}>
    <View style={{ width: 360 }}>{children}</View>
  </View>
)

export const WithRetry = () => (
  <Cream>
    <ErrorState
      id="err-block"
      retryId="err-retry"
      message="I couldn't quite make it out — the light was against us. Care to try again?"
      onRetry={() => {}}
    />
  </Cream>
)
export const MessageOnly = () => (
  <Cream>
    <ErrorState
      id="err-block-2"
      message="That find has wandered off. It's no longer in your catalog."
    />
  </Cream>
)
