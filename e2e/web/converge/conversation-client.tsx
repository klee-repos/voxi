/** Browser entry the conversation converge bundle is built from. Mounts the REAL conversation screen into #root. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './conversation-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
