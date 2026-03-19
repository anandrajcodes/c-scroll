/**
 * ================================================================
 *  CLASSROOM PDF AUTOSCROLLER — script.js
 *
 *  Responsibilities:
 *    1. Load and render PDF pages via PDF.js
 *    2. Auto-scroll through a page range, looping back to the
 *       start page when the end page finishes.
 *    3. Start / Pause / Stop / Fullscreen controls.
 *    4. Dynamic status bar & HUD updates.
 * ================================================================
 */

// ── Configure PDF.js worker (required by the library) ──────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ================================================================
//  STATE
// ================================================================
const state = {
  pdfDoc:       null,   // loaded PDFDocumentProxy
  totalPages:   0,
  startPage:    1,
  endPage:      1,
  scrollSpeed:  80,     // pixels per second
  isRunning:    false,
  isPaused:     false,
  animFrameId:  null,   // requestAnimationFrame handle
  lastTimestamp:null,   // used to compute delta-time each frame
  pageOffsets:  [],     // top pixel offset of each rendered page in the wrapper
};

// ================================================================
//  DOM REFERENCES
// ================================================================
const dom = {
  upload:        document.getElementById('pdf-upload'),
  uploadArea:    document.getElementById('upload-area'),
  uploadText:    document.getElementById('upload-text'),
  startPageIn:   document.getElementById('start-page'),
  endPageIn:     document.getElementById('end-page'),
  pageInfo:      document.getElementById('page-info'),
  speedSlider:   document.getElementById('speed-slider'),
  speedLabel:    document.getElementById('speed-label'),
  btnStart:      document.getElementById('btn-start'),
  btnPause:      document.getElementById('btn-pause'),
  btnStop:       document.getElementById('btn-stop'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  statusDot:     document.getElementById('status-dot'),
  statusText:    document.getElementById('status-text'),
  emptyState:    document.getElementById('empty-state'),
  scrollContainer: document.getElementById('pdf-scroll-container'),
  canvasWrapper: document.getElementById('pdf-canvas-wrapper'),
  themeToggle:   document.getElementById('theme-toggle'),
  fullscreenHud: document.getElementById('fullscreen-hud'),
  hudPage:       document.getElementById('hud-page'),
  hudPause:      document.getElementById('hud-pause'),
  hudExit:       document.getElementById('hud-exit'),
};

// ================================================================
//  THEME TOGGLE (dark ↔ light)
// ================================================================
dom.themeToggle.addEventListener('click', () => {
  const html  = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  dom.themeToggle.textContent = isDark ? '🌙' : '☀';
});

// ================================================================
//  FILE UPLOAD HANDLING
// ================================================================

/** Handle file chosen via the <input> */
dom.upload.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadPDF(file);
});

/** Drag-and-drop support on the upload area */
dom.uploadArea.addEventListener('dragover', e => {
  e.preventDefault();
  dom.uploadArea.classList.add('drag-over');
});
dom.uploadArea.addEventListener('dragleave', () => {
  dom.uploadArea.classList.remove('drag-over');
});
dom.uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  dom.uploadArea.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') loadPDF(file);
});

/**
 * Reads a PDF file and renders its pages into the viewer.
 * @param {File} file - The PDF file object from the input/drop.
 */
async function loadPDF(file) {
  // Stop any running scroll first
  stopScroll();

  setStatus('loading', `Loading "${file.name}"…`);
  dom.uploadText.textContent = file.name;

  // Read file as ArrayBuffer so PDF.js can parse it
  const arrayBuffer = await file.arrayBuffer();

  try {
    // Ask PDF.js to parse the document
    state.pdfDoc   = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    state.totalPages = state.pdfDoc.numPages;

    // Default page range = all pages
    dom.startPageIn.max = state.totalPages;
    dom.endPageIn.max   = state.totalPages;
    dom.startPageIn.value = 1;
    dom.endPageIn.value   = state.totalPages;

    dom.pageInfo.textContent = `Total pages: ${state.totalPages}`;

    // Render the pages (only the selected range is displayed at runtime,
    // but we render ALL pages once so scroll positions are accurate)
    await renderPages();

    // Show the viewer and enable buttons
    dom.emptyState.style.display  = 'none';
    dom.scrollContainer.style.display = 'block';
    dom.btnStart.disabled      = false;
    dom.btnFullscreen.disabled = false;

    setStatus('ready', 'PDF loaded — ready to scroll');
  } catch (err) {
    setStatus('idle', 'Error loading PDF — try another file');
    console.error('[AutoScroller] PDF load error:', err);
  }
}

// ================================================================
//  PDF RENDERING
// ================================================================

/**
 * Renders every page of the loaded PDF into <canvas> elements
 * inside #pdf-canvas-wrapper. Clears any previous render first.
 *
 * After rendering, it records the top-offset of each page
 * (state.pageOffsets) so the scroller knows where each page starts.
 */
