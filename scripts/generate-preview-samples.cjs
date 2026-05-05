// Standalone sample-renderer for the new template-based preview pipeline.
//
// Run with:
//   node_modules/.bin/electron scripts/generate-preview-samples.cjs
//
// Loads each template into an offscreen BrowserWindow, populates slots via
// window.applyPreview(...), waits for the preview-ready event, captures the
// page to PNG. No production code paths are touched — this is just so we can
// eyeball the templates before wiring them into the agent tool.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const url = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'assets', 'preview-templates');
const OUT_DIR = path.join(ROOT, 'out', 'preview-samples');
const SPRITE_PATH = path.join(ROOT, 'assets', 'icon.png');
// Use a data: URL rather than file://. Chromium's image-loading path for
// file:// goes through the network stack and the timing of when pixels
// land on the GPU is intermittent — even after img.decode() resolves and
// rAF cycles run, capturePage occasionally captures the image slot empty.
// A data: URL skips the fetch entirely.
const SPRITE_URL =
  'data:image/png;base64,' +
  require('node:fs').readFileSync(SPRITE_PATH).toString('base64');

const W = 1280;
const H = 720;

const SAMPLES = [
  // ---- classic ----
  {
    template: 'classic',
    title: 'Boom',
    subtitle: 'A Mod by Lebek',
    background: 'radial-gradient(circle at 30% 20%, #ff7a1a 0%, #7a1f00 55%, #0d0d10 100%)',
    titleColor: '#fff8e0',
    titleFont: 'rimworld',
    titleEffect: 'outline',
    accentColor: '#ff7a1a',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'classic',
    title: 'Vanilla Expanded: Robotics',
    subtitle: 'Compatible with 1.5',
    background: 'linear-gradient(160deg,#1d2a4a 0%,#0a0f1f 100%)',
    titleColor: '#e8f1ff',
    titleEffect: 'shadow',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'classic',
    title: 'Comprehensive Caravan Combat Realism Overhaul',
    background: 'linear-gradient(180deg,#2a1a0a 0%,#0d0805 100%)',
    titleColor: '#ffd6a0',
    titleFont: 'rimworld',
    titleEffect: 'outline',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'classic',
    title: 'Tribal Times',
    subtitle: 'Iron-age tech tweaks',
    background: 'linear-gradient(180deg,#3d2615 0%,#1a0e07 100%)',
    titleColor: '#fff2c2',
    titleFont: 'rimworld',
    titleEffect: 'glow',
    accentColor: '#e06a1f',
    spriteUrl: SPRITE_URL,
  },

  // ---- icon-left ----
  {
    template: 'icon-left',
    title: 'Megafauna',
    subtitle: 'New wildlife · 32 species',
    background: 'linear-gradient(135deg,#1f3a2a 0%,#0a1810 100%)',
    titleColor: '#d8f5d2',
    titleEffect: 'shadow',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'icon-left',
    title: 'Hospitality: Storyteller Tweaks',
    subtitle: 'Guests behave better',
    background: 'linear-gradient(135deg,#2a2236 0%,#0e0a16 100%)',
    titleColor: '#f1e6ff',
    titleEffect: 'shadow',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'icon-left',
    title: 'Quartermaster Logistics & Supply Chain Rework',
    background: 'linear-gradient(135deg,#3a2a14 0%,#15100a 100%)',
    titleColor: '#ffe2a6',
    titleFont: 'rimworld',
    titleEffect: 'outline',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'icon-left',
    title: 'Ace',
    subtitle: 'Tiny but mighty',
    background: 'linear-gradient(135deg,#142a3a 0%,#08111c 100%)',
    titleColor: '#cfeaff',
    titleEffect: 'glow',
    accentColor: '#3aa3ff',
    spriteUrl: SPRITE_URL,
  },

  // ---- banner ----
  {
    template: 'banner',
    title: 'Frontier',
    subtitle: 'A Western-themed total conversion',
    background: 'linear-gradient(160deg,#a05a1f 0%,#3a1d10 60%,#0d0805 100%)',
    titleColor: '#fff2c2',
    titleFont: 'rimworld',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'banner',
    title: 'Deep Space Salvage',
    subtitle: 'Crashed ship events · Salvageable hulls',
    background: 'linear-gradient(160deg,#0c1a3a 0%,#04081a 100%)',
    titleColor: '#dde7ff',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'banner',
    title: 'The Definitive Roleplay & Storyteller Companion',
    subtitle: '40+ events · 12 storytellers',
    background: 'linear-gradient(160deg,#2a103a 0%,#0a0418 100%)',
    titleColor: '#f4e3ff',
    spriteUrl: SPRITE_URL,
  },
  {
    template: 'banner',
    title: 'Ironpunk',
    background: 'linear-gradient(160deg,#3a2a14 0%,#100a05 100%)',
    titleColor: '#ffd07a',
    titleFont: 'rimworld',
    titleEffect: 'outline',
    spriteUrl: SPRITE_URL,
  },
];

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function renderOne(sample, index) {
  // The window is shown on-screen at (0,0). Hidden windows
  // (show:false + paintWhenInitiallyHidden) and far-offscreen positions
  // (-10000,-10000) both cause Chromium to skip raster work — text or
  // sprites end up missing in capturePage even when the DOM is correct.
  // A brief on-screen flash is the most reliable option for a one-shot
  // sample-generation script.
  const win = new BrowserWindow({
    width: W,
    height: H,
    x: 0,
    y: 0,
    show: true,
    frame: false,
    skipTaskbar: true,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: {
      offscreen: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const tplPath = path.join(TEMPLATES_DIR, `${sample.template}.html`);
  await win.loadFile(tplPath);
  // Force the device pixel ratio to 1 so the PNG comes out at exactly W×H.
  win.webContents.setZoomFactor(1);

  await win.webContents.executeJavaScript(
    `window.applyPreview(${JSON.stringify(sample)}).then(() => {
       return new Promise((r) => {
         if (window.__PREVIEW_READY) r();
         else window.addEventListener('preview-ready', () => r(), { once: true });
       });
     })`,
    true,
  );

  // capturePage occasionally races the compositor on Windows and returns
  // an empty (all-zero) framebuffer even though the DOM is ready. Retry a
  // few times after a short settle delay; if every byte of every channel
  // is zero we know the capture missed and try again.
  let png;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 150 + attempt * 100));
    const img = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: W,
      height: H,
    });
    const buf = img.toBitmap();
    let nonZero = false;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] || buf[i + 1] || buf[i + 2]) {
        nonZero = true;
        break;
      }
    }
    if (nonZero) {
      png = img.toPNG();
      break;
    }
    console.log(`  attempt ${attempt + 1}: blank framebuffer, retrying`);
  }
  if (!png) throw new Error('capturePage returned blank after retries');

  const fname = `${String(index).padStart(2, '0')}-${sample.template}-${slug(sample.title)}.png`;
  const outPath = path.join(OUT_DIR, fname);
  await fs.writeFile(outPath, png);
  console.log(`wrote ${fname} (${png.length} bytes)`);

  win.destroy();
}

app.commandLine.appendSwitch('disable-gpu-vsync');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  try {
    for (let i = 0; i < SAMPLES.length; i++) {
      await renderOne(SAMPLES[i], i + 1);
    }
  } catch (err) {
    console.error('Sample generation failed:', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Don't auto-quit; we drive lifecycle from the loop above.
});
