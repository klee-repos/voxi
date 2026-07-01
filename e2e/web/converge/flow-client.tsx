/** Browser entry for the flow converge bundle — mounts the REAL multi-screen flow into #root. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './flow-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
