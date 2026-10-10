(() => {
  const HIDDEN_KEY = 'creator-works-mcp.ai-usage-notice-hidden.v1';
  const banner = document.querySelector('#ai-usage-notice');
  const dontShow = document.querySelector('#ai-usage-dont-show');
  const dismiss = document.querySelector('#ai-usage-dismiss');
  const dialog = document.querySelector('#ai-usage-confirm-dialog');
  const confirmCheckbox = document.querySelector('#ai-usage-confirm-checkbox');
  const confirmButton = document.querySelector('#ai-usage-confirm');
  const confirmError = document.querySelector('#ai-usage-confirm-error');

  async function initialize() {
    try {
      banner.hidden = window.CreatorRuntime?.hosted
        ? await window.CreatorRuntime.invoke('get_ai_usage_notice_hidden') === true
        : localStorage.getItem(HIDDEN_KEY) === 'true';
    }
    catch { banner.hidden = false; }
  }

  dismiss.addEventListener('click', () => {
    if (!dontShow.checked) { banner.hidden = true; return; }
    confirmCheckbox.checked = false;
    confirmButton.disabled = true;
    confirmError.hidden = true;
    dialog.showModal();
  });
  confirmCheckbox.addEventListener('change', () => { confirmButton.disabled = !confirmCheckbox.checked; });
  dialog.addEventListener('cancel', event => event.preventDefault());
  document.querySelector('#ai-usage-keep').addEventListener('click', () => dialog.close());
  confirmButton.addEventListener('click', async () => {
    if (!confirmCheckbox.checked || confirmButton.disabled) return;
    confirmButton.disabled = true;
    confirmError.hidden = true;
    try {
      if (window.CreatorRuntime?.hosted) {
        if (await window.CreatorRuntime.invoke('hide_ai_usage_notice', { acknowledged: true }) !== true) {
          throw new Error('Notice preference was not saved.');
        }
      } else {
        localStorage.setItem(HIDDEN_KEY, 'true');
        if (localStorage.getItem(HIDDEN_KEY) !== 'true') throw new Error('Notice preference was not saved.');
      }
    }
    catch {
      confirmError.textContent = 'The preference could not be saved. The warning will remain visible.';
      confirmError.hidden = false;
      return;
    } finally {
      confirmButton.disabled = !confirmCheckbox.checked;
    }
    dialog.close();
    banner.hidden = true;
  });

  window.CreatorAiUsageNotice = Object.freeze({ initialize });
})();
