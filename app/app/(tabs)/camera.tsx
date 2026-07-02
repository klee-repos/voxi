/**
 * The camera tab renders the ONE Home surface (LOADING-EXPERIENCE-PLAN — camera-as-a-page merge): a fixed live
 * viewfinder with a single horizontal pager `[viewfinder, …catalogued items]` over it. Sliding viewfinder⇄item is
 * pure scrolling — no navigation, no screen swap — so there is nothing to fade or remount. The whole Home lives in
 * `app/app/reveal.tsx` (shared with the `/reveal` route for collection revisits / deep-links); this route just
 * mounts it, starting on the viewfinder (no current item in the store).
 */
export { default } from '../reveal'