async function renderPages() {
  // Clear previously rendered pages
  dom.canvasWrapper.innerHTML = '';
  state.pageOffsets = [];

  const containerWidth = dom.scrollContainer.clientWidth || window.innerWidth - 280;
  const scale = Math.max(1.0, (containerWidth * 0.96) / 800); // target ~800px wide

  for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
    const page     = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    // Page label (e.g., "PAGE 3")
    const label = document.createElement('div');
    label.className   = 'page-label';
    label.textContent = `Page ${pageNum}`;
    dom.canvasWrapper.appendChild(label);

    // Create canvas for this page
    const canvas  = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.dataset.page = pageNum;
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    dom.canvasWrapper.appendChild(canvas);

    // Record the top pixel offset of this canvas so we can jump to it
    // (offsetTop is relative to the wrapper, which starts at scrollTop=0)
    state.pageOffsets[pageNum] = canvas.offsetTop;

    // Render the PDF page into the canvas context
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
    }).promise;
  }

  // After all canvases are in the DOM, recalculate offsets
  // (layout reflow may have shifted things slightly)
  recalculateOffsets();
}

/**
 * Re-reads the actual offsetTop of every page canvas.
 * Called after render and on window resize.
 */
function recalculateOffsets() {
  const canvases = dom.canvasWrapper.querySelectorAll('.pdf-page-canvas');
  canvases.forEach(canvas => {
    const pageNum = parseInt(canvas.dataset.page, 10);
    state.pageOffsets[pageNum] = canvas.offsetTop;
  });
}

// Recalculate offsets when the window is resized
window.addEventListener('resize', () => {
  if (state.pdfDoc) recalculateOffsets();
});

// ================================================================
//  SCROLL SPEED
// ================================================================
dom.speedSlider.addEventListener('input', () => {
  state.scrollSpeed = parseInt(dom.speedSlider.value, 10);
  dom.speedLabel.textContent = `${state.scrollSpeed} px/s`;
});

// ================================================================
//  CONTROLS
// ================================================================

/** START — jump to start page and begin auto-scroll */
dom.btnStart.addEventListener('click', () => {
  if (!state.pdfDoc) return;

  // Read page range from inputs (clamped to valid range)
  state.startPage = clamp(parseInt(dom.startPageIn.value, 10), 1, state.totalPages);
  state.endPage   = clamp(parseInt(dom.endPageIn.value,   10), 1, state.totalPages);

  // Ensure start ≤ end
  if (state.startPage > state.endPage) state.endPage = state.startPage;

  // Jump scroll position to the start page immediately
  jumpToPage(state.startPage);

  // Start animation loop
  state.isRunning = true;
  state.isPaused  = false;
  state.lastTimestamp = null;

  dom.btnStart.disabled  = true;
  dom.btnPause.disabled  = false;
  dom.btnStop.disabled   = false;
  dom.btnPause.textContent = '⏸ Pause';
  dom.btnPause.classList.remove('is-resumed');

  setStatus('running', `Scrolling pages ${state.startPage}–${state.endPage}`);
  scheduleFrame();
});

/** PAUSE / RESUME */
dom.btnPause.addEventListener('click', () => {
  if (!state.isRunning) return;

  state.isPaused = !state.isPaused;

  if (state.isPaused) {
    // Cancel the animation loop
    cancelAnimationFrame(state.animFrameId);
    state.lastTimestamp = null;
    dom.btnPause.innerHTML = '<span class="btn-icon">▶</span> Resume';
    dom.btnPause.classList.add('is-resumed');
    dom.hudPause.textContent = '▶';
    setStatus('paused', 'Paused');
  } else {
    // Resume
    dom.btnPause.innerHTML = '<span class="btn-icon">⏸</span> Pause';
    dom.btnPause.classList.remove('is-resumed');
    dom.hudPause.textContent = '⏸';
    setStatus('running', `Scrolling pages ${state.startPage}–${state.endPage}`);
    scheduleFrame();
  }
});

// Mirror the HUD pause button to the main pause handler
dom.hudPause.addEventListener('click', () => dom.btnPause.click());

/** STOP — halt scroll and reset to start of range */
dom.btnStop.addEventListener('click', stopScroll);

function stopScroll() {
  cancelAnimationFrame(state.animFrameId);
  state.isRunning  = false;
  state.isPaused   = false;
  state.lastTimestamp = null;

  dom.btnStart.disabled = !state.pdfDoc;  // re-enable if PDF is loaded
  dom.btnPause.disabled = true;
  dom.btnStop.disabled  = true;
  dom.btnPause.innerHTML = '<span class="btn-icon">⏸</span> Pause';
  dom.btnPause.classList.remove('is-resumed');

  // Scroll back to start page on stop
  if (state.pdfDoc) jumpToPage(state.startPage);

  setStatus('ready', state.pdfDoc ? 'Stopped — ready to restart' : 'Idle — load a PDF to begin');
}

