const { test, expect } = require('@playwright/test');

async function load(page) {
  await page.addInitScript(() => {
    window.calls = [];
    window.projects = { projects: [
      { id: 'creator', name: 'Creator Forest', path: 'E:\\UnityTest\\Creator Forest', sdk: 'creator', sdkLabel: 'Creator SDK / Altspace', unityVersion: '6000.3.21f1', source: 'Unity Hub', added: false },
      { id: 'banter', name: 'Banter Playground', path: 'E:\\UnityTest\\Banter Playground', sdk: 'banter', sdkLabel: 'Banter SDK', unityVersion: '2022.3.39f1', source: 'Creator Works MCP', added: true },
      { id: 'plain', name: 'Plain Unity', path: 'E:\\UnityTest\\Plain', sdk: 'unity', sdkLabel: 'Unity / no SDK detected', unityVersion: '6000.3.21f1', source: 'Unity Hub', added: false },
      { id: 'missing', name: 'Missing project', path: 'E:\\gone', sdk: 'unknown', sdkLabel: 'SDK unknown', unityVersion: '', source: 'Unity Hub', added: false, issue: 'Project folder is missing or unavailable.' },
    ], warnings: [] };
    window.__TAURI__ = {
      event: { listen: async () => () => {} },
      core: { invoke: async (command, args) => {
        window.calls.push({ command, args });
        if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
        if (command === 'app_inventory') return { supported: true, apps: [] };
        if (window.failure) throw window.failure;
        if (command === 'project_inventory') return window.projects;
        if (command === 'add_project_folder') return null;
        if (command === 'remove_project_folder') { window.projects.projects = window.projects.projects.filter(p => p.id !== args.id); return window.projects; }
        if (command === 'open_unity_project') {
          if (window.hold) return new Promise(resolve => window.finishOpen = resolve);
          return 'Unity launch requested.';
        }
      } },
    };
  });
  await page.goto('http://127.0.0.1:4188');
  await expect(page.locator('#catalog-status')).toContainText('Update check complete');
  await page.locator('#hub-pages [data-view="projects"]').click();
  await expect(page.locator('#project-status')).toContainText('4 known projects');
}

test('projects are read on demand; filters and navigation preserve the list without polling', async ({ page }) => {
  await load(page);
  await expect(page.locator('.project-row')).toHaveCount(2);
  await page.locator('#project-sdk').selectOption('banter');
  await expect(page.locator('.project-row')).toHaveCount(1);
  await page.locator('#project-search').fill('not found');
  await expect(page.locator('#project-list')).toHaveText('No matching projects.');
  await page.locator('#hub-pages [data-view="hub"]').click();
  await page.locator('#hub-pages [data-view="projects"]').click();
  await expect(page.locator('#project-search')).toHaveValue('not found');
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'project_inventory').length)).toBe(1);
  expect(await page.evaluate(() => window.calls.filter(c => ['install_app', 'open_unity_project'].includes(c.command)))).toEqual([]);
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-menu [data-view="hub"]')).toBeFocused();
});

test('explicit launch sends only a known ID and prevents double clicks', async ({ page }) => {
  await load(page); await page.evaluate(() => window.hold = true);
  await page.getByRole('button', { name: 'Open Creator Forest', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Creator Forest', exact: true })).toBeDisabled();
  await expect(page.locator('#refresh-projects')).toBeDisabled();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'open_unity_project'))).toEqual([{ command: 'open_unity_project', args: { id: 'creator' } }]);
  await page.evaluate(() => window.finishOpen('Unity launch requested.'));
  await expect(page.locator('#project-status')).toHaveText('Unity launch requested.');
});

test('failed lookup keeps old rows; cancel and removal do not delete projects', async ({ page }) => {
  await load(page); await page.locator('#add-project').click();
  await expect(page.locator('#project-status')).toHaveText('No project added.');
  await page.getByRole('button', { name: 'Remove Banter Playground from saved list', exact: true }).click();
  await expect(page.locator('.project-row')).toHaveCount(1);
  await page.evaluate(() => window.failure = 'Project operation busy.');
  await page.locator('#refresh-projects').click();
  await expect(page.locator('#project-status')).toHaveText('Project operation busy.');
  await expect(page.locator('.project-row')).toHaveCount(1);
  expect(await page.evaluate(() => window.calls.some(c => /delete|install|open_unity/.test(c.command)))).toBe(false);
});

for (const width of [940, 560, 390, 320]) test(`project content fits at ${width}px and renders labels as text`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 700 }); await load(page);
  await page.locator('#project-sdk').selectOption('all');
  await expect(page.getByRole('button', { name: 'Open Missing project', exact: true })).toBeDisabled();
  const button = page.getByRole('button', {name:'Open Creator Forest', exact:true});
  const box = await button.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(104);
  expect(box.height).toBeGreaterThanOrEqual(44);
  const leftEdges = await page.locator('.project-open').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
  expect(new Set(leftEdges).size).toBe(1);
  expect(await button.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
  await button.focus();
  await expect(button).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('projects-open-button.png'), fullPage: true });
  await page.evaluate(() => {
    window.projects.projects[0].name = '<img src=x onerror="window.injected=true">';
    window.projects.projects[0].path = 'E:\\UnityTest\\' + 'LongProjectName'.repeat(12);
  });
  await page.locator('#refresh-projects').click();
  await expect(page.locator('#project-list img')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('projects.png'), fullPage: true });
});
