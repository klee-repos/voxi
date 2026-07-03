// Preview for ConfirmDialog — the centered, scrim-backed decision surface (2nd
// step of a two-step destructive flow, and the regenerate confirm). A SOLID card
// over a dense scrim; Cancel is the low-emphasis left button, confirm is a filled
// pill (accent, or danger terracotta when `destructive`). It's an absolute-fill
// overlay, so each cell is a FIXED-SIZE relative container rendered OPEN.
//   Orchestrator: add cfg.overrides.ConfirmDialog = {"cardMode":"single","viewport":"390x420"}
import { View } from 'react-native'
import { ConfirmDialog, parchment } from 'voxi'

// The dialog reads `surface` explicitly (not from context) — pass the parchment
// tokens so its card/text/danger/accent colours match the light reveal surface.
const Stage = ({ children }: { children: React.ReactNode }) => (
  <View style={{ width: 390, height: 420, backgroundColor: '#F4F1E8' }}>{children}</View>
)

const noop = () => {}

export const DeleteFind = () => (
  <Stage>
    <ConfirmDialog
      visible
      title="Delete this find?"
      message="This removes the photo, the reveal, and any conversation for good. There's no getting it back."
      confirmLabel="Delete"
      cancelLabel="Keep it"
      destructive
      onConfirm={noop}
      onCancel={noop}
      reduceMotion
      surface={parchment as any}
      dialogTestId="cd-delete"
      cancelTestId="cd-delete-cancel"
      confirmTestId="cd-delete-confirm"
    />
  </Stage>
)

export const Regenerate = () => (
  <Stage>
    <ConfirmDialog
      visible
      title="Have another go?"
      message="The Guide will re-examine the photo and rewrite the reveal from scratch. This one's on the house."
      confirmLabel="Regenerate"
      onConfirm={noop}
      onCancel={noop}
      reduceMotion
      surface={parchment as any}
      dialogTestId="cd-regen"
      cancelTestId="cd-regen-cancel"
      confirmTestId="cd-regen-confirm"
    />
  </Stage>
)
