const { test, expect } = require('@playwright/test');
const entry = require('./fixtures/community/start-location.json');
const path = require('node:path');
async function load(page, options = {}) {
  await page.addInitScript(({ entry, options }) => {
    window.calls = [];
    window.snapshot = { entries: [{ ...entry, reviewStatus: options.listed ? 'listed' : 'pending' }], warnings: [], stale: false, projectImportEnabled: options.projectImportEnabled ?? true };
    window.projects = [{ id: 'chosen-project', name: 'Example Space', path: 'E:\\UnityTest\\Example Space', unityVersion: '6000.3.21f1', sdk: 'Creator SDK / Altspace', helper: options.helper || 'missing', open: Boolean(options.projectOpen) }];
    window.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async (command, args) => {
      window.calls.push({ command, args });
      if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
      if (command === 'project_inventory') return { projects: [], warnings: [] };
      if (command === 'app_inventory') return { supported: true, apps: [] };
      if (command === 'hub_update_status') return { currentVersion: '0.1.0-alpha.6' };
      if (command === 'community_catalogue') {
        if (window.holdRefresh) return new Promise(resolve => { window.finishRefresh = () => resolve(structuredClone(window.snapshot)); });
        if (window.failRefresh) throw 'Offline. Try again.'; return structuredClone(window.snapshot);
      }
      if (command === 'download_community_package') {
        if (window.holdDownload) return new Promise(resolve => { window.finishDownload = resolve; });
        if (window.failDownload) throw 'Package checksum did not match. Nothing saved.';
        return 'Saved. Checksum matched; no files were imported into Unity.';
      }
      if (command === 'open_community_link') return;
      if (command === 'community_projects') { if (window.holdProjects) await new Promise(resolve => { window.finishProjects = resolve; }); if (window.projectsOffline) throw 'Projects are unavailable.'; return { projects: structuredClone(window.projects), warnings: [] }; }
      if (command === 'choose_community_project') return null;
      if (command === 'install_community_menu') {
        if (window.holdInstall) await new Promise(resolve => { window.finishInstall = resolve; });
        window.projects[0].helper = 'installed'; return 'Creator Plugins menu added.';
      }
      if (command === 'queue_community_import') return { projectId: args.projectId, requestId: 'a'.repeat(32), status: 'queued', message: 'Open Creator Plugins > Browse in Unity.' };
      if (command === 'community_import_status') return { projectId: args.projectId, requestId: args.requestId, status: window.receiptStatus || 'review', message: 'Editor receipt message.' };
      throw Error(`Unexpected action ${command}`);
    } } };
  }, { entry, options });
  await page.route('https://cdn.sidequestvr.com/file/4591279/image.png', route => options.badImage ? route.abort() : route.fulfill({ path: path.join(__dirname, 'fixtures/community/preview.png'), contentType: 'image/png' }));
  await page.goto('http://127.0.0.1:4188');
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === 'get_launch_request'))).toBe(true);
  await page.locator('#hub-pages [data-view="hub"]').click();
  await page.getByRole('button', { name: 'View Creator Plugins' }).click();
  await expect(page.locator('.community-count')).toHaveText('1 contribution');
}
for (const width of [940, 320]) for (const layout of ['grid', 'list']) test(`Plugins menu stays reachable while scrolling ${layout} at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 720 });
  await load(page, { listed: true });
  await page.evaluate(() => {
    const original = window.snapshot.entries[0];
    window.snapshot.entries = Array.from({ length: 12 }, (_, index) => ({ ...structuredClone(original), id: `scroll.${index}`, name: `Start Location ${index}` }));
  });
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await expect(page.locator('.community-count')).toHaveText('12 contributions');
  await page.getByRole('button', { name: layout === 'grid' ? 'Grid view' : 'List view', exact: true }).click();
  const trigger = page.locator('#suite-trigger');
  const initial = await trigger.boundingBox();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  const scrolled = await trigger.boundingBox();
  expect(scrolled.y).toBe(initial.y);
  expect(scrolled.y).toBeGreaterThanOrEqual(0);
  expect(scrolled.y + scrolled.height).toBeLessThan(720);
  const scrollY = await page.evaluate(() => window.scrollY);
  await trigger.click();
  await expect(page.locator('#suite-menu')).toBeVisible();
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await page.screenshot({ path: testInfo.outputPath('plugins-menu-scrolled.png') });
  const calls = await page.evaluate(() => window.calls.length);
  await page.locator('#suite-dismiss').click({ position: { x: width - 20, y: 400 } });
  await expect(page.locator('#suite-menu')).toBeHidden();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  expect(await page.evaluate(() => window.calls.length)).toBe(calls);
  await trigger.click();
  await page.locator('#suite-menu [data-view="hub"]').click();
  await expect(page.locator('#view-hub')).toBeVisible();
  await expect(page.locator('#view-plugins')).toBeHidden();
});

for (const width of [940, 320]) test(`Plugins heading and menu icon follow the current page at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 720 });
  await load(page, { listed: true });
  await expect(page.locator('#page-title')).toHaveText('CREATOR PLUGINS');
  await expect(page.locator('#suite-trigger .plugins-mark img')).toHaveAttribute('src', 'icons/creator-plugins.png');
  await expect(page.locator('#suite-trigger .suite-letter')).toHaveCount(0);
  await page.locator('#suite-trigger img').evaluate(image => image.decode());
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('plugins-heading.png') });
  await page.locator('#suite-trigger').click();
  await expect(page.locator('.suite-brand')).toHaveText('CREATOR PLUGINS');
  await expect(page.locator('.suite-brand')).toHaveCSS('opacity', '1');
  expect(await page.locator('.suite-brand').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.locator('#suite-menu [data-view="hub"]').click();
  await expect(page.locator('#page-title')).toHaveText('CREATOR HUB');
  await expect(page.locator('#mode-description')).toHaveText('Unity tools. One place.');
  await expect(page.locator('#suite-trigger .hub-mark .suite-letter')).toHaveText('H');
  await expect(page.locator('.suite-brand')).toHaveText('CREATOR HUB');
});

