let pdfjsPromise

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/pdf.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs'
      return pdfjs
    })
  }
  return pdfjsPromise
}

export function mountPdfPreview(container, blob) {
  container.innerHTML = `<section class="pdf-viewer" aria-label="Предпросмотр PDF"><div class="pdf-toolbar"><button type="button" data-pdf-prev aria-label="Предыдущая страница">‹</button><span data-pdf-page role="status" aria-live="polite">Загрузка PDF…</span><button type="button" data-pdf-next aria-label="Следующая страница">›</button></div><div class="pdf-canvas-wrap"><canvas data-pdf-canvas aria-label="Страница PDF"></canvas></div><p class="pdf-fallback">Если PDF не отображается, скачай файл.</p></section>`
  const canvas = container.querySelector('[data-pdf-canvas]')
  const pageLabel = container.querySelector('[data-pdf-page]')
  const previous = container.querySelector('[data-pdf-prev]')
  const next = container.querySelector('[data-pdf-next]')
  let disposed = false
  let loadingTask = null
  let renderTask = null
  let document = null
  let currentPage = 1
  let rendering = false
  let passwordRequested = false
  let annotationMode

  function setError(message) {
    if (disposed) return
    pageLabel.textContent = message
    canvas.hidden = true
    previous.disabled = true
    next.disabled = true
  }

  async function renderPage(pageNumber) {
    if (disposed || !document || rendering) return
    rendering = true
    previous.disabled = true
    next.disabled = true
    pageLabel.textContent = `Страница ${pageNumber} из ${document.numPages} · загрузка…`
    try {
      const page = await document.getPage(pageNumber)
      if (disposed) return
      const base = page.getViewport({ scale: 1 })
      if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error('Invalid page size')
      const availableWidth = Math.max(240, container.clientWidth - 4)
      const displayScale = Math.min(2, availableWidth / base.width)
      let pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const maxPixels = 12_000_000
      const displayPixels = base.width * displayScale * base.height * displayScale
      if (displayPixels * pixelRatio * pixelRatio > maxPixels) pixelRatio = Math.sqrt(maxPixels / displayPixels)
      const viewport = page.getViewport({ scale: displayScale * pixelRatio })
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      canvas.style.width = `${Math.floor(base.width * displayScale)}px`
      canvas.style.height = `${Math.floor(base.height * displayScale)}px`
      canvas.hidden = false
      renderTask = page.render({ canvas, viewport, annotationMode })
      await renderTask.promise
      if (disposed) return
      currentPage = pageNumber
      pageLabel.textContent = `Страница ${currentPage} из ${document.numPages}`
    } catch (error) {
      if (!disposed && error?.name !== 'RenderingCancelledException') setError('Не удалось отобразить PDF')
    } finally {
      renderTask = null
      rendering = false
      if (!disposed && document && !canvas.hidden) {
        previous.disabled = currentPage <= 1
        next.disabled = currentPage >= document.numPages
      }
    }
  }

  previous.addEventListener('click', () => renderPage(currentPage - 1))
  next.addEventListener('click', () => renderPage(currentPage + 1))

  ;(async () => {
    try {
      const pdfjs = await loadPdfJs()
      annotationMode = pdfjs.AnnotationMode.DISABLE
      const data = new Uint8Array(await blob.arrayBuffer())
      if (disposed) return
      loadingTask = pdfjs.getDocument({
        data,
        isEvalSupported: false,
        cMapUrl: '/vendor/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
        wasmUrl: '/vendor/pdfjs/wasm/',
      })
      loadingTask.onPassword = () => {
        passwordRequested = true
        setError('PDF защищён паролем')
        loadingTask.destroy()
      }
      document = await loadingTask.promise
      if (disposed) return
      await renderPage(1)
    } catch (error) {
      const passwordProtected = passwordRequested || error?.name === 'PasswordException'
      setError(passwordProtected ? 'PDF защищён паролем' : 'Не удалось открыть PDF')
    }
  })()

  return {
    destroy() {
      disposed = true
      renderTask?.cancel()
      loadingTask?.destroy()
      renderTask = null
      loadingTask = null
      document = null
    },
  }
}
