/** Browser entry for the shared full-app converge bundle — mounts the REAL welcome→…→reveal journey into #root. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './app-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
