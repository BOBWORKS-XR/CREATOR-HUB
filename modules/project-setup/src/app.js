const invoke = window.CreatorRuntime.invoke;

window.CreatorRuntime.listen('creator-lifecycle-close-blocked', () => {
  showActionError('Setup is still working. Wait for the operation to finish before closing it.');
}).catch(() => {});

const elements = {
  overall: document.querySelector('#overall-status'),
  projectName: document.querySelector('#project-name'),
  parentFolder: document.querySelector('#parent-folder'),
  browse: document.querySelector('#browse-button'),
  refresh: document.querySelector('#refresh-button'),
  create: document.querySelector('#create-button'),
  openProject: document.querySelector('#open-project-button'),
  createAnother: document.querySelector('#create-another-button'),
  actionError: document.querySelector('#action-error'),
  requirements: document.querySelector('#requirements'),
  blockers: document.querySelector('#blockers'),
  hub: document.querySelector('#hub-button'),
  unityDownload: document.querySelector('#unity-download-button'),
  platform: document.querySelector('#platform-label'),
  recipe: document.querySelector('#recipe-line'),
  activity: document.querySelector('#activity'),
  activityTitle: document.querySelector('#activity-title'),
  activityMessage: document.querySelector('#activity-message'),
  progressSteps: document.querySelector('#progress-steps'),
  elapsed: document.querySelector('#elapsed-time'),
  result: document.querySelector('#result'),
  sdkSource: document.querySelector('#sdk-source-button'),
};

let environment = null;
let createdProject = null;
let busy = false;
let creating = false;
let checking = false;
let opening = false;
let restartingHub = false;
let hubResult = null;
let mode = 'new';
let inspecting = false;
let existingReport = null;
let existingCompleted = null;
const existing = Object.fromEntries(['path', 'browse', 'approval', 'activity', 'stage', 'detail', 'elapsed', 'result'].map(name => [name, document.querySelector(`#existing-${name}`)]));
const inspectButton = document.querySelector('#inspect-button');
const repairButton = document.querySelector('#repair-button');
const validateButton = document.querySelector('#validate-button');
const retryHub = document.querySelector('#retry-hub-button');
const restartHub = document.querySelector('#restart-hub-button');
const newMode = document.querySelector('#new-mode');
const existingMode = document.querySelector('#existing-mode');
const stages = ['Check requirements', 'Prepare project', 'Import and compile', 'Configure Visual Scripting', 'Reopen and validate', 'Add to Unity Hub', 'Project ready'];
let currentStep = 0;

function renderProgress({ step, detail, environment: checkedEnvironment }) {
  if (!Number.isInteger(step) || step < currentStep || step < 1 || step > stages.length) return;
  if (checkedEnvironment) {
    renderEnvironment(checkedEnvironment);
    updateControls();
  }
  currentStep = step;
  document.querySelector('#stage-progress').value = step - 1;
  elements.activityTitle.textContent = stages[step - 1];
  elements.activityMessage.textContent = detail;
  elements.progressSteps.innerHTML = stages.map((label, index) => `<li class="${index + 1 < step ? 'done' : index + 1 === step ? 'current' : ''}" ${index + 1 === step ? 'aria-current="step"' : ''}>${label}</li>`).join('');
}

