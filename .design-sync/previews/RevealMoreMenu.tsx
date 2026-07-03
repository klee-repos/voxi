// Preview for RevealMoreMenu — the reveal ⋯ overflow's bottom ACTION SHEET on a
// cataloged item: a scrim + bottom-flush glass sheet with two rows — Regenerate
// (re-run identification, neutral ink) and Delete (destructive terracotta, LAST).
// Delete only expresses intent here; the destructive commit is a separate confirm.
// OVERLAY: absolute-fill → the cell is a FIXED 390x420 dark stage rendered OPEN.
// Takes surface + reduceMotion as PROPS (not context).
//   Orchestrator: add cfg.overrides.RevealMoreMenu = {"cardMode":"single","viewport":"390x420"}
import { View } from 'react-native'
import { RevealMoreMenu, dark } from 'voxi'

const Stage = ({ children }: { children: React.ReactNode }) => (
  <View style={{ width: 390, height: 420, backgroundColor: '#17181A' }}>{children}</View>
)

export const Open = () => (
  <Stage>
    <RevealMoreMenu
      visible
      onRegenerate={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
      reduceMotion
      surface={dark as any}
    />
  </Stage>
)
