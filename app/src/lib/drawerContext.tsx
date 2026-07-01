/**
 * Drawer control context — the lightweight seam between the camera's hamburger (`AppHeader`) and the drawer
 * host that owns the open/close animation (`components/Drawer.tsx`).
 *
 * Kept in its OWN tiny module (no clerk/api/router imports) so `AppHeader` — which IS pulled into the camera
 * converge bundle — can open the drawer WITHOUT importing `Drawer.tsx` (whose `DrawerMenu` imports clerk/api,
 * modules aliased to a throwing stub on the web target). `useDrawer()` returns a NO-OP when no provider is
 * mounted (exactly the converge case: `camera-entry.tsx` mounts the screen body without the `(tabs)` layout),
 * so the hamburger is a harmless no-op there instead of a crash.
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
