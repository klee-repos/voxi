/** Browser entry the header converge bundle is built from. Mounts the real AppHeader proof into #root. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './header-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
