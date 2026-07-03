// Preview for BucketDock — the reveal research-bucket icon dock: a flush row of
// equal slots (What · Purpose · Maker, then Explore + Ask). Each research glyph
// carries a state (loading spinner ring / active full-ink / empty "?" badge /
// unavailable retry); an active-unread bucket shows a dot; Ask is the blue
// people-lane icon. Renders over a dark photo surface. Takes surface + reduceMotion
// as PROPS (not context). Full-width row → the cell wraps it in a dark strip.
import { View } from 'react-native'
import { BucketDock, dark } from 'voxi'

const Strip = ({ children }: { children: React.ReactNode }) => (
  <View style={{ backgroundColor: '#17181A', paddingVertical: 28, paddingHorizontal: 12 }}>{children}</View>
)

// All buckets answered, none opened yet (unread dots), and a durable Deep Dive
// episode already exists (green "ready" dot on Explore).
export const AllReady = () => (
  <Strip>
    <BucketDock
      statuses={{ what: 'active', purpose: 'active', maker: 'active', facts: 'active' } as any}
      read={{ what: false, purpose: false, maker: false, facts: false } as any}
      deepDiveState="ready"
      reduceMotion
      surface={dark as any}
      onOpen={() => {}}
    />
  </Strip>
)

// Mid-research: What is still loading (a static faint accent ring under reduce-motion);
// Purpose read (no dot), Maker empty ("?"), Deep Dive generating (spinner cue).
export const Researching = () => (
  <Strip>
    <BucketDock
      statuses={{ what: 'loading', purpose: 'active', maker: 'empty', facts: 'loading' } as any}
      read={{ what: false, purpose: true, maker: false, facts: false } as any}
      deepDiveState="generating"
      reduceMotion
      surface={dark as any}
      onOpen={() => {}}
    />
  </Strip>
)

// A bucket the Guide couldn't reach (unavailable → retry badge), the rest answered.
export const Unavailable = () => (
  <Strip>
    <BucketDock
      statuses={{ what: 'active', purpose: 'unavailable', maker: 'active', facts: 'active' } as any}
      read={{ what: true, purpose: false, maker: false, facts: false } as any}
      deepDiveState="active"
      reduceMotion
      surface={dark as any}
      onOpen={() => {}}
    />
  </Strip>
)
