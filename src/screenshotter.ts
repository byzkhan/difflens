import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ScreenshotOptions, Viewport } from './types.js';
import { DiffLensError } from './types.js';

const log = (msg: string) => process.stderr.write(`[difflens] ${msg}\n`);

let browserInstance: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

const ANTI_ANIMATION_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`;

async function ensureBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) return browserInstance;

  // Guard against duplicate launches from concurrent calls
  if (launchPromise) return launchPromise;

  launchPromise = chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--hide-scrollbars', '--no-sandbox'],
  });

  try {
    browserInstance = await launchPromise;
    log('Browser launched');

    browserInstance.on('disconnected', () => {
      browserInstance = null;
      launchPromise = null;
      log('Browser disconnected');
    });

    return browserInstance;
  } catch (err) {
    launchPromise = null;
    throw new DiffLensError('BROWSER_ERROR', `Failed to launch browser: ${err}`);
  }
}

async function createContext(viewport: Viewport): Promise<BrowserContext> {
  const browser = await ensureBrowser();
  return browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
}

async function navigateAndPrepare(
  page: Page,
  url: string,
  options: Pick<ScreenshotOptions, 'waitForSelector' | 'waitForTimeout'>
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('ERR_CONNECTION_REFUSED')) {
      throw new DiffLensError(
        'CONNECTION_REFUSED',
        `Cannot connect to ${url}. Is the dev server running?`
      );
    }
    if (message.includes('Timeout') || message.includes('timeout')) {
      throw new DiffLensError('TIMEOUT', `Page load timed out after 30s for ${url}`);
    }
    throw new DiffLensError('BROWSER_ERROR', `Navigation failed: ${message}`);
  }

  if (options.waitForSelector) {
    try {
      await page.waitForSelector(options.waitForSelector, { timeout: 10_000 });
    } catch {
      throw new DiffLensError(
        'SELECTOR_NOT_FOUND',
        `Selector "${options.waitForSelector}" not found within 10s`
      );
    }
  }

  if (options.waitForTimeout) {
    await page.waitForTimeout(options.waitForTimeout);
  }
}

export async function takeScreenshot(options: ScreenshotOptions): Promise<Buffer> {
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const fullPage = options.fullPage ?? true;

  log(`Screenshot: ${options.url} @ ${viewport.width}x${viewport.height}`);

  const context = await createContext(viewport);
  try {
    const page = await context.newPage();

    // Inject anti-animation CSS before any page JS runs
    await page.addInitScript(`{
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(ANTI_ANIMATION_CSS)};
      if (document.head) {
        document.head.appendChild(style);
      } else {
        document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
      }
    }`);

    await navigateAndPrepare(page, options.url, options);

    const buffer = await page.screenshot({
      fullPage,
      type: 'png',
      animations: 'disabled',
    });

    return Buffer.from(buffer);
  } finally {
    await context.close();
  }
}

export async function takeElementScreenshot(
  url: string,
  selector: string,
  viewport?: Viewport,
  waitForSelector?: string,
  waitForTimeout?: number
): Promise<Buffer> {
  const vp = viewport ?? { width: 1280, height: 720 };

  log(`Element screenshot: ${selector} @ ${url}`);

  const context = await createContext(vp);
  try {
    const page = await context.newPage();

    await page.addInitScript(`{
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(ANTI_ANIMATION_CSS)};
      if (document.head) {
        document.head.appendChild(style);
      } else {
        document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
      }
    }`);

    await navigateAndPrepare(page, url, { waitForSelector, waitForTimeout });

    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 0) {
      throw new DiffLensError(
        'SELECTOR_NOT_FOUND',
        `Element "${selector}" not found on page`
      );
    }

    const buffer = await locator.first().screenshot({ type: 'png', animations: 'disabled' });
    return Buffer.from(buffer);
  } finally {
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance?.isConnected()) {
    await browserInstance.close();
    log('Browser closed');
  }
  browserInstance = null;
  launchPromise = null;
}
