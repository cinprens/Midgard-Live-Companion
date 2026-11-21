import { _electron as electron } from 'playwright';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { assistanceReplay, baselinePackets, status } from './assistance-fixtures.mjs';
import { wait } from './qa-wait.mjs';

// All replay files and the profile below are generated for QA. No player profile is read.
const output = path.resolve('.qa', `design-ui-${Date.now()}`);
const sources = path.join(output, 'sources');
const profile = path.join(output, 'profile');
await mkdir(sources, { recursive: true });
await mkdir(profile, { recursive: true });

const names = ['QA Sentetik Çağrı', 'QA Sentetik İpek', 'QA Sentetik Özgür'];
const files = names.map((_, index) => path.join(sources, `SYNTHETIC-design-${index + 1}.rrf`));
for (let index = 0; index < files.length; index++) {
  await writeFile(files[index], assistanceReplay({
    character: names[index], player: 42 + index, jobClassId: [1, 8, 3][index],
    baseLevel: 53 + index, jobLevel: 20 + index,
    packets: [...baselinePackets(), status(11, 53 + index), status(55, 20 + index)],
  }));
}
await writeFile(path.join(profile, 'live-preferences.json'), JSON.stringify({
  version: 1, sources: [], manualBindings: [], soundPaths: {},
  alerts: {
    enabled: { death: true, weight: true, card: true, city: true, level: true, monster: true },
    weightThreshold: 65, selectedCardIds: [4317], selectedMonsterIds: [1313],
    cityMaps: ['prontera'], volume: 40, muted: true,
  },
}));

const env = { ...process.env, MIDGARD_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIDGARD_DEV_URL;
const checks = [], failures = [], errors = [], screenshots = [], imageEvidence = [];
let app, page;
const check = (value, message, evidence) => {
  (value ? checks : failures).push(evidence === undefined ? message : { message, evidence });
};
const stateOf = () => page.evaluate(() => window.midgard.getState());
const routes = [
  { id: 'live', button: /^Canlı takip/, selector: '.live-workspace' },
  { id: 'finance', button: /^Finans$/, selector: '.finance-workspace' },
  { id: 'kill-count', button: /^Kill Count$/, selector: '.kill-count-panel' },
  { id: 'settings', button: /^Bildirim ayarları$/, selector: '.assistant-settings' },
];

async function launch() {
  app = await electron.launch({
    ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]), args: [] } : { args: ['.'] }),
    env, timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.midgard);
  await page.waitForSelector('.assistant-shell');
}

async function theme(value) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const control = page.getByRole('button', { name: value === 'dark' ? 'Siyah tema' : 'Açık tema', exact: true });
  await control.click();
  await page.waitForFunction(expected => (document.querySelector('.assistant-shell')?.getAttribute('data-theme') === 'dark') === (expected === 'dark'), value);
  check(await control.getAttribute('aria-pressed') === 'true', `${value}: theme control exposes the selected state`);
}

async function go(route) {
  await page.getByRole('navigation', { name: 'Ana gezinme' }).getByRole('button', { name: route.button }).click();
  await page.locator(route.selector).waitFor({ state: 'visible' });
  const current = await page.getByRole('navigation', { name: 'Ana gezinme' }).locator('[aria-current="page"]').innerText();
  check(route.button.test(current), `${route.id}: navigation marks the active page`);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function assets(label) {
  const evidence = await page.evaluate(async () => {
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    const images = [...document.images].map(image => ({
      source: image.currentSrc || image.src, loaded: image.complete && image.naturalWidth > 0,
    }));
    const backgrounds = [...document.querySelectorAll('.assistant-shell, .assistant-hero, .prenscin-promotion-art')]
      .flatMap(element => [...getComputedStyle(element).backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)].map(match => match[1]));
    const unique = [...new Set(backgrounds)];
    for (const source of unique) {
      const loaded = await new Promise(resolve => {
        const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = source;
      });
      images.push({ source, loaded });
    }
    return images;
  });
  imageEvidence.push({ label, images: evidence });
  check(evidence.length > 0 && evidence.every(image => image.loaded), `${label}: all local image and decorative background assets load`, evidence.filter(image => !image.loaded));
  check(evidence.every(image => image.source.startsWith('file:') || image.source.startsWith('data:')), `${label}: assets are local to the packaged application`);
}

