(() => {
  const dialog = document.querySelector('#connection-guide-dialog');
  const workspace = document.querySelector('#guideWorkspace');
  const welcome = document.querySelector('#connection-guide-welcome');
  const next = document.querySelector('#connection-guide-next');
  const check = document.querySelector('#connection-guide-check');
  const skip = document.querySelector('#connection-guide-skip');
  const error = document.querySelector('#connection-guide-error');
  let controller;
  let placeholder;
  let section;
  function restore() {
    if (placeholder) { placeholder.replaceWith(section); placeholder = null; }
    workspace.hidden = true;
  }
  function close() {
    if (controller?.busy()) return;
    restore(); dialog.close();
  }
  function form(repair) {
    if (controller.busy()) return;
    welcome.hidden = true; workspace.hidden = false; next.hidden = false; check.hidden = false;
    if (!placeholder) {
      placeholder = document.createComment('Quick Setup home');
      section.before(placeholder); workspace.append(section);
    }
    document.querySelector('#connection-guide-title').textContent = repair ? 'Check your Unity connection' : 'Set up your Unity connection';
    update(controller.snapshot());
    document.querySelector('#projectPath').focus();
  }
  function update(status) {
    if (!controller || !dialog.open || !placeholder) return;
    const steps = [];
    if (!status?.runtime?.ready) steps.push('The private runtime is unavailable. Repair or reinstall Creator Hub; do not close unrelated Node processes.');
    if (!status?.project?.valid) steps.push('Select the Unity project folder containing Assets, Packages and ProjectSettings. Use Project Setup first if you need a new project.');
    else if (!status.project.bridgeCurrent) steps.push('Review and apply setup to add or update the Unity bridge.');
    else if (status.project.stateStatus !== 'fresh') steps.push('Open this project in Unity, let it compile, then check again. Fix Console compile errors before retrying.');
    else steps.push('Unity bridge is responding. This does not yet prove that your AI client has loaded MCP.');
    const configured = status?.clients?.filter(client => client.configured).map(client => client.name || client.id) || [];
    steps.push(configured.length ? 'Saved client settings: ' + configured.join(', ') + '. Fully quit and reopen any changed client.' : 'Choose the AI client you use, then review and apply setup. The Claude website is not Claude Desktop.');
    for (const client of status?.clients || []) if (client.issue && client.supported !== false) steps.push((client.name || client.id) + ': ' + client.issue);
    steps.push('In your AI client, ask: "Call get_bridge_status for this Unity project and report whether it is ready." If the tool is missing, use Help & troubleshooting.');
    next.replaceChildren();
    const list = document.createElement('ol');
    for (const text of steps) { const item = document.createElement('li'); item.textContent = text; list.append(item); }
    next.append(list);
  }
  document.querySelector('#connection-guide-start').addEventListener('click', () => form(false));
  document.querySelector('#connection-guide-repair').addEventListener('click', () => form(true));
  document.querySelector('#connection-guide-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  skip.addEventListener('click', async () => {
    if (!controller || controller.busy()) return;
    skip.disabled = true;
    try { await controller.remember(); close(); }
    catch { error.textContent = 'Could not save your preference. You can close this guide for now; your connections were not changed.'; }
    finally { skip.disabled = false; }
  });
  check.addEventListener('click', () => { if (!controller.busy()) void controller.check(); });
  document.querySelector('#connection-guide-help').addEventListener('click', () => document.querySelector('#context-help-dialog').showModal());
  function open() {
    if (!controller || controller.busy() || window.CreatorRuntime.disconnected) return;
    restore(); welcome.hidden = false; next.hidden = true; check.hidden = true; error.textContent = '';
    document.querySelector('#connection-guide-title').textContent = 'Connect your AI to Unity';
    if (!dialog.open) dialog.showModal();
  }
  function confirm(id, acceptId, declineId) {
    const modal = document.getElementById(id);
    modal.showModal();
    return new Promise(resolve => {
      const accept = () => done(true);
      const decline = () => done(false);
      const cancel = event => { event.preventDefault(); done(false); };
      function done(value) {
        modal.close();
        document.getElementById(acceptId).removeEventListener('click', accept);
        document.getElementById(declineId).removeEventListener('click', decline);
        modal.removeEventListener('cancel', cancel);
        resolve(value);
      }
      document.getElementById(acceptId).addEventListener('click', accept);
      document.getElementById(declineId).addEventListener('click', decline);
      modal.addEventListener('cancel', cancel);
    });
  }
  window.CreatorConnectionGuide = Object.freeze({
    initialize(options) {
      controller = options; section = document.querySelector('.setup-section');
      document.querySelector('#connectionGuideBtn').addEventListener('click', open);
      if (options.suggest) open();
    },
    update, open,
    review(summary) {
      document.querySelector('#connection-review-summary').textContent = summary;
      return confirm('connection-review-dialog', 'connection-review-apply', 'connection-review-cancel');
    },
    async cliConsent() {
      const checkbox = document.querySelector('#unity-cli-consent-checkbox');
      const button = document.querySelector('#unity-cli-accept');
      checkbox.checked = false; button.disabled = true;
      const change = () => { button.disabled = !checkbox.checked; };
      checkbox.addEventListener('change', change);
      try { return await confirm('unity-cli-consent-dialog', 'unity-cli-accept', 'unity-cli-decline') && checkbox.checked; }
      finally { checkbox.removeEventListener('change', change); }
    },
  });
})();
