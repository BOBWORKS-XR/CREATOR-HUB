(() => {
  const POLICY_VERSION = '2026-09-28-v1';
  const KEY = 'creator-usage-terms.hub';

  async function requireAcceptance() {
    if (window.__CREATOR_HOSTED_TERMS_ACCEPTED__ === POLICY_VERSION) return true;
    const native = window.CreatorHubNative?.usageTermsPersistence === true;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
    const legacyAccepted = saved?.policyVersion === POLICY_VERSION
      && typeof saved.acceptedAt === 'string' && Number.isFinite(Date.parse(saved.acceptedAt));
    let readError;
    if (native) {
      try {
        if (await window.CreatorHubNative.invoke('usage_terms_status') === true) return true;
        if (legacyAccepted) {
          await window.CreatorHubNative.invoke('accept_usage_terms', { policyVersion: POLICY_VERSION, accepted: true });
          return true;
        }
      } catch (reason) { readError = String(reason); }
    } else if (legacyAccepted) return true;

    const dialog = document.querySelector('#usage-terms-dialog');
    const checkbox = document.querySelector('#usage-terms-checkbox');
    const submit = document.querySelector('#usage-terms-continue');
    const error = document.querySelector('#usage-terms-error');
    if (readError) { error.textContent = `The acknowledgement could not be read or saved: ${readError}. Review the terms to try again.`; error.hidden = false; }
    const locked = [...document.body.children].filter(node => node !== dialog && !node.inert);
    locked.forEach(node => { node.inert = true; });
    dialog.addEventListener('cancel', event => event.preventDefault());
    checkbox.addEventListener('change', () => { submit.disabled = !checkbox.checked; });
    dialog.showModal();
    return new Promise(resolve => {
      submit.addEventListener('click', async () => {
        if (!checkbox.checked || submit.disabled) return;
        submit.disabled = true;
        checkbox.disabled = true;
        try {
          if (native) await window.CreatorHubNative.invoke('accept_usage_terms', { policyVersion: POLICY_VERSION, accepted: true });
          try {
            localStorage.setItem(KEY, JSON.stringify({ policyVersion: POLICY_VERSION, acceptedAt: new Date().toISOString() }));
          } catch (reason) { if (!native) throw reason; }
        } catch (reason) {
          error.textContent = `The acknowledgement could not be saved: ${String(reason)}. The app will remain locked until it is recorded.`;
          error.hidden = false;
          submit.disabled = false;
          checkbox.disabled = false;
          return;
        }
        dialog.close();
        locked.forEach(node => { node.inert = false; });
        resolve(true);
      });
    });
  }

  window.CreatorUsageTerms = Object.freeze({ requireAcceptance });
})();
