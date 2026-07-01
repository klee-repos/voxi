/** Browser entry the drawer converge bundle is built from. Mounts the REAL DrawerHost + camera into #root. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './drawer-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
