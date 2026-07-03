/**
 * Browser entry the Deep Dive converge bundle is built from — mounts the REAL Deep Dive player (via
 * deepdive-entry.tsx's ConvergeRoot) into #root. Kept tiny; all real app code lives in the entry's tree.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './deepdive-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
