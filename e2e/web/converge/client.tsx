/**
 * Browser entry the converge bundle is built from. Mounts the REAL reveal screen (via entry.tsx's ConvergeRoot)
 * into #root with react-dom/client. Kept tiny on purpose — all real app code lives in entry.tsx's tree.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './entry'

const root = createRoot(document.getElementById('root')!)
root.render(React.createElement(ConvergeRoot))