for (const width of [1100, 680, 390, 320]) test(`grid view preserves cards, details and controls at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 820 }); await load(page, { listed: true });
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'grid');
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.evaluate(() => {
    const original = window.snapshot.entries[0];
    window.snapshot.entries = Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(original), id: `grid.${index}`, name: index === 3 ? 'LongUnbrokenContributionName'.repeat(5) : `Start Location ${index}`, previewImage: index === 2 ? null : original.previewImage }));
  });
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await page.locator('.community-details summary').first().click();
  const before = await page.evaluate(() => window.calls.length);
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'grid');
  await expect(page.getByRole('button', { name: 'Grid view', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.community-details').first()).toHaveAttribute('open', '');
  expect(await page.evaluate(() => window.calls.length)).toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const cards = await page.locator('.community-item').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width })));
  if (width >= 680) expect(cards[0].y).toBe(cards[1].y);
  else expect(cards[1].y).toBeGreaterThan(cards[0].y);
  await page.locator('.community-details summary').first().click();
  await expect(page.locator('[data-id="grid.2"] .community-visual')).toContainText('No preview supplied');
  await page.screenshot({ path: testInfo.outputPath('plugins-grid.png'), fullPage: true });
  await page.evaluate(() => { window.holdDownload = true; });
  await page.getByRole('button', { name: 'Download package' }).first().click();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  for (const control of await page.getByRole('button', { name: 'Download package' }).all()) await expect(control).toBeDisabled();
  await page.evaluate(() => window.finishDownload('Saved. No import.'));
  await expect(page.getByRole('button', { name: 'Download package' }).first()).toBeEnabled();
  await page.reload();
  await page.locator('#hub-pages [data-view="hub"]').click();
  await page.getByRole('button', { name: 'View Creator Plugins' }).click();
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'grid');
  await page.getByRole('searchbox', { name: 'Search contributions' }).fill('no-match');
  await expect(page.locator('.community-empty')).toContainText('No matching contributions');
});

test('layout controls work when preference storage is blocked', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } }); });
  await load(page);
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'grid');
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'list');
  await expect(page.getByRole('heading', { name: 'Start Location' })).toBeVisible();
});

test('an explicit List preference survives reload instead of being reset to the Grid default', async ({ page }) => {
  await load(page);
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'grid');
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.reload();
  await page.locator('#hub-pages [data-view="hub"]').click();
  await page.getByRole('button', { name: 'View Creator Plugins' }).click();
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'list');
  await expect(page.getByRole('button', { name: 'List view', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

for (const width of [1100, 680, 390, 320]) test(`community is readable and the actual graph image renders at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 820 }); await load(page);
  await expect(page.getByRole('heading', { name: 'Start Location' })).toBeVisible();
  await expect(page.locator('.community-author')).toHaveText('By Mr. E / egon.gb');
  await expect.poll(() => page.locator('.community-image-button img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('plugins.png'), fullPage: true });
  await page.locator('.community-details summary').click();
  await expect(page.locator('.community-details')).toContainText('Not yet verified');
  await expect(page.locator('.community-details')).toContainText('ReadmeEditor.cs');
  await expect(page.locator('.community-incorporation')).toContainText('Visual Scripting/VS');
  await expect(page.locator('.community-incorporation')).toContainText('Script Machine or State Machine');
  const overlap = await page.evaluate(() => {
    const a = document.querySelector('#suite-trigger').getBoundingClientRect(); const b = document.querySelector('.community-search').getBoundingClientRect();
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  });
  expect(overlap).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('plugins-details.png'), fullPage: true });
});
test('search, filters, zero results, reset and navigation retain catalogue state', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: 'Prefabs', exact: true }).click();
  await expect(page.locator('.community-count')).toHaveText('0 contributions');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('searchbox', { name: 'Search contributions' }).fill('egon');
  await expect(page.locator('.community-count')).toHaveText('1 contribution');
  await page.locator('#suite-trigger').click(); await page.locator('#suite-menu [data-view="hub"]').click();
  await page.locator('#hub-pages [data-view="hub"]').click();
  await page.getByRole('button', { name: 'View Creator Plugins' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search contributions' })).toHaveValue('egon');
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'community_catalogue').length)).toBe(1);
});
test('pending entries cannot download and never infer tested versions', async ({ page }) => {
  await load(page); await expect(page.getByRole('button', { name: 'Download package' })).toHaveCount(0);
  await expect(page.locator('.community-review')).toHaveText('Review pending');
  expect(await page.evaluate(() => window.calls.some(c => c.command !== 'project_inventory' && /download|install|project/.test(c.command)))).toBe(false);
});