function updateControls() {
  const locked = busy || inspecting || checking || Boolean(createdProject);
  const showSummary = creating || Boolean(createdProject);
  document.querySelector('#project-details').classList.toggle('hidden', showSummary);
  document.querySelector('#project-summary').classList.toggle('hidden', !showSummary);
  if (showSummary) {
    document.querySelector('#summary-name').textContent = elements.projectName.value;
    document.querySelector('#summary-path').textContent = createdProject || elements.parentFolder.value;
  }
  for (const field of [elements.projectName, elements.parentFolder, elements.browse]) field.disabled = locked;
  const canBootstrap = environment && (environment.platform === 'windows' || environment.platform === 'linux');
  elements.create.disabled = locked || !environment || (!environment.ready && !canBootstrap);
  elements.create.textContent = environment && !environment.ready && canBootstrap ? 'Set up and create project' : 'Create and validate project';
  document.querySelector('#requirements-consent').classList.toggle('hidden', !environment || (environment.ready && environment.hubInstalled) || !canBootstrap);
  elements.create.classList.toggle('hidden', Boolean(createdProject));
  elements.openProject.classList.toggle('hidden', !createdProject);
  elements.openProject.disabled = opening;
  elements.createAnother.classList.toggle('hidden', !createdProject);
  elements.createAnother.disabled = opening || checking;
  elements.refresh.disabled = busy || inspecting || checking;
  for (const button of [newMode, existingMode]) button.disabled = busy || inspecting || opening || checking;
  existing.path.disabled = busy || inspecting;
  existing.browse.disabled = busy || inspecting;
  existing.approval.disabled = busy || inspecting;
  inspectButton.disabled = busy || inspecting || !existing.path.value.trim();
  repairButton.disabled = busy || inspecting || !existingReport?.canRepair || !existing.approval.checked;
  validateButton.disabled = busy || inspecting || !existingReport?.canValidate || !existing.approval.checked;
  retryHub.disabled = busy || inspecting || opening;
  restartHub.disabled = busy || inspecting || opening || checking;
  document.querySelector('#open-result-hub-button').disabled = busy || inspecting || opening;
  elements.createAnother.disabled = busy || opening || checking;
  for (const button of [elements.hub, elements.unityDownload]) button.disabled = busy || inspecting || checking;
  elements.openProject.disabled = busy || opening;
  document.querySelector('#open-existing-button').disabled = busy || opening;
  const label = mode === 'existing' ? busy ? 'Working in Unity' : inspecting ? 'Inspecting project' : existingCompleted ? 'Project validated' : existingReport ? 'Review findings' : 'Select a project'
    : busy ? restartingHub ? 'Restarting Unity Hub' : createdProject ? 'Adding to Unity Hub' : 'Creating project' : createdProject ? 'Project ready' : checking ? 'Checking' : environment?.ready ? 'Ready to create' : 'Setup required';
  const ready = mode === 'existing' ? Boolean(existingCompleted) : Boolean(createdProject || environment?.ready);
  const blocked = mode === 'existing' && existingReport?.findings.some(finding => finding.status === 'blocked');
  elements.overall.className = `overall-status ${blocked ? 'blocked' : !busy && !checking && !inspecting && ready ? 'ready' : 'checking'}`;
  elements.overall.innerHTML = `<span></span>${label}`;
}

function showActionError(error) {
  elements.actionError.textContent = String(error);
  elements.actionError.classList.remove('hidden');
}

