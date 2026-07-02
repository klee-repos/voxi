/**
 * Drawer control context — the seam between the camera's hamburger (`AppHeader`) and the drawer host
 * (`components/Drawer.tsx`).
 *
 * Kept in its OWN module (no clerk/api/router imports) so `AppHeader`, which is pulled into the camera converge
 * bundle, can open the drawer WITHOUT importing `Drawer.tsx` (whose `DrawerMenu` imports clerk/api, aliased to a
 * throwing stub on web). `useDrawer()` returns a NO-OP with no provider mounted (the converge case), so the
 * hamburger is a harmless no-op there instead of a crash.
 */
import { createContext, useContext } from 'react'

export interface DrawerControls {
  open: () => void
  close: () => void
  isOpen: boolean
}

const NOOP: DrawerControls = { open: () => {}, close: () => {}, isOpen: false }

export const DrawerCtx = createContext<DrawerControls | null>(null)

export function useDrawer(): DrawerControls {
  return useContext(DrawerCtx) ?? NOOP
}
