(() => {
  const byId = id => document.getElementById(id);
  let snapshot = null;
  let busy = false;
  let retryProject = null;
  let lastError = '';
  let missingUnity = null;
  let revision = 0, loadedRevision = -1;
  let refreshQueued = false;
  const diagnostics = document.createElement('details');
  diagnostics.id = 'project-details'; diagnostics.className = 'catalog-status'; diagnostics.hidden = true;
  diagnostics.style.overflowWrap = 'anywhere';
  const diagnosticSummary = document.createElement('summary'); diagnosticSummary.textContent = 'Technical details';
  const errorDetail = document.createElement('p'); errorDetail.id = 'project-status-detail';
  const warnings = byId('project-warnings');
  warnings.before(diagnostics); diagnostics.append(diagnosticSummary, errorDetail, warnings);
  const openHub = document.createElement('button');
  openHub.id = 'open-project-unity-hub'; openHub.type = 'button'; openHub.className = 'text-button hidden'; openHub.hidden = true;
  openHub.innerHTML = '<span class="icon icon-external" aria-hidden="true"></span>Open Unity Hub';
  byId('project-recovery').prepend(openHub);
  const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function modifiedDate(project) {
    const value = project.modifiedAtMs;
    return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : null;
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function render() {
    byId('refresh-projects').disabled = busy;
    byId('add-project').disabled = busy;
    const prepare = byId('prepare-project-registry');
    prepare.classList.toggle('hidden', snapshot?.registryHelperPreparationAvailable !== true);
    prepare.disabled = busy;
    const failedProject = snapshot?.projects.find(project => project.id === retryProject);
    byId('project-recovery').classList.toggle('hidden', !failedProject);
    byId('retry-project-open').disabled = busy || Boolean(failedProject?.issue);
    byId('retry-project-open').title = failedProject ? `Try opening ${failedProject.name} again` : '';
    byId('refresh-project-recovery').disabled = busy;
    openHub.hidden = !missingUnity || !failedProject || window.CreatorHubNative?.integratedFeatures !== true;
    openHub.classList.toggle('hidden', openHub.hidden);
    openHub.disabled = busy || window.CreatorFeaturePages?.busy() === true;
    byId('view-projects').setAttribute('aria-busy', String(busy));
    const query = byId('project-search').value.trim().toLowerCase();
    const filter = byId('project-sdk').value;
    const sort = byId('project-sort').value;
    const projects = (snapshot?.projects || []).filter(project => {
      const sdkMatch = filter === 'all' || (filter === 'sdk' ? ['creator', 'banter', 'mixed'].includes(project.sdk) : project.sdk === filter || project.sdk === 'mixed');
      return sdkMatch && `${project.name} ${project.path}`.toLowerCase().includes(query);
    }).sort((a, b) => {
      if (sort === 'modified') {
        const first = modifiedDate(a);
        const second = modifiedDate(b);
        if (first !== second) return first === null ? 1 : second === null ? -1 : second - first;
      }
      return names.compare(a.name, b.name) || names.compare(a.path, b.path) || a.id.localeCompare(b.id);
    });
    const notices = [...new Set(snapshot?.warnings || [])].filter(warning => warning.trim() !== lastError.replace(/^Error: /, '').trim());
    warnings.textContent = notices.join(' '); warnings.hidden = !notices.length;
    errorDetail.textContent = lastError; errorDetail.hidden = !lastError;
    diagnostics.hidden = !lastError && !notices.length;
    const rows = projects.map(project => {
      const row = element('div', '', 'project-row');
      row.dataset.mcpSelected = String(project.selected === true);
      const info = element('div', '', 'project-info');
      info.append(element('strong', project.name), element('small', project.path));
      const tags = element('div', '', 'project-tags');
      tags.append(element('span', project.sdkLabel, `sdk-label sdk-${project.sdk}`), element('span', project.unityVersion ? `Unity ${project.unityVersion}` : 'Version unknown'), element('span', project.source));
      if (project.selected === true) tags.append(element('span', 'Selected for MCP', 'project-selected'));
      if (project.bridge || window.CreatorHubNative?.integratedFeatures === true) {
        const bridge = project.bridge || {};
        const checked = typeof bridge.installed === 'boolean' && typeof bridge.current === 'boolean' && (!bridge.current || bridge.installed);
        const bridgeStatus = element('span', !checked ? 'MCP bridge not checked' : bridge.current ? 'MCP bridge current' : bridge.installed ? 'MCP bridge update available' : 'MCP bridge not installed', checked && bridge.current ? 'project-bridge-current' : 'project-bridge-warning');
        bridgeStatus.title = 'The MCP bridge connects AI tools. It is not required to open this project in Unity.';
        tags.append(bridgeStatus);
      }
      const modified = modifiedDate(project);
      const date = element('span', modified === null ? 'Modified date unavailable' : `Modified ${dateFormat.format(modified)}`, 'project-modified');
      tags.append(date);
      info.append(tags);
      if (project.issue) info.append(element('p', project.issue, 'project-issue'));
      const actions = element('div', '', 'project-actions');
      const open = element('button', '', 'primary-button project-open');
      const openIcon = element('span', '', 'icon icon-arrow');
      openIcon.setAttribute('aria-hidden', 'true');
      open.append(openIcon, element('span', 'Open'));
      open.type = 'button'; open.setAttribute('aria-label', `Open ${project.name}`);
      open.disabled = busy || Boolean(project.issue);
      open.addEventListener('click', () => run('open_unity_project', { id: project.id }));
      actions.append(open);
      if (project.added) {
        const remove = element('button', '', 'icon-button'); remove.type = 'button';
        remove.title = 'Remove from saved list; project files are kept';
        remove.setAttribute('aria-label', `Remove ${project.name} from saved list`);
        const icon = element('span', '', 'icon icon-close'); icon.setAttribute('aria-hidden', 'true'); remove.append(icon);
        remove.disabled = busy;
        remove.addEventListener('click', () => run('remove_project_folder', { id: project.id })); actions.append(remove);
      }
      row.append(info, actions); return row;
    });
    byId('project-list').replaceChildren(...rows);
    if (!projects.length && !busy) byId('project-list').append(element('p', snapshot?.projects?.length ? 'No matching projects.' : 'No projects found. Add a project folder to get started.', 'project-empty'));
  }
  async function run(command, args = {}) {
    if (busy) return;
    const requestedRevision = revision;
    if (command !== 'open_unity_project' || retryProject !== args.id) retryProject = null;
    lastError = ''; missingUnity = null; diagnostics.open = false;
    busy = true; render();
    byId('project-status').textContent = command === 'project_inventory' ? 'Reading known project locations...' : command === 'prepare_project_registry' ? 'Preparing verified Unity registry discovery...' : command === 'open_unity_project' ? 'Checking Unity version and project lock...' : 'Updating saved list...';
    try {
      const result = await window.CreatorHubNative.invoke(command, args);
      if (result && typeof result === 'object') {
        if (!Array.isArray(result.projects) || !Array.isArray(result.warnings)) throw new Error('Project list response was invalid.');
        snapshot = result;
        loadedRevision = requestedRevision;
        byId('project-status').textContent = `${result.projects.length} known projects.${result.warnings.length ? ' Some locations could not be checked. See Technical details.' : ''}`;
      } else byId('project-status').textContent = result || 'No project added.';
      retryProject = null;
    } catch (reason) {
      lastError = String(reason);
      if (command === 'open_unity_project') {
        retryProject = args.id;
        const version = snapshot?.projects.find(project => project.id === args.id)?.unityVersion;
        const expected = `Unity ${version} is not available. Install this exact version in Unity Hub, then retry. No project upgrade was attempted.`;
        if (typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+[abfp][0-9]+$/.test(version) && lastError === expected) missingUnity = version;
      }
      byId('project-status').textContent = missingUnity
        ? `Unity ${missingUnity} is needed. Install this version in Unity Hub, then try opening again. Your project version has not changed.`
        : command === 'open_unity_project' ? 'Could not open this project. Check the technical details, then try again.'
        : command === 'prepare_project_registry' ? 'Could not prepare project discovery. Check the technical details, then try again.'
        : 'Could not refresh the project list. Your saved projects are kept. Try again or check the technical details.';
    }
    finally {
      busy = false; render();
      const queued = refreshQueued; refreshQueued = false;
      if (queued && requestedRevision !== revision && !byId('view-projects').classList.contains('hidden')
        && window.CreatorFeaturePages?.busy() !== true) void run('project_inventory');
    }
  }
  byId('refresh-projects').addEventListener('click', () => run('project_inventory'));
  openHub.addEventListener('click', async () => {
    if (openHub.hidden || busy || window.CreatorFeaturePages?.busy()) return;
    busy = true; render();
    try {
      await window.CreatorHubNative.invoke('feature_call', { feature: 'setup', command: 'launch_hub', args: {} });
      byId('project-status').textContent = `Unity Hub launch requested. Install Unity ${missingUnity}, then try opening the project again.`;
    } catch (reason) {
      lastError = String(reason); diagnostics.open = false;
      byId('project-status').textContent = 'Could not open Unity Hub. Check the technical details, then try again.';
    } finally { busy = false; render(); }
  });
  byId('prepare-project-registry').addEventListener('click', () => run('prepare_project_registry'));
  byId('retry-project-open').addEventListener('click', () => {
    if (retryProject) void run('open_unity_project', { id: retryProject });
  });
  byId('refresh-project-recovery').addEventListener('click', () => run('project_inventory'));
  byId('add-project').addEventListener('click', () => run('add_project_folder'));
  byId('project-search').addEventListener('input', render);
  byId('project-sdk').addEventListener('change', render);
  byId('project-sort').addEventListener('change', render);
  window.CreatorProjects = Object.freeze({
    invalidate: () => { revision++; },
    show: () => {
      if (window.CreatorFeaturePages?.busy() === true || (snapshot && loadedRevision === revision)) return;
      if (busy) refreshQueued = true;
      else void run('project_inventory');
    },
  });
})();
