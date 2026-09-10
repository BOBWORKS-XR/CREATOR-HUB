const { test, expect } = require('@playwright/test');

async function load(page) {
  await page.addInitScript(() => {
    window.calls = [];
    window.projects = { projects: [
      { id: 'creator', name: 'Creator Forest', path: 'E:\\UnityTest\\Creator Forest', sdk: 'creator', sdkLabel: 'Creator SDK / Altspace', unityVersion: '6000.3.21f1', source: 'Unity Hub', added: false, modifiedAtMs: Date.UTC(2026, 8, 11, 12) },
      { id: 'banter', name: 'Banter Playground', path: 'E:\\UnityTest\\Banter Playground', sdk: 'banter', sdkLabel: 'Banter SDK', unityVersion: '2022.3.39f1', source: 'Creator Works MCP', added: true, modifiedAtMs: Date.UTC(2026, 8, 10, 12) },
      { id: 'plain', name: 'Plain Unity', path: 'E:\\UnityTest\\Plain', sdk: 'unity', sdkLabel: 'Unity / no SDK detected', unityVersion: '6000.3.21f1', source: 'Unity Hub', added: false, modifiedAtMs: Date.UTC(2026, 8, 11, 13) },
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

const projectNames = page => page.locator('.project-info > strong');

test('newest saved project is first by default, with alphabetical sorting available', async ({ page }) => {
  await load(page);
  await expect(page.getByRole('combobox', { name: 'Sort projects' })).toHaveValue('modified');
  await expect(projectNames(page)).toHaveText(['Creator Forest', 'Banter Playground']);
  await page.locator('#project-sdk').selectOption('all');
  await expect(projectNames(page)).toHaveText(['Plain Unity', 'Creator Forest', 'Banter Playground', 'Missing project']);
  await expect(page.locator('.project-row').last().locator('.project-modified')).toHaveText('Modified date unavailable');
  await page.getByRole('combobox', { name: 'Sort projects' }).selectOption('name');
  await expect(projectNames(page)).toHaveText(['Banter Playground', 'Creator Forest', 'Missing project', 'Plain Unity']);
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'project_inventory').length)).toBe(1);
});

test('sorting keeps search, SDK filter and navigation choices, without native writes', async ({ page }) => {
  await load(page);
  await page.locator('#project-sort').selectOption('name');
  await page.locator('#project-search').fill('Forest');
  await page.locator('#project-sdk').selectOption('creator');
  await page.locator('#hub-pages [data-view="hub"]').click();
  await page.locator('#hub-pages [data-view="projects"]').click();
  await expect(page.locator('#project-sort')).toHaveValue('name');
  await expect(page.locator('#project-sdk')).toHaveValue('creator');
  await expect(page.locator('#project-search')).toHaveValue('Forest');
  await expect(projectNames(page)).toHaveText(['Creator Forest']);
  expect(await page.evaluate(() => window.calls.filter(c => /project/.test(c.command)))).toEqual([{ command: 'project_inventory', args: {} }]);
});

test('equal dates use natural alphabetical order; unknown or invalid dates sort last', async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const template = window.projects.projects[0];
    window.projects.projects = [
      ['Project 10', 1000, 'B'], ['Project 2', 1000, 'A'], ['Project 2', 1000, 'B'],
      ['Zero', 0, 'C'], ['A unknown', null, 'D'], ['B missing', undefined, 'E'],
      ['C invalid', '2026-09-11', 'F'], ['D out of range', 9000000000000000, 'G'],
      ['E negative', -1, 'H'],
    ].map(([name, modifiedAtMs, suffix], index) => ({ ...template, name, modifiedAtMs, path: `E:\\${suffix}`, id: String(index) }));
  });
  await page.locator('#refresh-projects').click();
  await expect(projectNames(page)).toHaveText(['Project 2', 'Project 2', 'Project 10', 'Zero', 'A unknown', 'B missing', 'C invalid', 'D out of range', 'E negative']);
  await expect(page.locator('.project-info > small').first()).toHaveText('E:\\A');
  await expect(page.locator('.project-modified').filter({ hasText: 'unavailable' })).toHaveCount(5);
});

test('refresh reorders modified dates and preserves an explicitly selected name sort', async ({ page }) => {
  await load(page);
  await page.evaluate(() => window.projects.projects[1].modifiedAtMs = Date.UTC(2026, 8, 12));
  await page.locator('#refresh-projects').click();
  await expect(projectNames(page)).toHaveText(['Banter Playground', 'Creator Forest']);
  await page.locator('#project-sort').selectOption('name');
  await page.evaluate(() => window.projects.projects[0].modifiedAtMs = Date.UTC(2026, 8, 13));
  await page.locator('#refresh-projects').click();
  await expect(page.locator('#project-sort')).toHaveValue('name');
  await expect(projectNames(page)).toHaveText(['Banter Playground', 'Creator Forest']);
  await page.locator('#project-sort').selectOption('modified');
  await expect(projectNames(page)).toHaveText(['Creator Forest', 'Banter Playground']);
});

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
  await page.locator('#project-sort').selectOption('name');
  await expect(page.getByRole('button', { name: 'Open Creator Forest', exact: true })).toBeDisabled();
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
  const sort = page.getByRole('combobox', { name: 'Sort projects' });
  await sort.focus();
  await expect(sort).toBeFocused();
  const filterBoxes = await page.locator('.project-filters > *').evaluateAll(elements => elements.map(element => {
    const { left, right, top, bottom } = element.getBoundingClientRect(); return { left, right, top, bottom };
  }));
  for (let i = 0; i < filterBoxes.length; i++) for (let j = i + 1; j < filterBoxes.length; j++) {
    const a = filterBoxes[i], b = filterBoxes[j];
    expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
  }
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
