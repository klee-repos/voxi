/** Browser entry the recently-catalogued converge bundle is built from. Mounts the REAL camera screen (after a
 *  real photo capture, so the RecentCard has a durable recent item) into #root — see recent-catalogued-entry.tsx. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConvergeRoot } from './recent-catalogued-entry'

createRoot(document.getElementById('root')!).render(React.createElement(ConvergeRoot))
