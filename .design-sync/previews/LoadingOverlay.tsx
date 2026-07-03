// Preview for LoadingOverlay — the ONE dark-overlay loading layer over a persistent
// full-bleed photo: a flat scrim + green identity scan-line sweep + the shared
// LoadingPill (+ fail/retry). Absolute-fill, so give it a FIXED-SIZE relative frame
// with a faux photo behind it. Takes an explicit `run`/`kind`/colour props; the
// inner LoadingPill reads useTheme() → wrap in SurfaceProvider surface="dark".
// reduceMotion pins a stable frame (no animated scan translate).
import { View, Image } from 'react-native'
import { LoadingOverlay, SurfaceProvider } from 'voxi'

// A faux warm photo behind the scrim (no network in the bundle sandbox).
const PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9a7d54"/><stop offset="1" stop-color="#221a10"/></linearGradient></defs><rect width="390" height="480" fill="url(#g)"/></svg>`,
  )

const scanningRun = {
  phase: 'streaming',
  settled: null,
  line: 'Working out what this is…',
  longWait: true,
  offline: false,
  failed: null,
  orb: 'thinking',
  scanning: true,
  statusText: 'Working out what this is…',
  ack: 'Cross-checking the catalogue — a moment.',
  retry: () => {},
} as any

const failedRun = {
  ...scanningRun,
  phase: 'failed',
  failed: 'stream_failed',
  orb: 'uncertain',
  scanning: false,
  statusText: 'That didn’t take. Try again?',
  ack: undefined,
} as any

const Stage = ({ run }: { run: any }) => (
  <View style={{ width: 390, height: 480, backgroundColor: '#221a10' }}>
    {/* the persistent full-bleed photo the overlay sits above */}
    <Image source={{ uri: PHOTO }} style={{ position: 'absolute', top: 0, left: 0, width: 390, height: 480 }} />

    <SurfaceProvider surface="dark">
      <LoadingOverlay
        run={run}
        kind="analyze"
        isRevisit={false}
        reduceMotion
        onImage
        winH={480}
        bottomInset={0}
        scrimColor="rgba(0,0,0,0.42)"
        accentColor="#3DDC84"
      />
    </SurfaceProvider>
  </View>
)

export const Scanning = () => <Stage run={scanningRun} />
export const Failed = () => <Stage run={failedRun} />