async function capture(name, width, height) {
  await page.setViewportSize({ width, height });
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await assets(name);
  const layout = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('body *')].filter(element => {
      const rect = element.getBoundingClientRect();
      return getComputedStyle(element).display !== 'none' && rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
    }).slice(0, 12).map(element => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })),
  }));
  check(layout.scrollWidth <= width, `${name}: no document horizontal overflow at ${width} × ${height}`, layout);
  const screenshot = path.join(output, `${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  screenshots.push({ name, file: screenshot, ...layout.viewport });
  const previewMode = /^01-(light|dark)-live-1480x980$/.exec(name)?.[1];
  if (previewMode) {
    const preview = path.join(output, `preview-${previewMode}.png`);
    await page.screenshot({ path: preview, fullPage: false });
    screenshots.push({ name: `preview-${previewMode}`, file: preview, fullPage: false, ...layout.viewport });
  }
}

try {
  await launch();
  await wait(page, async () => (await window.midgard.getState()).live?.streams.length === 0);
  await page.setViewportSize({ width: 1480, height: 980 });
  check(await page.locator('.live-empty').isVisible() && await page.getByRole('button', { name: 'Dosya seç', exact: true }).isVisible(), 'A fresh isolated profile starts on the empty live page with a working source entry point');
  await capture('00-empty-1480x980', 1480, 980);

  const promotion = page.getByRole('region', { name: 'PrensCin tanıtımı' });
  check(await promotion.isVisible(), 'PrensCin promotion is visible and identified as a promotion');
  check((await promotion.innerText()).trim() === 'PrensCin', 'The promotion displays exactly PrensCin without any additional copy');
  check(await promotion.locator('button, a').count() === 0, 'PrensCin promotion contains no CTA or copy control');

  const primary = page.getByRole('button', { name: 'Dosya ekle', exact: true }).first();
  const primaryFont = await primary.evaluate(element => ({ fontFamily: getComputedStyle(element).fontFamily, fontSize: getComputedStyle(element).fontSize }));
  check(primaryFont.fontFamily.includes('Segoe UI'), 'Primary buttons use the interface sans-serif font', primaryFont);
  await page.mouse.move(0, 0);
  const normal = await primary.evaluate(element => getComputedStyle(element).backgroundColor);
  await primary.hover();
  await page.waitForFunction(({ selector, normal }) => getComputedStyle(document.querySelector(selector)).backgroundColor !== normal, { selector: '.live-add', normal });
  const hovered = await primary.evaluate(element => getComputedStyle(element).backgroundColor);
  check(normal !== hovered, 'Primary button hover changes its computed background color', { normal, hovered });
  await page.keyboard.press('Tab');
  await primary.focus();
  const focus = await primary.evaluate(element => ({
    visible: element.matches(':focus-visible'), width: getComputedStyle(element).outlineWidth,
    style: getComputedStyle(element).outlineStyle, color: getComputedStyle(element).outlineColor,
  }));
  check(focus.visible && parseFloat(focus.width) >= 2 && focus.style !== 'none', 'Keyboard focus has a visible outline on the primary button', focus);

  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, files);
  await primary.click();
  await wait(page, async () => {
    const state = await window.midgard.getState();
    return state.live.streams.length === 3 && !state.live.activeWorkers && !state.live.queuedCount && state.live.streams.every(stream => stream.summary && stream.status === 'settled');
  });
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  check(await page.locator('.live-character-row').count() === 3, 'All three explicitly synthetic characters appear in the live roster');
  check((await stateOf()).live.streams.every(stream => names.includes(stream.character?.name)), 'UI fixture identities are confined to the generated synthetic characters');
  await page.getByRole('textbox', { name: 'Karakter ara', exact: true }).fill('İpek');
  check(await page.locator('.live-character-row').count() === 1, 'Character search still filters the roster');
  await page.getByRole('textbox', { name: 'Karakter ara', exact: true }).fill('');

  const preferencesBeforeThemes = JSON.stringify((await stateOf()).assistance.preferences);
  for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width: 1480, height: 980 });
    await theme(mode);
    for (const route of routes) {
      await go(route);
      await capture(`01-${mode}-${route.id}-1480x980`, 1480, 980);
    }
    await go(routes[0]);
    await capture(`02-${mode}-live-1100x720`, 1100, 720);
    for (const route of routes) {
      await page.setViewportSize({ width: 390, height: 844 });
      await go(route);
      await capture(`03-${mode}-${route.id}-390x844`, 390, 844);
    }
  }
  check(JSON.stringify((await stateOf()).assistance.preferences) === preferencesBeforeThemes, 'Switching appearance themes preserves all existing notification preferences');
  const invalidTheme = await page.evaluate(async () => {
    const before = await window.midgard.getAppearanceTheme();
    let rejected = false;
    try { await window.midgard.setAppearanceTheme('invalid'); } catch { rejected = true; }
    return { rejected, before, after: await window.midgard.getAppearanceTheme() };
  });
  check(invalidTheme.rejected, 'Appearance IPC rejects a value outside the finite light/dark theme enum');
  check(invalidTheme.before === invalidTheme.after, 'Rejected appearance input leaves the saved theme unchanged', invalidTheme);

  await app.close(); app = null;
  await launch();
  await wait(page, async () => {
    const state = await window.midgard.getState();
    return state.live.streams.length === 3 && !state.live.activeWorkers && !state.live.queuedCount;
  });
  await page.waitForFunction(() => document.querySelector('.assistant-shell')?.getAttribute('data-theme') === 'dark', undefined, { timeout: 4000 }).catch(() => {});
  check(await page.locator('.assistant-shell').getAttribute('data-theme') === 'dark', 'The selected black theme survives a complete application restart');
  check(JSON.stringify((await stateOf()).assistance.preferences) === preferencesBeforeThemes, 'Application restart preserves the existing notification preferences');
  await go(routes[0]);
  await capture('04-dark-restart-live-1480x980', 1480, 980);
  await go(routes[3]);

  const monster = page.locator('.assistant-alert-row.monster');
  const notificationLabels = ['Seçili kart bildirimi', 'Old Blue Box çantaya geldiğinde', 'Glass Bead çantaya geldiğinde', 'Seçili yaratık ölümü', 'Karakter öldüğünde', 'Ağırlık sınırına gelince', 'Şehre dönünce'];
  const availableLabels = await page.locator('.assistant-alert-rows').getByRole('switch').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  check(JSON.stringify(availableLabels) === JSON.stringify(notificationLabels), 'The seven enabled global notification controls remain available; EXP/level controls stay disabled', availableLabels);
  check(await monster.getByRole('button', { name: 'Seçili yaratık ölümü sesini dene', exact: true }).isVisible(), 'Selected-monster sound test control remains visible');
  check(await page.getByRole('slider', { name: 'Ses düzeyi', exact: true }).isVisible(), 'The global volume slider remains visible');
  const monsterSwitch = monster.getByRole('switch', { name: 'Seçili yaratık ölümü', exact: true });
  await monsterSwitch.click();
  await wait(page, async () => !(await window.midgard.getState()).assistance.preferences.enabled.monster);
  check(await monsterSwitch.getAttribute('aria-checked') === 'false', 'Notification switch updates its accessible state and saved preference');
  await monsterSwitch.click();
  await wait(page, async () => (await window.midgard.getState()).assistance.preferences.enabled.monster);
  await monster.getByRole('button', { name: 'Ses seç', exact: true }).click();
  check(await page.locator('.assistant-error').count() === 0, 'Canceling sound selection leaves settings usable');

  check(!errors.length, 'No renderer errors occur', errors);
  const report = {
    passed: checks.length, failed: failures.length, checks, failures, errors, screenshots, imageEvidence,
    fixture: 'Three generated SYNTHETIC replay files and a new dedicated MIDGARD_USER_DATA profile. Character names explicitly contain QA Sentetik. No real player profile or replay was used.',
    limits: 'UI appearance in light and black themes, local asset loading and control interaction checks only. 390 × 844 is viewport emulation in Electron; the desktop native minimum window remains 1100 × 720. These fixtures do not validate real Skadi gameplay, live EXP/drop accuracy, or physical speaker output.',
  };
  await writeFile(path.join(output, 'design-ui-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, passed: checks.length, failed: failures.length, failures, errors, screenshots }, null, 2));
  if (failures.length) throw Error(`${failures.length} design UI checks failed; see design-ui-report.json.`);
} catch (error) {
  await writeFile(path.join(output, 'design-ui-failure.json'), JSON.stringify({ checks, failures, errors, failure: String(error) }, null, 2));
  try { await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); } catch {}
  throw error;
} finally {
  await app?.close();
}
