/** Browser entry the camera converge bundle is built from. Mounts the REAL camera screen into #root. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './camera-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