test('public browse-only mode keeps downloads but exposes no Unity write controls', async ({ page }) => {
  await load(page, { listed: true, projectImportEnabled: false });
  await expect(page.getByRole('button', { name: 'Add Unity menu', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add to project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download package' })).toBeEnabled();
  await page.evaluate(() => { delete window.snapshot.projectImportEnabled; });
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await expect(page.getByRole('button', { name: 'Add Unity menu', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add to project' })).toHaveCount(0);
  expect(await page.evaluate(() => window.calls.some(c => /community_projects|install_community|queue_community/.test(c.command)))).toBe(false);
});

for (const [category, scope, note] of [['mcp-tool', 'both', 'MCP client or server'], ['ai-skill', 'both', 'AI client skill'], ['recipe', 'both', 'Instructions only'], ['graph', 'instructions-only', 'Instructions only']]) test(`${category}/${scope} cannot route a disguised unitypackage into Unity`, async ({ page }) => {
  await load(page, { listed: true });
  await page.evaluate(({ category, scope }) => { Object.assign(window.snapshot.entries[0], { category, scope }); }, { category, scope });
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await expect(page.getByRole('button', { name: 'Add to project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download package' })).toBeEnabled();
  await page.locator('.community-details summary').click();
  await expect(page.locator('.community-destination')).toContainText(note);
  expect(await page.evaluate(() => window.calls.some(c => /queue_community|install_community/.test(c.command)))).toBe(false);
});

for (const [category, label, hasDownload] of [['mcp-tool', 'MCP tools', true], ['ai-skill', 'AI skills', false]]) test(`${label} filter preserves instructions and never offers Unity import for non-Unity content`, async ({ page }) => {
  await load(page);
  await page.evaluate(({ category, hasDownload }) => {
    const contribution = structuredClone(window.snapshot.entries[0]);
    contribution.id = `test.${category}`; contribution.name = `Example ${category}`;
    contribution.category = category; contribution.reviewStatus = 'listed';
    contribution.includesCode = hasDownload;
    if (hasDownload) contribution.download.url = 'https://cdn.sidequestvr.com/file/1/tool.zip';
    else { delete contribution.download; contribution.scope = 'instructions-only'; }
    window.snapshot.entries.push(contribution);
  }, { category, hasDownload });
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await expect(page.locator('.community-count')).toHaveText('2 contributions');
  const filter = page.getByRole('button', { name: label, exact: true });
  await filter.click(); await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.community-count')).toHaveText('1 contribution');
  await expect(page.locator('.community-type')).toHaveText(label);
  await expect(page.locator('.community-item h3')).toHaveText(`Example ${category}`);
  await expect(page.getByRole('button', { name: 'Add to project' })).toHaveCount(0);
  await page.locator('.community-details summary').click();
  await page.getByRole('button', { name: 'Full instructions', exact: true }).click();
  expect(await page.evaluate(() => window.calls.at(-1))).toEqual({ command: 'open_community_link', args: { id: `test.${category}`, kind: 'instructions' } });
  if (hasDownload) {
    await expect(page.locator('.community-code')).toHaveText('Includes code');
    await page.getByRole('button', { name: 'Download package' }).click();
    expect(await page.evaluate(() => window.calls.at(-1))).toEqual({ command: 'download_community_package', args: { id: `test.${category}` } });
  } else {
    await expect(page.getByRole('button', { name: 'Download package' })).toHaveCount(0);
    await expect(page.locator('.community-review')).toHaveText('Instructions only');
  }
  expect(await page.evaluate(() => window.calls.some(c => /install|queue_community_import|community_projects/.test(c.command)))).toBe(false);
  await page.getByRole('button', { name: 'All types', exact: true }).click();
  await expect(page.locator('.community-count')).toHaveText('2 contributions');
});
test('first-load downloads enabled and duplicate save blocked even after filtering', async ({ page }) => {
  await load(page, { listed: true }); const save = page.getByRole('button', { name: 'Download package' }); await expect(save).toBeEnabled();
  await page.evaluate(() => { window.holdDownload = true; }); await save.click(); await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Visual Scripting', exact: true }).click(); await expect(save).toBeDisabled();
  await page.evaluate(() => window.finishDownload('Saved. No import.')); await expect(save).toBeEnabled();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'download_community_package'))).toEqual([{ command: 'download_community_package', args: { id: entry.id } }]);
});
test('refresh visibly disables existing downloads before its response arrives', async ({ page }) => {
  await load(page, { listed: true }); await page.evaluate(() => { window.holdRefresh = true; });
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await expect(page.getByRole('button', { name: 'Download package' })).toBeDisabled();
  await page.evaluate(() => window.finishRefresh());
  await expect(page.getByRole('button', { name: 'Download package' })).toBeEnabled();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'download_community_package'))).toHaveLength(0);
});