// ================================================================
//  FULLSCREEN
// ================================================================
dom.btnFullscreen.addEventListener('click', enterFullscreen);
dom.hudExit.addEventListener('click',       exitFullscreen);

function enterFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen)       el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}
function exitFullscreen() {
  if (document.exitFullscreen)          document.exitFullscreen();
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
}

// Show/hide the HUD based on fullscreen state
document.addEventListener('fullscreenchange',       onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
function onFullscreenChange() {
  const isFS = !!document.fullscreenElement || !!document.webkitFullscreenElement;
  dom.fullscreenHud.hidden = !isFS || !state.isRunning;
  if (isFS) recalculateOffsets();
}

// ================================================================
//  AUTO-SCROLL ANIMATION LOOP
// ================================================================

/**
 * Schedules the next animation frame.
 */
function scheduleFrame() {
  state.animFrameId = requestAnimationFrame(scrollFrame);
}

/**
 * Called every animation frame while scrolling is active.
 * Moves scrollTop by (speed × deltaTime) pixels, then
 * checks whether we've passed the end page — if so, loop back.
 *
 * @param {DOMHighResTimeStamp} timestamp - provided by rAF
 */
function scrollFrame(timestamp) {
  if (!state.isRunning || state.isPaused) return;

  // Compute how many seconds elapsed since last frame
  if (state.lastTimestamp === null) state.lastTimestamp = timestamp;
  const delta = (timestamp - state.lastTimestamp) / 1000; // → seconds
  state.lastTimestamp = timestamp;

  // Move the scroll container down by speed × delta pixels
  const container = dom.scrollContainer;
  container.scrollTop += state.scrollSpeed * delta;

  // ── Loop detection ───────────────────────────────────────────
  // Find the top pixel offset where the end page starts,
  // plus the height of the end page canvas itself.
  const endPageCanvas = dom.canvasWrapper.querySelector(
    `.pdf-page-canvas[data-page="${state.endPage}"]`
  );

  if (endPageCanvas) {
    // The "done" threshold is when the bottom of the end page
    // has scrolled past the top of the viewport
    const endPageBottom = state.pageOffsets[state.endPage] + endPageCanvas.offsetHeight;

    if (container.scrollTop >= endPageBottom) {
      // Loop: jump back to the start page
      jumpToPage(state.startPage);
      updateHUD(state.startPage);
      scheduleFrame();
      return;
    }
  }

  // ── Update HUD page indicator ────────────────────────────────
  updateHUD(currentVisiblePage());

  // Schedule the next frame
  scheduleFrame();
}

/**
 * Instantly sets scrollTop so that the given page is at the top
 * of the visible viewport.
 * @param {number} pageNum
 */
function jumpToPage(pageNum) {
  const offset = state.pageOffsets[pageNum];
  if (offset !== undefined) {
    dom.scrollContainer.scrollTop = offset;
  }
}

/**
 * Returns the page number that is currently most visible
 * (the page whose top edge is nearest to the current scrollTop).
 */
function currentVisiblePage() {
  const scrollTop = dom.scrollContainer.scrollTop;
  let closest = state.startPage;
  let minDiff  = Infinity;

  for (let p = state.startPage; p <= state.endPage; p++) {
    const offset = state.pageOffsets[p];
    if (offset === undefined) continue;
    const diff = Math.abs(offset - scrollTop);
    if (diff < minDiff) { minDiff = diff; closest = p; }
  }
  return closest;
}

/**
 * Updates the fullscreen HUD with the current page.
 * @param {number} page
 */
function updateHUD(page) {
  dom.hudPage.textContent = `Page ${page} / ${state.endPage}`;
}

// ================================================================
//  STATUS BAR HELPER
// ================================================================

/**
 * Updates the sidebar status indicator.
 * @param {'idle'|'loading'|'ready'|'running'|'paused'|'stopped'} type
 * @param {string} message
 */
function setStatus(type, message) {
  // Map type → CSS class
  const classMap = {
    idle:    'dot-idle',
    loading: 'dot-ready',
    ready:   'dot-ready',
    running: 'dot-running',
    paused:  'dot-paused',
    stopped: 'dot-stopped',
  };
  dom.statusDot.className = `dot ${classMap[type] || 'dot-idle'}`;
  dom.statusText.textContent = message;
}

// ================================================================
//  UTILITY
// ================================================================

/** Clamps a number between min and max. */
function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

// ── Synchronise speed label on page load ──
dom.speedLabel.textContent = `${dom.speedSlider.value} px/s`;
state.scrollSpeed = parseInt(dom.speedSlider.value, 10);
