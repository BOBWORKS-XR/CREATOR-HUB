(() => {
  const dialog = document.querySelector('#context-help-dialog');
  document.querySelector('#context-help-open').addEventListener('click', () => dialog.showModal());
  document.querySelector('#context-help-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  const checkIn = document.querySelector('#support-check-in');
  if (!checkIn) return;
  const entry = document.querySelector('#support-entry');
  const outcome = document.querySelector('#support-outcome');
  const preview = document.querySelector('#support-preview');
  const status = document.querySelector('#support-copy-status');
  function refreshPreview() {
    const version = window.CreatorHubNative?.version;
    const display = typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]{1,48})?$/.test(version) ? version : 'Not available';
    preview.value = `Creator Hub: ${display}\nI open MCP: ${entry.value}\nStatus: ${outcome.value}`;
    status.textContent = '';
  }
  checkIn.addEventListener('toggle', () => { if (checkIn.open) refreshPreview(); });
  entry.addEventListener('change', refreshPreview);
  outcome.addEventListener('change', refreshPreview);
  document.querySelector('#support-copy').addEventListener('click', async () => {
    refreshPreview();
    try {
      await navigator.clipboard.writeText(preview.value);
      status.textContent = 'Copied. Paste it into a chat when ready.';
    } catch {
      preview.focus(); preview.select();
      status.textContent = 'Text selected. Use your usual Copy command.';
    }
  });
})();