test('failed refresh retains visible entries but disables download until successful retry', async ({ page }) => {
  await load(page, { listed: true }); await page.evaluate(() => { window.failRefresh = true; });
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await expect(page.locator('.community-count')).toContainText('Saved view'); await expect(page.getByRole('button', { name: 'Download package' })).toBeDisabled();
  await page.evaluate(() => { window.failRefresh = false; }); await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await expect(page.getByRole('button', { name: 'Download package' })).toBeEnabled();
});
test('untrusted text stays text and unapproved images are not requested', async ({ page }) => {
  await load(page); await page.evaluate(() => { window.snapshot.entries[0].name = '<img src=x onerror=alert(1)>'; window.snapshot.entries[0].previewImage = 'https://evil.test/a.png'; });
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await expect(page.locator('.community-item h3')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.community-item img')).toHaveCount(0);
});
test('preview failure has a usable fallback and image dialog supports escape', async ({ page }) => {
  await load(page, { badImage: true }); await expect(page.locator('.community-visual')).toContainText('Preview unavailable');
  await page.unroute('https://cdn.sidequestvr.com/file/4591279/image.png');
  await page.route('https://cdn.sidequestvr.com/file/4591279/image.png', route => route.fulfill({ path: path.join(__dirname, 'fixtures/community/preview.png'), contentType: 'image/png' }));
  await page.getByRole('button', { name: 'Refresh catalogue' }).click();
  await page.getByRole('button', { name: 'Enlarge Start Location preview' }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeHidden();
});
test('submission passes a fixed resource identifier rather than an arbitrary URL', async ({ page }) => {
  await load(page); await page.getByRole('button', { name: 'Share a creation' }).click();
  expect(await page.evaluate(() => window.calls.at(-1))).toEqual({ command: 'open_community_link', args: { id: '', kind: 'submit' } });
});

test('Unity menu needs an explicit project and no write happens by opening or closing its picker', async ({ page }) => {
  await load(page); await page.getByRole('button', { name: 'Add Unity menu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Unity menu' }); await expect(dialog).toBeVisible();
  await expect(dialog.locator('select')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Add menu to project' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(() => window.calls.filter(c => ['install_community_menu','queue_community_import'].includes(c.command)))).toHaveLength(0);
});

test('helper install keeps the dialog open during the action and uses only the selected native ID', async ({ page }) => {
  await load(page); await page.getByRole('button', { name: 'Add Unity menu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Unity menu' }); await dialog.locator('select').selectOption('chosen-project');
  await expect(dialog).toContainText('E:\\UnityTest\\Example Space');
  await page.evaluate(() => { window.holdInstall = true; });
  await dialog.getByRole('button', { name: 'Add menu to project' }).click(); await page.keyboard.press('Escape');
  await expect(dialog).toContainText('Preparing the Unity menu... Please wait.');
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await page.evaluate(() => window.finishInstall());
  await expect(dialog).toContainText('Creator Plugins menu installed.');
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'install_community_menu'))).toEqual([{ command: 'install_community_menu', args: { projectId: 'chosen-project' } }]);
});

