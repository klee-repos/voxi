/** Browser entry the threads converge bundle is built from. Mounts the REAL threads screen into #root. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './threads-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