function requirement(name, ok, value) {
  return `<div class="requirement ${ok ? 'ok' : 'bad'}">
    <span class="status-dot"></span><span class="requirement-name">${escapeHtml(name)}</span>
    <span class="requirement-value">${escapeHtml(value)}</span>
  </div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function renderEnvironment(report) {
  environment = report;
  const editor = report.editors.find(item => item.exactRecipe);
  elements.platform.textContent = report.platform;
  if (!elements.parentFolder.value && report.suggestedProjectParent) {
    elements.parentFolder.value = report.suggestedProjectParent;
  }
  elements.recipe.textContent = `Approved recipe: Unity ${report.recipe.editorVersion} · Creator SDK ${report.recipe.creatorSdkVersion} · URP ${report.recipe.urpVersion} · Input ${report.recipe.inputSystemVersion}`;
  elements.requirements.innerHTML = [
    requirement('Unity Hub or Unity CLI', report.hubInstalled || report.unityCliInstalled, report.hubInstalled ? report.hubVersion ? `Hub ${report.hubVersion}` : 'Hub detected' : report.unityCliInstalled ? 'CLI detected' : 'Missing'),
    requirement(`Unity ${report.recipe.editorVersion}`, Boolean(editor), editor ? 'Installed' : 'Missing'),
    ...(editor ? [
      requirement('Android Build Support', Boolean(editor.androidPlayer), editor.androidPlayer ? 'Installed' : 'Missing'),
      requirement('Android SDK, NDK and OpenJDK', Boolean(editor.androidSdk && editor.androidNdk && editor.openJdk), editor.androidSdk && editor.androidNdk && editor.openJdk ? 'Installed' : 'Incomplete'),
      requirement('Windows build support', Boolean(editor.windowsStandalone), editor.windowsStandalone ? 'Installed' : 'Missing'),
      requirement('Official 3D URP template', Boolean(editor.urpTemplate), editor.urpTemplate ? 'Available' : 'Missing'),
    ] : ['<p class="recipe-line">Will install: Android tools, Windows support and the URP template.</p>']),
  ].join('');
  if (!report.hubAutoRegistration) elements.requirements.innerHTML += '<p class="recipe-line">Automatic Hub registration is optional. It needs Hub 3.21.1 or newer; older Hub versions can add the finished project from disk.</p>';

  elements.blockers.classList.toggle('hidden', report.blockers.length === 0);
  elements.blockers.innerHTML = report.blockers.map(item => `<p>${escapeHtml(item)}</p>`).join('');
  elements.hub.classList.toggle('hidden', !report.hubInstalled || report.ready);
  elements.unityDownload.classList.toggle('hidden', report.hubInstalled || report.unityCliInstalled);
}

async function refresh() {
  if (busy || inspecting || checking) return;
  checking = true;
  updateControls();
  try {
    renderEnvironment(await invoke('probe_environment'));
  } catch (error) {
    environment = null;
    showActionError(error);
  } finally {
    checking = false;
    updateControls();
  }
}

elements.browse.addEventListener('click', async () => {
  if (busy || checking || createdProject) return;
  try {
    const folder = await invoke('pick_parent_folder');
    if (folder && !busy && !createdProject) elements.parentFolder.value = folder;
  } catch (error) { showActionError(error); }
});

elements.refresh.addEventListener('click', refresh);

elements.hub.addEventListener('click', async () => {
  try { await invoke('launch_hub'); } catch (error) { showActionError(error); }
});

elements.unityDownload.addEventListener('click', () => invoke('open_official_url', { url: 'https://unity.com/download' }).catch(showActionError));
const licenceUrls = { unity: 'https://unity.com/legal/editor-terms-of-service/software', android: 'https://developer.android.com/studio/terms', openjdk: 'https://openjdk.org/legal/gplv2+ce.html' };
for (const button of document.querySelectorAll('[data-terms]')) button.addEventListener('click', () => invoke('open_official_url', { url: licenceUrls[button.dataset.terms] }).catch(showActionError));
elements.sdkSource.addEventListener('click', () => invoke('open_official_url', { url: 'https://greenfield-registry.sdq.st/-/web/detail/com.sidequest.creator-sdk' }).catch(showActionError));
document.querySelector('#github-button').addEventListener('click', () => invoke('open_official_url', { url: 'https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP' }).catch(showActionError));

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (bytes >= 1000 && unit < units.length - 1) { bytes /= 1000; unit++; }
  return `${bytes.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

let transferUpdatedAt = null;
function renderTransfer(transfer) {
  transferUpdatedAt = transfer ? Date.now() : null;
  const container = document.querySelector('#download-metrics');
  container.classList.toggle('hidden', !transfer);
  const validBytes = value => Number.isSafeInteger(value) && value >= 0;
  const total = transfer && validBytes(transfer.totalBytes) && transfer.totalBytes > 0 ? transfer.totalBytes : null;
  const downloaded = transfer && validBytes(transfer.downloadedBytes) && (total === null || transfer.downloadedBytes <= total) ? transfer.downloadedBytes : null;
  const rate = transfer && typeof transfer.bytesPerSecond === 'number' && Number.isFinite(transfer.bytesPerSecond) && transfer.bytesPerSecond >= 0 ? transfer.bytesPerSecond : null;
  document.querySelector('#download-size').textContent = !transfer ? '' : total !== null
    ? downloaded !== null ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : `File size: ${formatBytes(total)}`
    : 'File size unavailable';
  const speed = document.querySelector('#download-speed');
  speed.textContent = !transfer ? '' : rate !== null && downloaded !== null ? `${transfer.estimated ? '~' : ''}${formatBytes(rate)}/s` : 'Speed unavailable';
  speed.title = transfer?.estimated ? 'Estimated from installer file growth over recent samples.' : '';
  const planned = transfer && validBytes(transfer.plannedBytes) && transfer.plannedBytes > 0 ? transfer.plannedBytes : null;
  document.querySelector('#download-plan').textContent = planned !== null ? `Editor + tools: ${formatBytes(planned)}` : '';
}

elements.create.addEventListener('click', async () => {
  const canBootstrap = environment && (environment.platform === 'windows' || environment.platform === 'linux');
  if (mode !== 'new' || busy || inspecting || checking || createdProject || !environment || (!environment.ready && !canBootstrap)) return;
  busy = true;
  creating = true;
  updateControls();
  elements.actionError.classList.add('hidden');
  elements.result.classList.add('hidden');
  elements.openProject.classList.add('hidden');
  elements.activity.classList.remove('hidden');
  renderTransfer(null);
  document.querySelector('#download-progress').classList.add('hidden');
  document.querySelector('#stage-progress').classList.remove('hidden');
  elements.progressSteps.classList.remove('hidden');
  currentStep = 0;
  renderProgress({ step: 1, detail: 'Checking project path and Unity requirements.' });
  const started = Date.now();
  const updateElapsed = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    elements.elapsed.textContent = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s elapsed`;
    if (transferUpdatedAt !== null && Date.now() - transferUpdatedAt > 3000) {
      document.querySelector('#download-speed').textContent = 'Waiting for download data';
    }
  };
  updateElapsed();
  const timer = setInterval(updateElapsed, 1000);
  let unlisten;
  let unlistenRequirements;
  try {
    unlistenRequirements = await window.CreatorRuntime.listen('requirements-progress', event => {
      const value = event.payload;
      elements.activityTitle.textContent = value.stage;
      elements.activityMessage.textContent = value.detail;
      document.querySelector('#stage-progress').classList.add('hidden');
      elements.progressSteps.classList.add('hidden');
      const download = document.querySelector('#download-progress');
      download.classList.remove('hidden');
      download.setAttribute('aria-label', value.transfer ? 'Current file download' : 'Unity reported progress');
      renderTransfer(value.transfer);
      if (typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) download.value = value.percent;
      else download.removeAttribute('value');
    });
    unlisten = await window.CreatorRuntime.listen('setup-progress', event => {
      renderTransfer(null);
      document.querySelector('#download-progress').classList.add('hidden');
      document.querySelector('#stage-progress').classList.remove('hidden');
      elements.progressSteps.classList.remove('hidden');
      renderProgress(event.payload);
    });
    const result = await invoke('create_project', { request: {
      projectName: elements.projectName.value,
      parentDirectory: elements.parentFolder.value,
    }});
    if (!result.success) throw new Error(result.message || 'Project validation failed.');
    createdProject = result.projectPath;
    renderHubResult(result.hub);
    elements.result.className = 'result success';
    elements.result.innerHTML = `<strong>Ready</strong><br>${escapeHtml(result.message)}<br><span>${escapeHtml(result.projectPath)}</span>`;
    elements.openProject.classList.remove('hidden');
  } catch (error) {
    elements.result.className = 'result';
    elements.result.innerHTML = `<strong>Setup stopped</strong><br>${escapeHtml(error)}`;
  } finally {
    clearInterval(timer);
    if (unlisten) unlisten();
    if (unlistenRequirements) unlistenRequirements();
    renderTransfer(null);
    try { renderEnvironment(await invoke('probe_environment')); } catch { /* Retain the failure and last known requirements. */ }
    busy = false;
    creating = false;
    elements.activity.classList.add('hidden');
    elements.result.classList.remove('hidden');
    updateControls();
  }
});

elements.openProject.addEventListener('click', async () => {
  if (!createdProject || opening || busy) return;
  opening = true;
  elements.actionError.classList.add('hidden');
  updateControls();
  try { await invoke('open_project', { path: createdProject }); }
  catch (error) { showActionError(error); }
  finally { opening = false; updateControls(); }
});

elements.createAnother.addEventListener('click', () => {
  if (opening || checking || busy) return;
  createdProject = null;
  hubResult = null;
  restartHub.classList.add('hidden');
  document.querySelector('#hub-result').classList.add('hidden');
  retryHub.classList.add('hidden');
  document.querySelector('#open-result-hub-button').classList.add('hidden');
  elements.projectName.value = '';
  elements.result.classList.add('hidden');
  elements.actionError.classList.add('hidden');
  updateControls();
  elements.projectName.focus();
});

window.CreatorUsageTerms.requireAcceptance().then(() => {
  document.querySelector('main').inert = false;
  refresh();
});

function renderHubResult(result) {
  hubResult = result;
  const element = document.querySelector('#hub-result');
  element.className = `hub-result${result?.registered && !result?.refreshPending ? '' : ' pending'}`;
  element.textContent = result?.message || 'Hub registration has not been verified. Your project is ready to open.';
  retryHub.classList.toggle('hidden', Boolean(result?.registered));
  retryHub.textContent = result?.requiresHubUpdate ? 'Recheck Hub and add project' : 'Retry adding to Unity Hub';
  const canRestartHub = environment && (environment.platform === 'windows' || environment.platform === 'linux');
  restartHub.classList.toggle('hidden', !result?.registered || !result?.refreshPending || !canRestartHub);
  if (result?.registered && result?.refreshPending && !canRestartHub) {
    element.textContent += ' Fully quit Hub, then choose Open Unity Hub.';
  }
  document.querySelector('#open-result-hub-button').classList.toggle('hidden', !environment?.hubInstalled);
}

restartHub.addEventListener('click', async () => {
  if (!createdProject || busy || inspecting || opening || checking || !hubResult?.registered || !hubResult?.refreshPending) return;
  const previous = hubResult;
  busy = true;
  restartingHub = true;
  elements.actionError.classList.add('hidden');
  document.querySelector('#hub-result').textContent = 'Waiting for restart confirmation...';
  updateControls();
  try {
    const restarted = await invoke('restart_hub');
    renderHubResult(restarted ? { ...previous, refreshPending: false, message: "Unity Hub restarted. Check its Projects list. Your Unity project is ready to open." } : previous);
  } catch (error) {
    renderHubResult(previous);
    showActionError(error);
  } finally {
    busy = false;
    restartingHub = false;
    updateControls();
  }
});

document.querySelector('#open-result-hub-button').addEventListener('click', async () => {
  if (!createdProject || busy || opening) return;
  try { await invoke('launch_hub'); } catch (error) { showActionError(error); }
});

retryHub.addEventListener('click', async () => {
  if (!createdProject || busy || opening) return;
  busy = true;
  updateControls();
  document.querySelector('#hub-result').textContent = 'Adding the project to Unity Hub...';
  try {
    renderHubResult(await invoke('register_project', { path: createdProject }));
    try { renderEnvironment(await invoke('probe_environment')); } catch (error) { showActionError(error); }
  }
  catch (error) { renderHubResult({ registered: false, message: String(error) }); }
  finally { busy = false; updateControls(); }
});

function setMode(value) {
  if (busy || inspecting || opening || checking) return;
  mode = value;
  const isNew = value === 'new';
  document.querySelector('#new-project-pane').classList.toggle('hidden', !isNew);
  document.querySelector('#existing-project-pane').classList.toggle('hidden', isNew);
  newMode.setAttribute('aria-selected', String(isNew));
  existingMode.setAttribute('aria-selected', String(!isNew));
  document.querySelector('#mode-description').textContent = isNew ? 'Unity and Creator SDK. Android + Windows.' : 'Packages, Visual Scripting and build requirements.';
  updateControls();
}
newMode.addEventListener('click', () => setMode('new'));
existingMode.addEventListener('click', () => setMode('existing'));
for (const [button, other] of [[newMode, existingMode], [existingMode, newMode]]) {
  button.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? newMode : event.key === 'End' ? existingMode : other;
      next.click(); next.focus();
    }
  });
}

function clearInspection() {
  existingReport = null;
  existingCompleted = null;
  existing.approval.checked = false;
  document.querySelector('#inspection-results').classList.add('hidden');
  document.querySelector('#open-existing-button').classList.add('hidden');
  existing.result.classList.add('hidden');
  updateControls();
}
existing.path.addEventListener('input', clearInspection);
existing.approval.addEventListener('change', updateControls);
existing.browse.addEventListener('click', async () => {
  if (busy || inspecting) return;
  try {
    const path = await invoke('pick_parent_folder');
    if (path && !busy && !inspecting) { existing.path.value = path; clearInspection(); }
  } catch (error) { existing.result.className = 'result'; existing.result.textContent = String(error); }
});

inspectButton.addEventListener('click', async () => {
  if (busy || inspecting || !existing.path.value.trim()) return;
  clearInspection();
  inspecting = true;
  existing.activity.classList.remove('hidden');
  existing.stage.textContent = 'Inspecting project files';
  existing.detail.textContent = 'No files are being changed.';
  existing.elapsed.textContent = '';
  updateControls();
  try {
    existingReport = await invoke('inspect_project', { path: existing.path.value });
    existing.path.value = existingReport.projectPath;
    document.querySelector('#inspection-results').classList.remove('hidden');
    const labels = { pass: 'Ready', blocked: 'Blocked', repair: 'Repair available', check: 'Needs Unity check' };
    document.querySelector('#inspection-findings').innerHTML = existingReport.findings.map(finding => `<div class="inspection-finding ${Object.hasOwn(labels, finding.status) ? finding.status : 'check'}"><strong>${escapeHtml(finding.title)}: ${labels[finding.status] || 'Review'}</strong><p>${escapeHtml(finding.detail)}</p></div>`).join('');
    document.querySelector('#repair-plan').classList.toggle('hidden', existingReport.proposedChanges.length === 0);
    document.querySelector('#repair-changes').innerHTML = existingReport.proposedChanges.map(change => `<li>${escapeHtml(change)}</li>`).join('');
    repairButton.classList.toggle('hidden', !existingReport.canRepair);
    validateButton.classList.toggle('hidden', !existingReport.canValidate);
    document.querySelector('#existing-approval-label').classList.toggle('hidden', !existingReport.canRepair && !existingReport.canValidate);
  } catch (error) { existing.result.className = 'result'; existing.result.textContent = String(error); }
  finally { inspecting = false; existing.activity.classList.add('hidden'); updateControls(); }
});

async function runExisting(repair) {
  if (busy || inspecting || !existingReport || !existing.approval.checked || !(repair ? existingReport.canRepair : existingReport.canValidate)) return;
  const reviewed = existingReport;
  busy = true;
  existing.result.classList.add('hidden');
  existing.activity.classList.remove('hidden');
  existing.stage.textContent = repair ? 'Repairing project' : 'Validating project';
  existing.detail.textContent = 'Preparing the settings backup.';
  const started = Date.now();
  const tick = () => { const seconds = Math.floor((Date.now() - started) / 1000); existing.elapsed.textContent = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s elapsed`; };
  tick();
  const timer = setInterval(tick, 1000);
  let unlisten;
  updateControls();
  try {
    unlisten = await window.CreatorRuntime.listen('existing-progress', event => { existing.detail.textContent = event.payload.detail; });
    const result = await invoke('run_existing_project', { request: { projectPath: reviewed.projectPath, fingerprint: reviewed.fingerprint, repair, approved: true } });
    existing.result.className = `result${result.success ? ' success' : ''}`;
    existing.result.innerHTML = `<strong>${result.success ? 'Validation passed' : 'Needs attention'}</strong><br>${escapeHtml(result.message)}<br>Backup: ${escapeHtml(result.backupPath)}<br>Report: ${escapeHtml(result.reportPath)}`;
    if (result.success) { existingCompleted = result.projectPath; document.querySelector('#open-existing-button').classList.remove('hidden'); }
  } catch (error) { existing.result.className = 'result'; existing.result.textContent = String(error); }
  finally {
    if (unlisten) unlisten();
    clearInterval(timer);
    existing.activity.classList.add('hidden');
    existingReport = null;
    existing.approval.checked = false;
    busy = false;
    updateControls();
  }
}
repairButton.addEventListener('click', () => runExisting(true));
validateButton.addEventListener('click', () => runExisting(false));
document.querySelector('#open-existing-button').addEventListener('click', async () => {
  if (!existingCompleted || busy || opening) return;
  opening = true; updateControls();
  try { await invoke('open_project', { path: existingCompleted }); }
  catch (error) { existing.result.className = 'result'; existing.result.textContent = String(error); }
  finally { opening = false; updateControls(); }
});
