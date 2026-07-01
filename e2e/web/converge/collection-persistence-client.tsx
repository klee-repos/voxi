/** Browser entry the collection-persistence converge bundle is built from. Mounts the REAL threads screen
 *  (after a real photo capture) into #root — see collection-persistence-entry.tsx. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './collection-persistence-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
