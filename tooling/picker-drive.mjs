// How the browser drives choose an asset in the shared chooser (asset-picker.js): page-context
// expressions to evaluate. pickExpr opens the chooser on #id, searches for `want` (an asset id or
// a ticker) and clicks its row: true when chosen, false when the chooser has no such row (the
// chooser is closed again). rowsExpr opens it, answers the rows' asset ids as shown with no
// search, and closes it.
export function pickExpr (id, want) {
  return `(async () => {
    const b = document.getElementById(${JSON.stringify(id)}); if (!b) throw new Error('no #${id}')
    b.click(); await new Promise((r) => setTimeout(r, 150))
    const inp = document.querySelector('.swpop-search input'); if (!inp) return false
    inp.value = ${JSON.stringify(want)}; inp.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 100))
    const row = [...document.querySelectorAll('.swpop .swopt')].find((o) => o.dataset.hex === ${JSON.stringify(want)} || ((o.querySelector('.swopt-tk') || {}).firstChild || {}).textContent === ${JSON.stringify(want)})
    if (!row) { inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return false }
    row.click(); return true
  })()`
}
export function rowsExpr (id) {
  return `(async () => {
    const b = document.getElementById(${JSON.stringify(id)}); if (!b) throw new Error('no #${id}')
    b.click(); await new Promise((r) => setTimeout(r, 150))
    const rows = [...document.querySelectorAll('.swpop .swopt')].map((o) => o.dataset.hex)
    const inp = document.querySelector('.swpop-search input'); if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    return rows
  })()`
}