for (const fails of [false, true]) test(`project discovery explains disabled controls and clears loading on ${fails ? 'failure' : 'success'}`, async ({ page }) => {
  await load(page);
  await page.evaluate(fails => { window.holdProjects = true; window.projectsOffline = fails; }, fails);
  await page.getByRole('button', { name: 'Add Unity menu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Unity menu' });
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.getByRole('status').filter({ hasText: 'Loading Unity projects... Please wait.' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Browse', exact: true })).toBeDisabled();
  await expect(dialog.locator('select')).toBeDisabled();
  await page.evaluate(() => window.finishProjects());
  await expect(dialog).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.getByText('Loading Unity projects... Please wait.', { exact: true })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Browse', exact: true })).toBeEnabled();
  if (fails) await expect(dialog).toContainText('Projects are unavailable.');
  else { await dialog.locator('select').selectOption('chosen-project'); await expect(dialog.getByRole('button', { name: 'Add menu to project' })).toBeEnabled(); }
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'install_community_menu'))).toBe(false);
});

for (const [helper, projectOpen, expected] of [['missing', true, 'Close this project'], ['different', false, 'will not be overwritten']]) test(`helper installation refuses ${helper}/${projectOpen}`, async ({ page }) => {
  await load(page, { helper, projectOpen }); await page.getByRole('button', { name: 'Add Unity menu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Unity menu' }); await dialog.locator('select').selectOption('chosen-project');
  await expect(dialog).toContainText(expected); await expect(dialog.getByRole('button', { name: 'Add menu to project' })).toBeDisabled();
});

for (const projectOpen of [false, true]) test(`known older helper offers a backed-up update, open=${projectOpen}`, async ({ page }) => {
  await load(page, { helper: 'outdated', projectOpen });
  await page.getByRole('button', { name: 'Add Unity menu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Unity menu' });
  await dialog.locator('select').selectOption('chosen-project');
  const update = dialog.getByRole('button', { name: 'Update menu in project' });
  if (projectOpen) {
    await expect(update).toBeDisabled(); await expect(dialog).toContainText('Close this project');
  } else {
    await expect(update).toBeEnabled(); await expect(dialog).toContainText('backs it up');
    await update.click(); await expect(dialog).toContainText('Creator Plugins menu installed.');
    expect(await page.evaluate(() => window.calls.filter(c => c.command === 'install_community_menu'))).toEqual([{ command: 'install_community_menu', args: { projectId: 'chosen-project' } }]);
  }
});

test('adding a package queues once and receipt checks distinguish review from imported', async ({ page }) => {
  await load(page, { listed: true, helper: 'installed' }); await page.getByRole('button', { name: 'Add to project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Start Location' });
  const send = dialog.getByRole('button', { name: 'Send to Unity for review' }); await expect(send).toBeDisabled();
  await dialog.locator('select').selectOption('chosen-project'); await send.click();
  await expect(dialog).toContainText('Queued, not imported'); await expect(send).toBeDisabled();
  await dialog.getByRole('button', { name: 'Check Unity status' }).click(); await expect(dialog).toContainText('Waiting for the Unity import outcome');
  await page.evaluate(() => { window.receiptStatus = 'imported'; });
  await dialog.getByRole('button', { name: 'Check Unity status' }).click(); await expect(dialog).toContainText('Project validation is still needed');
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'queue_community_import'))).toEqual([{ command: 'queue_community_import', args: { id: entry.id, projectId: 'chosen-project' } }]);
});

test('pending listing stays unimportable and project read failure is actionable', async ({ page }) => {
  await load(page); await expect(page.getByRole('button', { name: 'Add to project' })).toBeDisabled();
  await page.evaluate(() => { window.projectsOffline = true; });
  await page.getByRole('button', { name: 'Add Unity menu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Unity menu' }); await expect(dialog).toContainText('Projects are unavailable');
  await expect(dialog.getByRole('button', { name: 'Browse' })).toBeEnabled(); await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
});

for (const width of [1100, 560, 390, 320]) test(`project import dialog fits at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 720 }); await load(page, { listed: true, helper: 'installed' });
  await page.getByRole('button', { name: 'Add to project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Start Location' }); await dialog.locator('select').selectOption('chosen-project');
  await expect(dialog.getByRole('button', { name: 'Send to Unity for review' })).toBeEnabled();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('project-import.png') });
});
