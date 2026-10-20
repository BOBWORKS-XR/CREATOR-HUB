(() => {
  const runtime = window.CreatorRuntime;
  void runtime.ready.then(async () => {
    if (!runtime.hosted || runtime.readOnly || !runtime.builtIn) return;
    const row = document.createElement('div');
    row.className = 'form-group';
    row.hidden = true;
    const status = document.createElement('p');
    status.className = 'setup-message';
    status.setAttribute('role', 'status');
    const review = document.createElement('button');
    review.id = 'reviewProductSettingsBtn';
    review.type = 'button';
    review.className = 'btn btn-secondary';
    review.textContent = 'Review saved MCP settings';
    row.append(status, review);
    document.querySelector('.setup-form').append(row);
    const messages = {
      'legacy-only': 'Older MCP settings remain in use at their existing location.',
      conflict: 'Current and older MCP settings differ. Both originals are kept.',
    };
    let interrupted = false;
    function render(report) {
      interrupted = Boolean(report.recovery?.some(item => !item.historical_completed));
      const message = interrupted ? 'An MCP settings save needs recovery review. No automatic rollback is attempted.' : messages[report.status];
      row.hidden = !message;
      status.textContent = message || '';
      if (report.backups?.length && report.status === 'conflict') status.textContent += ' Exact backups are retained.';
      review.hidden = !interrupted && !['legacy-only', 'conflict'].includes(report.status);
      if (message && report.evidencePath) status.textContent += ' Evidence: ' + report.evidencePath;
    }
    review.addEventListener('click', () => {
      void window.CreatorMcpOperations.run(async () => {
        review.disabled = true;
        try {
          const wasInterrupted = interrupted;
          render(await runtime.invoke('review_product_settings'));
          if (wasInterrupted && !interrupted) {
            row.hidden = false;
            review.hidden = true;
            status.textContent = 'MCP settings recovery was reviewed. Reopen MCP to reload saved settings.';
          }
        } catch (error) {
          row.hidden = false;
          status.textContent = String(error);
        } finally {
          review.disabled = Boolean(runtime.disconnected);
        }
      }).catch(error => { row.hidden = false; status.textContent = String(error); });
    });
    try { render(await runtime.invoke('product_settings_status')); }
    catch (error) { row.hidden = false; review.hidden = true; status.textContent = String(error); }
  }).catch(() => {});
})();
