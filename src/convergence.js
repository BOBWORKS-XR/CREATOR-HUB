(() => {
  let active;
  let resumeButton;
  const REMINDER = 'creator-hub.convergence-reminder-v1';
  const stages = new Set(['review', 'backed-up', 'connections-reviewed', 'complete']);

  function report(value) {
    const text = (item, limit = 4096) => typeof item === 'string' && item.length <= limit;
    const list = items => Array.isArray(items) && items.length <= 64 && items.every(item => text(item));
    if (!value || typeof value.enabled !== 'boolean' || typeof value.required !== 'boolean'
      || !stages.has(value.stage) || !list(value.settings) || !list(value.backups)
      || !text(value.message, 8192) || !Array.isArray(value.legacyApps) || value.legacyApps.length > 8
      || !value.legacyApps.every(app => app && text(app.name, 512) && text(app.path))
      || (value.retirementAvailable !== undefined && typeof value.retirementAvailable !== 'boolean')
      || (value.streamlined !== undefined && typeof value.streamlined !== 'boolean')
      || (value.moveAvailable !== undefined && typeof value.moveAvailable !== 'boolean')
      || (value.settingsImportAvailable !== undefined && typeof value.settingsImportAvailable !== 'boolean')
      || (value.recoveryHelp != null && !text(value.recoveryHelp, 16384))
      || (value.reviewKey != null && (typeof value.reviewKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.reviewKey)))
      || (value.stage === 'complete' && (value.required || value.retirementAvailable === true || value.legacyApps.length))) {
      throw new Error('The native migration report could not be verified. Existing apps are kept.');
    }
    return { enabled: value.enabled, required: value.required, stage: value.stage,
      streamlined: value.streamlined === true,
      moveAvailable: value.moveAvailable !== false,
      settingsImportAvailable: value.settingsImportAvailable === true,
      settings: [...value.settings], backups: [...value.backups], message: value.message,
      reviewKey: value.reviewKey || null,
      recoveryHelp: value.recoveryHelp || null,
      retirementAvailable: value.retirementAvailable === true,
      legacyApps: value.legacyApps.map(app => ({ name: app.name, path: app.path })) };
  }

  function reminderMatches(key) {
    if (!key) return false;
    try {
      const raw = window.localStorage.getItem(REMINDER);
      if (!raw || raw.length > 256) return false;
      const saved = JSON.parse(raw);
      return saved?.schemaVersion === 1 && saved.reviewKey === key
        && Object.keys(saved).sort().join(',') === 'reviewKey,schemaVersion';
    } catch { return false; }
  }

  function run(manual = false) {
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
      if (!initialError && (!current.enabled || (!current.required && !current.settingsImportAvailable && !current.recoveryHelp))) {
        const reopen = resumeButton || (current.streamlined && document.querySelector('#convergence-reopen'));
        if (reopen) { reopen.hidden = true; reopen.style?.setProperty('display', 'none'); }
        active = undefined; resolve(); return;
      }
      const reopen = document.querySelector('#convergence-reopen');
      if (reopen) {
        reopen.hidden = false;
        reopen.style?.removeProperty('display');
        if (resumeButton !== reopen) {
          resumeButton = reopen;
          reopen.addEventListener('click', () => {
            void run(true).catch(() => { reopen.title = 'Migration review could not open. Restart Hub to try again.'; });
          });
        }
      }
      if (!manual && !initialError && reopen && reminderMatches(current.reviewKey)) {
        active = undefined; resolve(); return;
      }
      const ids = ['dialog', 'title', 'summary', 'details', 'error', 'prepare', 'connections', 'retire', 'refresh', 'later'];
      const elements = Object.fromEntries(ids.map(id => [id, document.querySelector(`#convergence-${id}`)]));
      if (Object.values(elements).some(node => !node)) throw new Error('The migration guide is unavailable. Existing apps are kept.');
      const { dialog, title, summary, details, error, prepare, connections, retire, refresh, later } = elements;
      const streamlined = current?.streamlined === true || (!current && native.integratedFeatures === true);
      const settingsOnly = current?.required === false && current.settingsImportAvailable;
      if (reopen) reopen.textContent = settingsOnly ? 'Review saved MCP settings' : 'Review migration';
      const move = streamlined && document.querySelector('#convergence-move');
      const progress = streamlined && document.querySelector('#convergence-progress');
      const explanation = document.querySelector('#convergence-explanation');
      const importExplanation = document.querySelector('#convergence-import-explanation');
      const backupDetails = document.querySelector('#convergence-backups');
      const recovery = document.querySelector('#convergence-recovery');
      const recoveryText = document.querySelector('#convergence-recovery-text');
      const copyRecovery = document.querySelector('#convergence-copy-recovery');
      const copyStatus = document.querySelector('#convergence-copy-status');
      if (streamlined && (!move || !progress || !explanation || !backupDetails)) throw new Error('The migration guide is unavailable. Existing apps are kept.');
      if (explanation) explanation.hidden = !streamlined;
      const locked = [...document.body.children].filter(node => node !== dialog && !node.inert);
      const previousFocus = document.activeElement;
      let busy = false, ended = false, reminderSaveFailed = false, stopped = false, phase = '', result = '', unlisten;
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
          : stage === 'backed-up' ? 'Review existing connections'
          : stage === 'complete' ? 'Migration complete' : 'Connections reviewed';
        summary.textContent = stage === 'complete' ? current.message : stage === 'connections-reviewed'
          ? current.retirementAvailable ? 'Backups and connections are reviewed. Finish migration to retire the verified standalone app entries.'
            : current.legacyApps.length ? 'Standalone apps remain installed. Cleanup verification is still pending.'
            : 'Connection review is recorded. Cleanup verification is still pending.'
          : current?.message || 'Existing apps and settings are kept until native review succeeds.';
        const rows = [];
        if (stage === 'connections-reviewed' && current?.message) rows.push(`Cleanup check: ${current.message}`);
        for (const item of current?.settings || []) rows.push(`Settings: ${item}`);
        for (const app of current?.legacyApps || []) rows.push(`Standalone app: ${app.name} - ${app.path}`);
        for (const item of current?.backups || []) rows.push(`Backup: ${item}`);
        details.replaceChildren(...rows.map(value => {
          const item = document.createElement('li'); item.textContent = value; return item;
        }));
        const writable = current?.enabled === true && (current.required === true || (settingsOnly && current.settingsImportAvailable));
        prepare.hidden = stage !== 'review';
        connections.hidden = stage !== 'backed-up';
        retire.hidden = stage !== 'connections-reviewed' || !current?.retirementAvailable;
        refresh.hidden = stage === 'complete' || (!current && error.hidden);
        prepare.disabled = busy || !writable || stage !== 'review';
        connections.disabled = busy || !writable || stage !== 'backed-up';
        retire.disabled = busy || !writable || stage !== 'connections-reviewed' || !current?.retirementAvailable;
        refresh.disabled = busy;
        later.textContent = stage === 'complete' ? 'Continue in Hub'
          : reminderSaveFailed ? 'Continue without saving reminder' : 'Continue for now';
        later.disabled = busy;
        dialog.setAttribute('aria-busy', String(busy));
        if (recovery && recoveryText && copyRecovery && copyStatus) {
          recovery.hidden = !current?.recoveryHelp || stage === 'complete';
          recoveryText.value = current?.recoveryHelp || '';
          copyRecovery.disabled = busy || recovery.hidden;
          copyStatus.textContent = '';
        }
        if (importExplanation) importExplanation.hidden = !settingsOnly || stage !== 'review';
        if (streamlined && !settingsOnly) {
          title.textContent = stage === 'complete' ? 'Move complete' : current?.recoveryHelp ? 'Migration needs review' : 'Move to Hub';
          summary.textContent = stage === 'complete' ? 'Your existing setup is now managed in Creator Hub.'
            : current?.recoveryHelp ? 'Settings and backups are kept. Migration has not completed.'
            : 'Move existing settings and AI connections into Creator Hub.';
          explanation.hidden = Boolean(current?.recoveryHelp);
          if (backupDetails) backupDetails.hidden = !details.childElementCount;
          prepare.hidden = connections.hidden = retire.hidden = true;
          move.hidden = stage === 'complete' || stopped || stage !== 'review' || !current?.moveAvailable;
          move.disabled = busy || !writable || stopped || !current?.moveAvailable;
          later.textContent = stage === 'complete' ? 'Continue in Hub' : 'Not now';
          refresh.hidden = busy || stage === 'complete' || (!stopped && stage === 'review' && current?.moveAvailable);
          refresh.textContent = 'Review retained state';
          const phases = { review: 'Waiting for native review...', backup: 'Backing up settings and adding missing projects...',
            connections: 'Moving existing connections...', cleanup: 'Checking standalone app cleanup...' };
          progress.textContent = busy ? phases[phase] || phases.review : stopped ? '' : result || (stage !== 'review' || !current?.moveAvailable ? current?.message || '' : '');
          progress.hidden = !progress.textContent;
        }
        if (settingsOnly) {
          const imported = stage === 'backed-up' && !current.settingsImportAvailable;
          title.textContent = imported ? 'Saved MCP projects imported' : 'Import saved MCP projects';
          summary.textContent = imported
            ? 'Current preferences and project selection were kept. Original settings are backed up.'
            : 'Combine your saved MCP project lists while keeping your current preferences.';
          if (explanation) explanation.hidden = true;
          if (backupDetails) backupDetails.hidden = !details.childElementCount;
          if (move) move.hidden = true;
          if (progress) progress.hidden = true;
          connections.hidden = retire.hidden = true;
          prepare.hidden = imported || !current?.settingsImportAvailable;
          prepare.textContent = 'Back up and import projects';
          refresh.hidden = imported || (error.hidden && current.settingsImportAvailable);
          refresh.textContent = 'Check again';
          later.textContent = imported ? 'Continue in Hub' : reminderSaveFailed ? 'Continue without saving reminder' : 'Not now';
        }
      }
      function release() {
        dialog.removeEventListener('cancel', cancel);
        prepare.removeEventListener('click', prepareClick);
        connections.removeEventListener('click', connectionsClick);
        retire.removeEventListener('click', retireClick);
        refresh.removeEventListener('click', refreshClick);
        later.removeEventListener('click', laterClick);
        if (move) move.removeEventListener('click', moveClick);
        copyRecovery?.removeEventListener('click', copyRecoveryClick);
        if (typeof unlisten === 'function') unlisten();
        locked.forEach(node => { node.inert = false; });
        active = undefined;
      }
      function cancel(event) {
        event.preventDefault();
        if (streamlined && !busy) laterClick(event);
      }
      function laterClick(event) {
        event.preventDefault();
        if (ended || busy || later.disabled || !dialog.open) return;
        const imported = settingsOnly && current?.stage === 'backed-up' && !current.settingsImportAvailable;
        if (current?.stage !== 'complete' && !imported && current?.reviewKey && reopen && !reminderSaveFailed) {
          try {
            window.localStorage.setItem(REMINDER, JSON.stringify({ schemaVersion: 1, reviewKey: current.reviewKey }));
            if (!reminderMatches(current.reviewKey)) throw new Error('Reminder readback failed');
          } catch {
            reminderSaveFailed = true;
            showError('Your reminder choice could not be saved. Migration is still pending; the guide may appear again next time. Your settings were not changed.');
            render(); return;
          }
        }
        if ((current?.stage === 'complete' || imported) && reopen) {
          reopen.hidden = true;
          reopen.style?.setProperty('display', 'none');
        }
        ended = true; dialog.close(); release();
        if (previousFocus?.isConnected && !previousFocus.inert) previousFocus.focus({ preventScroll: true });
        resolve();
      }
      async function change(command, from, to) {
        if (ended || busy || !dialog.open || current?.stage !== from
          || current.enabled !== true || (!current.required && !(settingsOnly && current.settingsImportAvailable))) return;
        if (window.CreatorHubNative !== native || native.convergencePersistence !== true) {
          showError('Native migration support changed. Existing apps are kept.'); return;
        }
        busy = true; error.hidden = true; error.textContent = ''; render();
        try {
          const next = report(await native.invoke(command));
          if (![from, to].includes(next.stage)) throw new Error('The native migration phase changed unexpectedly. Review again before continuing.');
          if (settingsOnly && (next.required || (next.stage === 'backed-up' && next.settingsImportAvailable))) throw new Error('Settings import could not be verified. Check retained settings before continuing.');
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
      function retireClick(event) {
        event.preventDefault();
        if (!current?.retirementAvailable || retire.disabled) return;
        void change('retire_convergence_apps', 'connections-reviewed', 'complete');
      }
      async function moveClick(event) {
        event.preventDefault();
        if (ended || busy || stopped || move.disabled || !dialog.open || current?.stage !== 'review'
          || current.enabled !== true || current.required !== true) return;
        if (window.CreatorHubNative !== native || native.convergencePersistence !== true) {
          showError('Native migration support changed. Existing data are kept.'); return;
        }
        busy = true; phase = 'review'; result = ''; error.hidden = true; render();
        try {
          const outcome = await native.invoke('move_to_hub');
          if (!outcome || !['complete', 'cancelled', 'stopped'].includes(outcome.outcome)
            || !['review', 'backup', 'connections', 'cleanup'].includes(outcome.phase)
            || typeof outcome.message !== 'string' || outcome.message.length > 8192) {
            throw new Error('The native migration outcome is unknown. Keep retained files; do not repeat the move.');
          }
          const next = report(outcome.report);
          if (!next.streamlined || (outcome.outcome === 'complete') !== (next.stage === 'complete')
            || (outcome.outcome === 'cancelled' && next.stage !== 'review')) {
            throw new Error('Native completion could not be verified. Keep retained files and review the outcome.');
          }
          current = next; result = outcome.message;
          stopped = outcome.outcome === 'stopped';
          if (stopped) showError(outcome.message);
        } catch (reason) {
          stopped = true;
          showError(`Outcome needs review; no automatic retry was started. ${String(reason).slice(0, 2000)}`);
        } finally { busy = false; render(); }
      }
      async function refreshClick(event) {
        event.preventDefault();
        if (ended || busy || refresh.disabled || !dialog.open) return;
        if (window.CreatorHubNative !== native || native.convergencePersistence !== true) {
          showError('Native migration support changed. Existing data are kept.'); return;
        }
        busy = true; error.hidden = true; error.textContent = ''; render();
        try {
          const next = report(await native.invoke(streamlined ? 'inspect_convergence_outcome' : 'refresh_convergence'));
          if (streamlined && !next.streamlined) throw new Error('Native migration support changed. Keep retained files.');
          current = next;
          stopped = false; result = streamlined ? current.message : ''; phase = '';
        }
        catch (reason) { showError(reason); }
        finally { busy = false; render(); }
      }
      async function copyRecoveryClick(event) {
        event.preventDefault();
        if (ended || busy || !dialog.open || copyRecovery.disabled || !current?.recoveryHelp) return;
        try {
          await navigator.clipboard.writeText(current.recoveryHelp);
          if (!ended && dialog.open) copyStatus.textContent = 'Copied. Review local paths before sharing.';
        } catch {
          if (!ended && dialog.open) {
            recoveryText.focus(); recoveryText.select();
            copyStatus.textContent = 'Clipboard unavailable. Recovery details are selected for copying.';
          }
        }
      }
      dialog.addEventListener('cancel', cancel);
      prepare.addEventListener('click', prepareClick);
      connections.addEventListener('click', connectionsClick);
      retire.addEventListener('click', retireClick);
      refresh.addEventListener('click', refreshClick);
      later.addEventListener('click', laterClick);
      if (move) move.addEventListener('click', moveClick);
      copyRecovery?.addEventListener('click', copyRecoveryClick);
      if (streamlined && typeof window.__TAURI__?.event?.listen === 'function') {
        try {
          unlisten = await window.__TAURI__.event.listen('convergence-progress', event => {
            if (!ended && busy && ['review', 'backup', 'connections', 'cleanup'].includes(event.payload)) {
              phase = event.payload; render();
            }
          });
        } catch { /* The awaited native result remains authoritative without progress events. */ }
      }
      locked.forEach(node => { node.inert = true; });
      render();
      if (initialError) showError(initialError);
      try { dialog.showModal(); if (streamlined) later.focus({ preventScroll: true }); }
      catch (reason) { release(); throw reason; }
    }
    void begin().catch(reason => { active = undefined; reject(reason); });
    return completion;
  }

  window.CreatorConvergence = Object.freeze({ run });
})();
