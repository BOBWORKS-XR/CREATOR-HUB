(() => {
  let active;
  const stages = new Set(['review', 'backed-up', 'connections-reviewed']);

  function report(value) {
    const text = (item, limit = 4096) => typeof item === 'string' && item.length <= limit;
    const list = items => Array.isArray(items) && items.length <= 64 && items.every(item => text(item));
    if (!value || typeof value.enabled !== 'boolean' || typeof value.required !== 'boolean'
      || !stages.has(value.stage) || !list(value.settings) || !list(value.backups)
      || !text(value.message, 8192) || !Array.isArray(value.legacyApps) || value.legacyApps.length > 8
      || !value.legacyApps.every(app => app && text(app.name, 512) && text(app.path))) {
      throw new Error('The native migration report could not be verified. Existing apps are kept.');
    }
    return { enabled: value.enabled, required: value.required, stage: value.stage,
      settings: [...value.settings], backups: [...value.backups], message: value.message,
      legacyApps: value.legacyApps.map(app => ({ name: app.name, path: app.path })) };
  }

  function run() {
    if (active) return active;
    const native = window.CreatorHubNative;
    if (native?.convergencePersistence !== true || typeof native.invoke !== 'function') return Promise.resolve();
    let resolve, reject;
    const completion = new Promise((done, failed) => { resolve = done; reject = failed; });
    active = completion;

    async function begin() {
      let current, initialError;
      try { current = report(await native.invoke('convergence_status')); }
      catch (reason) { initialError = reason; }
      if (!initialError && (!current.enabled || !current.required)) {
        active = undefined; resolve(); return;
      }
      const ids = ['dialog', 'title', 'summary', 'details', 'error', 'prepare', 'connections', 'later'];
      const elements = Object.fromEntries(ids.map(id => [id, document.querySelector(`#convergence-${id}`)]));
      if (Object.values(elements).some(node => !node)) throw new Error('The migration guide is unavailable. Existing apps are kept.');
      const { dialog, title, summary, details, error, prepare, connections, later } = elements;
      const locked = [...document.body.children].filter(node => node !== dialog && !node.inert);
      const previousFocus = document.activeElement;
      let busy = false, ended = false;
      prepare.textContent = 'Back up and continue';
      connections.textContent = 'Move existing connections';
      later.textContent = 'Keep existing apps for now';
      error.hidden = true; error.textContent = '';

      function showError(reason) {
        error.textContent = `Migration could not continue: ${String(reason).slice(0, 2000)}`;
        error.hidden = false;
      }
      function render() {
        const stage = current?.stage || 'review';
        title.textContent = stage === 'review' ? 'Move to unified Creator Hub'
          : stage === 'backed-up' ? 'Review existing connections' : 'Connections reviewed';
        summary.textContent = stage === 'connections-reviewed'
          ? current.legacyApps.length ? 'Standalone apps remain installed. Cleanup verification is still pending.'
            : 'Connection review is recorded. Cleanup verification is still pending.'
          : current?.message || 'Existing apps and settings are kept until native review succeeds.';
        const rows = [];
        for (const item of current?.settings || []) rows.push(`Settings: ${item}`);
        for (const app of current?.legacyApps || []) rows.push(`Standalone app: ${app.name} - ${app.path}`);
        for (const item of current?.backups || []) rows.push(`Backup: ${item}`);
        details.replaceChildren(...rows.map(value => {
          const item = document.createElement('li'); item.textContent = value; return item;
        }));
        const writable = current?.enabled === true && current.required === true;
        prepare.hidden = stage !== 'review';
        connections.hidden = stage !== 'backed-up';
        prepare.disabled = busy || !writable || stage !== 'review';
        connections.disabled = busy || !writable || stage !== 'backed-up';
        later.disabled = busy;
        dialog.setAttribute('aria-busy', String(busy));
      }
      function release() {
        dialog.removeEventListener('cancel', cancel);
        prepare.removeEventListener('click', prepareClick);
        connections.removeEventListener('click', connectionsClick);
        later.removeEventListener('click', laterClick);
        locked.forEach(node => { node.inert = false; });
        active = undefined;
      }
      function cancel(event) { event.preventDefault(); }
      function laterClick(event) {
        event.preventDefault();
        if (ended || busy || later.disabled || !dialog.open) return;
        ended = true; dialog.close(); release();
        if (previousFocus?.isConnected && !previousFocus.inert) previousFocus.focus({ preventScroll: true });
        resolve();
      }
      async function change(command, from, to) {
        if (ended || busy || !dialog.open || current?.stage !== from
          || current.enabled !== true || current.required !== true) return;
        if (window.CreatorHubNative !== native || native.convergencePersistence !== true) {
          showError('Native migration support changed. Existing apps are kept.'); return;
        }
        busy = true; error.hidden = true; error.textContent = ''; render();
        try {
          const next = report(await native.invoke(command));
          if (![from, to].includes(next.stage)) throw new Error('The native migration phase changed unexpectedly. Review again before continuing.');
          current = next;
        } catch (reason) { showError(reason); }
        finally { busy = false; render(); }
      }
      function prepareClick(event) {
        event.preventDefault(); void change('prepare_convergence', 'review', 'backed-up');
      }
      function connectionsClick(event) {
        event.preventDefault(); void change('migrate_convergence_connections', 'backed-up', 'connections-reviewed');
      }
      dialog.addEventListener('cancel', cancel);
      prepare.addEventListener('click', prepareClick);
      connections.addEventListener('click', connectionsClick);
      later.addEventListener('click', laterClick);
      locked.forEach(node => { node.inert = true; });
      render();
      if (initialError) showError(initialError);
      try { dialog.showModal(); }
      catch (reason) { release(); throw reason; }
    }
    void begin().catch(reason => { active = undefined; reject(reason); });
    return completion;
  }

  window.CreatorConvergence = Object.freeze({ run });
})();
