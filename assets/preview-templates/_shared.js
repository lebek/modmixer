// Force the browser to load every bundled font *now* so `document.fonts.ready`
// will block on all of them, not just the ones currently referenced. Without
// this warm-up, fitText measures with a fallback font (narrower glyphs),
// then the real font swaps in at render time and the title overflows the box.
(function warmFonts() {
  const warm = document.createElement('div');
  warm.style.cssText =
    'position:absolute;visibility:hidden;left:-9999px;top:-9999px;pointer-events:none;font-size:12px;line-height:1';
  warm.innerHTML =
    '<span style="font-family:Inter;font-weight:400">.</span>' +
    '<span style="font-family:Inter;font-weight:700">.</span>' +
    '<span style="font-family:RimWorld;font-weight:400">.</span>';
  (document.body || document.documentElement).appendChild(warm);
})();

// Binary-search font-size auto-fit. Resizes `el` until it fits inside `box`
// in both axes. Same approach as fitty / auto-text-size, kept inline so the
// templates have no external deps.
window.fitText = function fitText(el, box, opts) {
  opts = opts || {};
  const min = opts.min ?? 24;
  const max = opts.max ?? 240;
  const boxW = box.clientWidth;
  const boxH = box.clientHeight;
  el.style.whiteSpace = 'normal';
  let lo = min, hi = max;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    el.style.fontSize = mid + 'px';
    const fits = el.scrollWidth <= boxW && el.scrollHeight <= boxH;
    if (fits) lo = mid; else hi = mid - 1;
  }
  el.style.fontSize = lo + 'px';
  return lo;
};

window.applyPreview = async function applyPreview(params) {
  await document.fonts.ready;
  if (typeof window.__renderPreview !== 'function') {
    throw new Error('template did not register __renderPreview');
  }
  window.__renderPreview(params);
  // Wait for every <img> with a src to actually decode. img.complete goes
  // true once bytes are downloaded, but Chromium hasn't necessarily pushed
  // pixels to the compositor — capturePage then captures the slot empty.
  // decode() resolves only after the image is in a paintable state.
  const imgs = Array.from(document.querySelectorAll('img'));
  await Promise.all(
    imgs.map((img) => {
      if (!img.src) return null;
      return img.decode().catch(() => null);
    }),
  );
  // Force a synchronous layout read so any pending style/layout work flushes
  // before we start counting frames. Without this the first rAF can land
  // before the sprite has been laid out.
  void document.body.offsetHeight;
  // Wait a handful of compositor frames + a tail sleep. img.decode() resolves
  // when the image is ready to render but Chromium still needs frames to
  // upload it to the GPU and composite it; capturePage reads from the GPU
  // framebuffer so we need to be past that point.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  await new Promise((r) => setTimeout(r, 50));
  window.__PREVIEW_READY = true;
  window.dispatchEvent(new Event('preview-ready'));
};
