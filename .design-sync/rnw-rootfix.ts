// react-native-web injects a <style id="react-native-stylesheet"> into <head>.
// Its id starts with "r", so it collides with the design-sync render-check's
// root selector — `querySelectorAll('#root, [id^="r"]')` — where, first in
// document order, the empty stylesheet element becomes roots[0] and the check
// falsely reports `rootEmpty` for EVERY preview that mounts an RNW component.
// (The components render fine; only the mechanical gate misreads them.)
//
// Fix: rename the element so its id no longer starts with "r", leaving only the
// real cell roots (#r0…#rN) matching the selector. RNW caches the CSSOM sheet
// reference at creation (createCSSStyleSheet returns element.sheet and never
// re-getElementById), so renaming the element's id never detaches its rules.
// An observer catches the copy a second bundled RNW instance (the preview's own
// react-native import) may create later. Imported before any RNW so it's armed
// in time. No-op outside a DOM (the importable bundle in a non-DOM context).
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  const rename = (): void => {
    for (const el of document.querySelectorAll('style[id="react-native-stylesheet"]')) {
      ;(el as HTMLElement).id = 'ds-rnw-stylesheet'
    }
  }
  rename()
  new MutationObserver(rename).observe(document.documentElement, { childList: true, subtree: true })
}
export {}
