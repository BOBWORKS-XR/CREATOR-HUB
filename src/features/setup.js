import { controller, node, lines, text } from './common.js';

const licenceUrls = {
  unity: 'https://unity.com/legal/editor-terms-of-service/software',
  android: 'https://developer.android.com/studio/terms',
  openjdk: 'https://openjdk.org/legal/gplv2+ce.html',
};

export function mount(root, api) {
  root.innerHTML = `
    <div class="feature-heading"><h2>Project Setup</h2><span data-field="status" role="status">Checking availability</span></div>
    <p data-field="error" class="feature-error" role="alert" hidden></p>
    <button data-field="retry" class="text-button" type="button" hidden>Check connection again</button>
    <fieldset data-field="controls" disabled aria-label="Project Setup controls">
      <div class="feature-tabs" role="tablist" aria-label="Project mode">
        <button data-field="new-tab" role="tab" aria-selected="true" aria-controls="feature-setup-new" type="button">New project</button>
        <button data-field="existing-tab" role="tab" aria-selected="false" aria-controls="feature-setup-existing" type="button">Existing project</button>
      </div>
      <div class="feature-grid">
        <div>
          <section id="feature-setup-new" role="tabpanel" aria-label="New project">
            <label>Project name<input data-field="name" type="text" maxlength="64" value="My Creator Space" autocomplete="off"></label>
            <div class="feature-input-row"><label>Project folder<input data-field="parent" type="text" autocomplete="off" spellcheck="false"></label><button data-field="browse" class="text-button" type="button"><span class="icon icon-folder" aria-hidden="true"></span> Browse</button></div>
            <p data-field="recipe" class="feature-note">Requirements not checked</p>
            <p class="feature-note">Installation needs your approval. Unity sign-in, licensing and administrator prompts still need you.</p>
            <div class="feature-actions" aria-label="Installation licence terms"><span class="feature-note">Licence terms:</span><button data-field="licence-unity" class="text-button" type="button">Unity <span class="icon icon-external" aria-hidden="true"></span></button><button data-field="licence-android" class="text-button" type="button">Android SDK/NDK <span class="icon icon-external" aria-hidden="true"></span></button><button data-field="licence-openjdk" class="text-button" type="button">OpenJDK <span class="icon icon-external" aria-hidden="true"></span></button></div>
            <div class="feature-actions"><button data-field="create" class="primary-button" type="button" disabled>Set up and create project</button><button data-field="open" class="text-button" type="button" hidden>Open project in Unity</button><button data-field="another" class="text-button" type="button" hidden>Create another project</button></div>
            <div data-field="created" class="feature-output" role="status"></div>
            <p data-field="hub-result" class="feature-note"></p>
            <div class="feature-actions"><button data-field="register" class="text-button" type="button" hidden>Retry adding to Unity Hub</button><button data-field="restart" class="text-button" type="button" hidden>Restart Unity Hub</button></div>
          </section>
          <section id="feature-setup-existing" role="tabpanel" aria-label="Existing project" hidden>
            <div class="feature-input-row"><label>Unity project folder<input data-field="existing-path" type="text" autocomplete="off" spellcheck="false"></label><button data-field="existing-browse" class="text-button" type="button"><span class="icon icon-folder" aria-hidden="true"></span> Browse</button></div>
            <button data-field="inspect" class="primary-button" type="button">Inspect project</button>
            <p data-field="inspection-summary" role="status"></p>
            <div data-field="findings"></div><ul data-field="changes"></ul>
            <button data-field="review-hub" class="text-button" type="button" hidden>Open Unity Hub for manual review</button>
            <label class="feature-check"><input data-field="approval" type="checkbox"><span>Back up settings and allow Unity to import and validate this project.</span></label>
            <div class="feature-actions"><button data-field="repair" class="primary-button" type="button" disabled>Back up and apply repairs</button><button data-field="validate" class="text-button" type="button" disabled>Back up and validate</button><button data-field="open-existing" class="text-button" type="button" hidden>Open project in Unity</button></div>
            <div data-field="existing-result" class="feature-output" role="status"></div>
          </section>
          <div data-field="activity" class="feature-section" role="status" hidden><strong data-field="stage"></strong><p data-field="detail"></p><progress data-field="progress" max="100"></progress><p data-field="transfer" class="feature-note"></p></div>
        </div>
        <section class="feature-section" aria-label="Requirements">
          <div class="feature-heading"><h3>Requirements</h3><button data-field="refresh" class="icon-button" type="button" title="Check requirements again" aria-label="Check requirements again"><span class="icon icon-refresh" aria-hidden="true"></span></button></div>
          <p data-field="platform" class="feature-note"></p><div data-field="requirements"></div><div data-field="blockers" class="feature-note"></div>
          <button data-field="hub" class="text-button" type="button">Open Unity Hub</button>
        </section>
      </div>
    </fieldset>`;
  const page = controller(root, api, 'setup');
  const $ = page.field;
  let environment = null;
  let created = null;
  let inspection = null;
  let inspectionRevision = 0;
  let completed = null;
  let hub = null;
  let operation = null;
  let stage = 0;
  const run = async (action, label) => {
    const result = await page.run(action, label);
    if (result && !root.querySelector('#feature-setup-existing').hidden && inspection?.findings.some(finding => finding.status === 'blocked')) $('status').textContent = 'Review findings';
    controls(); return result;
  };
  function controls() {
    const canBootstrap = ['windows', 'linux'].includes(environment?.platform);
    $('create').disabled = Boolean(created) || !environment || (!environment.ready && !canBootstrap);
    $('name').disabled = $('parent').disabled = $('browse').disabled = Boolean(created);
    $('open').hidden = $('another').hidden = !created;
    $('inspect').disabled = !$('existing-path').value.trim();
    $('repair').disabled = !inspection?.canRepair || !$('approval').checked;
    $('validate').disabled = !inspection?.canValidate || !$('approval').checked;
    $('repair').hidden = !inspection?.canRepair;
    $('validate').hidden = !inspection?.canValidate;
    $('approval').parentElement.hidden = !inspection?.canRepair && !inspection?.canValidate;
    $('review-hub').hidden = !inspection?.findings.some(finding => finding.status === 'blocked');
    $('open-existing').hidden = !completed;
    $('register').hidden = !created || Boolean(hub?.registered);
    $('restart').hidden = !hub?.registered || !hub?.refreshPending || !['windows', 'linux'].includes(environment?.platform);
  }
  function renderEnvironment(value) {
    if (!value?.recipe || !Array.isArray(value.editors) || !Array.isArray(value.blockers)) throw new Error('Requirements response is incomplete. Check again.');
    environment = value;
    if (!$('parent').value) $('parent').value = value.suggestedProjectParent || '';
    const recipe = value.recipe;
    $('platform').textContent = text(value.platform);
    $('recipe').textContent = `Approved recipe: Unity ${recipe.editorVersion} · Creator SDK ${recipe.creatorSdkVersion} · URP ${recipe.urpVersion} · Input ${recipe.inputSystemVersion}`;
    const editor = value.editors.find(item => item.exactRecipe);
    const rows = [
      ['Unity Hub or Unity CLI', value.hubInstalled ? `Hub ${value.hubVersion || 'detected'}` : value.unityCliInstalled ? 'CLI detected' : 'Missing', value.hubInstalled || value.unityCliInstalled],
      [`Unity ${recipe.editorVersion}`, editor ? 'Installed' : 'Missing', Boolean(editor)],
    ];
    if (editor) rows.push(['Android Build Support', editor.androidPlayer ? 'Installed' : 'Missing', editor.androidPlayer],
      ['Android SDK, NDK and OpenJDK', editor.androidSdk && editor.androidNdk && editor.openJdk ? 'Installed' : 'Incomplete', editor.androidSdk && editor.androidNdk && editor.openJdk],
      ['Windows build support', editor.windowsStandalone ? 'Installed' : 'Missing', editor.windowsStandalone],
      ['Official 3D URP template', editor.urpTemplate ? 'Available' : 'Missing', editor.urpTemplate]);
    $('requirements').replaceChildren(...rows.map(([label, value, ready]) => {
      const row = node('div', null, 'feature-row'); row.append(node('span', label), node('span', value, ready ? 'feature-good' : 'feature-warn')); return row;
    }));
    lines($('blockers'), [...(!editor ? ['Will install: Android tools, Windows support and the URP template.'] : []), ...value.blockers]);
    controls();
  }
  function showHub(value) { hub = value; $('hub-result').textContent = value?.message || ''; controls(); }
  function clearInspection() { inspectionRevision++; inspection = null; completed = null; $('approval').checked = false; $('inspection-summary').replaceChildren(); $('findings').replaceChildren(); $('changes').replaceChildren(); $('existing-result').replaceChildren(); controls(); }
  function startActivity(kind, label, detail) {
    operation = kind; stage = 0;
    $('stage').textContent = label; $('detail').textContent = detail;
    $('progress').removeAttribute('value'); $('transfer').textContent = '';
    $('activity').hidden = false;
  }
  function setMode(mode) {
    if (page.busy()) return;
    for (const name of ['new', 'existing']) {
      root.querySelector(`#feature-setup-${name}`).hidden = mode !== name;
      $(name + '-tab').setAttribute('aria-selected', String(mode === name));
    }
  }
  page.on($('new-tab'), 'click', () => setMode('new'));
  page.on($('existing-tab'), 'click', () => setMode('existing'));
  for (const name of ['new', 'existing']) page.on($(name + '-tab'), 'keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 'new' : event.key === 'End' ? 'existing' : name === 'new' ? 'existing' : 'new';
      setMode(next); $(next + '-tab').focus();
    }
  });
  for (const [button, field] of [['browse', 'parent'], ['existing-browse', 'existing-path']]) page.on($(button), 'click', () => run(async () => {
    const folder = await page.call('pick_parent_folder');
    if (folder) { $(field).value = folder; if (field === 'existing-path') clearInspection(); }
  }, 'Choosing folder'));
  page.on($('refresh'), 'click', () => run(async () => { renderEnvironment(await page.call('probe_environment')); }, 'Checking requirements'));
  page.on($('retry'), 'click', () => { if (!page.busy()) void api.retry('setup'); });
  page.on($('hub'), 'click', () => run(() => page.call('launch_hub'), 'Opening Unity Hub'));
  page.on($('review-hub'), 'click', () => run(() => page.call('launch_hub'), 'Opening Unity Hub'));
  for (const [name, url] of Object.entries(licenceUrls)) page.on($(`licence-${name}`), 'click', () => run(() => page.call('open_official_url', { url }), 'Opening licence terms'));
  page.on($('create'), 'click', () => run(async () => {
    if (created || !environment || !$('name').value.trim() || !$('parent').value.trim()) throw new Error('Enter a project name and folder.');
    startActivity('create', 'Creating project', 'Checking project path and Unity requirements.'); $('created').replaceChildren();
    let creationError;
    try {
      const value = await page.call('create_project', { request: { projectName: $('name').value, parentDirectory: $('parent').value } });
      lines($('created'), [value.message, value.projectPath, value.logPath ? `Log: ${value.logPath}` : null]);
      if (!value.success) throw new Error(value.message || 'Project validation failed. Review the local log before retrying.');
      created = value.projectPath; showHub(value.hub);
    } catch (error) { creationError = error; throw error; }
    finally {
      operation = null; $('activity').hidden = true;
      try { renderEnvironment(await page.call('probe_environment')); }
      catch (error) {
        const issue = `Requirements could not be refreshed. Last checked requirements may be out of date. ${text(error)}`;
        throw new Error([creationError?.message || text(creationError), issue].filter(Boolean).join('\n'));
      }
    }
  }, 'Creating project'));
  page.on($('open'), 'click', () => run(() => page.call('open_project', { path: created }), 'Opening project'));
  page.on($('another'), 'click', () => { if (page.busy()) return; created = null; hub = null; $('created').replaceChildren(); $('hub-result').textContent = ''; controls(); $('name').focus(); });
  page.on($('register'), 'click', () => run(async () => showHub(await page.call('register_project', { path: created })), 'Adding to Unity Hub'));
  page.on($('restart'), 'click', () => run(async () => { if (await page.call('restart_hub')) showHub({ ...hub, refreshPending: false, message: 'Unity Hub restarted. Check its Projects list.' }); }, 'Restarting Unity Hub'));
  page.on($('existing-path'), 'input', clearInspection);
  page.on($('approval'), 'change', controls);
  page.on($('inspect'), 'click', () => run(async () => {
    clearInspection();
    const path = $('existing-path').value;
    const revision = inspectionRevision;
    const result = await page.call('inspect_project', { path });
    if (revision !== inspectionRevision || path !== $('existing-path').value) throw new Error('Project selection changed during inspection. Inspect the current folder again.');
    inspection = result; $('existing-path').value = result.projectPath;
    const blockers = result.findings.filter(finding => finding.status === 'blocked').length;
    $('inspection-summary').textContent = blockers
      ? `${blockers} ${blockers === 1 ? 'blocker needs' : 'blockers need'} review. No project files were changed. Resolve each finding, then inspect again. For manual review, open this project from Unity Hub using its existing Editor version.`
      : result.canRepair && !result.canValidate
        ? 'Inspection complete. No project files were changed. Review the proposed changes; repairs are required before validation is available.'
        : 'Inspection complete. No project files were changed. Review the findings before approving a repair or validation.';
    const labels = { pass: ['Ready', 'feature-good'], blocked: ['Blocked', 'feature-warn'], repair: ['Repair available', 'feature-warn'], check: ['Needs Unity check', 'feature-note'] };
    $('findings').replaceChildren(...result.findings.map(finding => {
      const [label, style] = Object.hasOwn(labels, finding.status) ? labels[finding.status] : ['Review', 'feature-note'];
      const block = node('div', null, 'feature-section'); block.append(node('strong', `${finding.title}: ${label}`, style), node('p', finding.detail)); return block;
    }));
    $('changes').replaceChildren(...result.proposedChanges.map(change => node('li', change)));
  }, 'Inspecting project; no files changed'));
  async function existing(repair) {
    return run(async () => {
      if (!inspection || !$('approval').checked || !(repair ? inspection.canRepair : inspection.canValidate)) throw new Error('Inspect and approve the reviewed changes first.');
      const reviewed = inspection;
      $('inspection-summary').textContent = 'Operation in progress. The findings below describe the pre-operation inspection.';
      startActivity('existing', repair ? 'Repairing project' : 'Validating project', 'Preparing the settings backup.');
      try {
        const result = await page.call('run_existing_project', { request: { projectPath: reviewed.projectPath, fingerprint: reviewed.fingerprint, repair, approved: true } });
        lines($('existing-result'), [result.message, result.backupPath ? `Backup: ${result.backupPath}` : null, result.reportPath ? `Report: ${result.reportPath}` : null]);
        if (!result.success) throw new Error(result.message || 'Validation needs attention. Review the report.');
        completed = result.projectPath;
      } finally {
        inspection = null; $('approval').checked = false; operation = null; $('activity').hidden = true;
        $('inspection-summary').textContent = 'Inspect again before another repair or validation. The findings below describe the pre-operation inspection.';
      }
    }, repair ? 'Backing up and repairing' : 'Backing up and validating');
  }
  page.on($('repair'), 'click', () => existing(true));
  page.on($('validate'), 'click', () => existing(false));
  page.on($('open-existing'), 'click', () => run(() => page.call('open_project', { path: completed }), 'Opening project'));
  return Object.assign(page, {
    initialize: () => run(async () => renderEnvironment(await page.call('probe_environment')), 'Checking requirements'),
    event(name, value) {
      if (!operation || !page.busy() || !value || typeof value !== 'object') return;
      if (operation === 'existing' && name !== 'existing-progress') return;
      if (operation === 'create' && !['setup-progress', 'requirements-progress'].includes(name)) return;
      if (name === 'setup-progress') {
        if (!Number.isInteger(value.step) || value.step < stage || value.step < 1 || value.step > 7) return;
        stage = value.step; $('stage').textContent = `Stage ${stage} of 7`;
        $('progress').value = (stage - 1) / 7 * 100;
        if (value.environment) renderEnvironment(value.environment);
      } else {
        $('stage').textContent = text(value.stage || (operation === 'existing' ? 'Working in Unity' : 'Installing requirements'));
        if (typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) $('progress').value = value.percent;
        else $('progress').removeAttribute('value');
      }
      $('detail').textContent = text(value.detail);
      const transfer = value.transfer;
      const bytes = value => Number.isSafeInteger(value) && value >= 0;
      $('transfer').textContent = transfer && bytes(transfer.downloadedBytes) ? `${transfer.downloadedBytes.toLocaleString()} B${bytes(transfer.totalBytes) ? ` / ${transfer.totalBytes.toLocaleString()} B` : ''}${Number.isFinite(transfer.bytesPerSecond) && transfer.bytesPerSecond >= 0 ? ` · ${Math.round(transfer.bytesPerSecond).toLocaleString()} B/s` : ''}` : '';
    },
    help: [
      ['Which tool is this?', 'Project Setup creates and validates Creator SDK projects. MCP connects your AI client to an existing Unity project.'],
      ['What gets installed?', 'Setup checks the pinned Unity Editor, Android tools, Windows build support and URP recipe. Review native installation and licence prompts. Unity sign-in is yours to complete.'],
      ['Repair an existing project', 'Close it in Unity if requested. Inspect first, review the changes, then explicitly approve a backed-up repair or validation. Keep independent project backups.'],
      ['Setup stopped', 'Read the visible error and local report/log. Earlier completed steps may remain. Inspect the project before retrying; no failed operation is retried automatically.'],
    ],
  });
}
