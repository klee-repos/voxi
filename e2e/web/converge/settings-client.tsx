/** Browser entry the settings converge bundle is built from. Mounts the REAL Settings screen into #root. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './settings-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
