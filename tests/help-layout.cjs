async function helpOcclusion(frame, selector) {
  return frame.locator('body').evaluate(async (_body, selector) => {
    const help = document.querySelector('#context-help-open');
    const switcher = document.querySelector('#suite-shell');
    const header = document.querySelector('.app-header');
    const targets = [...document.querySelectorAll(selector)];
    if (!help || !help.getClientRects().length) return { kind: 'missing-help' };
    if (!targets.length) return { kind: 'missing-targets', selector };
    const max = document.scrollingElement.scrollHeight - innerHeight;
    const positions = [...new Set([0, ...Array.from({ length: Math.ceil(max / 24) }, (_, i) => Math.min(max, (i + 1) * 24)), max])];
    for (const y of positions) {
      scrollTo(0, y);
      await new Promise(requestAnimationFrame);
      const h = help.getBoundingClientRect();
      for (const element of targets) {
        const r = element.getBoundingClientRect();
        if (r.width && r.height && r.left < h.right && r.right > h.left && r.top < h.bottom && r.bottom > h.top) {
          return { scrollY, target: element.id || element.outerHTML.slice(0, 180),
            help: h.toJSON(), content: r.toJSON() };
        }
        if (!switcher || !r.width || !r.height) continue;
        const clippedTop = header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().bottom : 0;
        const top = Math.max(0, clippedTop, r.top), bottom = Math.min(innerHeight, r.bottom);
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        if (top >= bottom || left >= right) continue;
        for (const x of [left + 0.5, (left + right) / 2, right - 0.5]) {
          for (const y of [top + 0.5, (top + bottom) / 2, bottom - 0.5]) {
            if (switcher.contains(document.elementFromPoint(x, y))) return { kind: 'closed-switcher', scrollY,
              target: element.id || element.outerHTML.slice(0, 180), point: { x, y } };
          }
        }
      }
    }
    return null;
  }, selector);
}
module.exports = { helpOcclusion };
