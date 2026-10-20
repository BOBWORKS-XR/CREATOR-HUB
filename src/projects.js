(() => {
  const byId = id => document.getElementById(id);
  let snapshot = null;
  let busy = false;
  let revision = 0, loadedRevision = -1;
  let refreshQueued = false;
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
    const status = byId('project-status').textContent.replace(/^Error: /, '').trim();
    const warnings = [...new Set(snapshot?.warnings || [])].filter(warning => warning.trim() !== status);
    byId('project-warnings').textContent = warnings.join(' ');
    byId('project-warnings').hidden = !warnings.length;
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
        tags.append(element('span', !checked ? 'MCP bridge not checked' : bridge.current ? 'MCP bridge current' : bridge.installed ? 'MCP bridge update available' : 'MCP bridge not installed', checked && bridge.current ? 'project-bridge-current' : 'project-bridge-warning'));
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
    busy = true; render();
    byId('project-status').textContent = command === 'project_inventory' ? 'Reading known project locations...' : command === 'prepare_project_registry' ? 'Preparing verified Unity registry discovery...' : command === 'open_unity_project' ? 'Checking Unity version and project lock...' : 'Updating saved list...';
    try {
      const result = await window.CreatorHubNative.invoke(command, args);
      if (result && typeof result === 'object') {
        if (!Array.isArray(result.projects) || !Array.isArray(result.warnings)) throw new Error('Project list response was invalid.');
        snapshot = result;
        loadedRevision = requestedRevision;
        byId('project-status').textContent = `${result.projects.length} known projects. SDK labels reflect package declarations, not build validation.`;
      } else byId('project-status').textContent = result || 'No project added.';
    } catch (reason) { byId('project-status').textContent = String(reason); }
    finally {
      busy = false; render();
      const queued = refreshQueued; refreshQueued = false;
      if (queued && requestedRevision !== revision && !byId('view-projects').classList.contains('hidden')
        && window.CreatorFeaturePages?.busy() !== true) void run('project_inventory');
    }
  }
  byId('refresh-projects').addEventListener('click', () => run('project_inventory'));
  byId('prepare-project-registry').addEventListener('click', () => run('prepare_project_registry'));
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
