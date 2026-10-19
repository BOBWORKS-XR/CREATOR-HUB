export const text = value => value == null ? '' : String(value);
export function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value != null) element.textContent = text(value);
  if (className) element.className = className;
  return element;
}
export function lines(target, values) {
  target.replaceChildren(...values.filter(value => value != null && value !== '').map(value => node('p', value)));
}
export function controller(root, api, feature) {
  const abort = new AbortController();
  let working = false;
  let available = false;
  let poisoned = false;
  let locked = false;
  const field = name => root.querySelector(`[data-field="${name}"]`);
  const error = field('error');
  const status = field('status');
  const controls = field('controls');
  const call = async (command, args = {}) => {
    try { return await api.invoke('feature_call', { feature, command, args }); }
    finally {
      if (feature === 'mcp' && ['save_config', 'one_click_setup', 'install_unity_extension',
        'update_configured_unity_extensions', 'review_product_settings'].includes(command)) {
        window.CreatorProjects?.invalidate();
      }
    }
  };
  const update = () => {
    controls.disabled = working || !available || poisoned || locked;
    for (const button of root.querySelectorAll('[data-native-action]')) button.disabled = working || !available || poisoned;
    root.setAttribute('aria-busy', String(working));
    api.changed();
  };
  const showError = value => { error.textContent = text(value); error.hidden = false; };
  return {
    root, field, call, showError,
    busy: () => working,
    on(element, event, action) { element.addEventListener(event, action, { signal: abort.signal }); },
    enable(value, issue) { available = value; field('retry').hidden = value || !issue; if (issue) showError(issue); update(); },
    lock(value) { locked = value; update(); },
    hide() { for (const dialog of root.querySelectorAll('dialog[open]')) dialog.close(); },
    async run(action, label = 'Working') {
      if (working || !available || poisoned) return false;
      working = true; error.hidden = true; status.textContent = label; update();
      let lease;
      let succeeded = false;
      try {
        if (feature === 'mcp') lease = await call('begin_ui_operation');
        await action();
        status.textContent = 'Ready';
        succeeded = true;
      } catch (reason) {
        showError(reason); status.textContent = 'Needs attention';
      } finally {
        if (lease !== undefined) {
          try { await call('finish_ui_operation', { id: lease }); }
          catch (reason) { succeeded = false; poisoned = true; status.textContent = 'Operation state unknown'; showError(`Operation state is unknown. Restart Hub before continuing. ${text(reason)}`); }
        }
        working = false; update();
      }
      return succeeded;
    },
    dispose() { if (working) return false; abort.abort(); root.replaceChildren(); return true; },
  };
}

// Dialogs belong to their feature root; there is no second shell/help/terms UI.
export function confirm(page, { title, detail, accept = 'Continue', acknowledgement }) {
  const dialog = node('dialog', null, 'feature-dialog');
  const heading = node('h3', title);
  heading.id = `${page.root.id}-confirmation-title`;
  dialog.setAttribute('aria-labelledby', heading.id);
  const copy = node('p', detail);
  const actions = node('div', null, 'feature-actions');
  const cancel = node('button', 'Cancel', 'text-button'); cancel.type = 'button';
  const submit = node('button', accept, 'primary-button'); submit.type = 'button';
  dialog.append(heading, copy);
  let checkbox;
  if (acknowledgement) {
    const label = node('label', null, 'feature-check');
    checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    label.append(checkbox, node('span', acknowledgement)); dialog.append(label);
    submit.disabled = true;
    checkbox.addEventListener('change', () => { submit.disabled = !checkbox.checked; });
  }
  actions.append(cancel, submit); dialog.append(actions); page.root.append(dialog); dialog.showModal();
  return new Promise(resolve => {
    let settled = false;
    const done = result => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(result); };
    cancel.addEventListener('click', () => done(false), { once: true });
    submit.addEventListener('click', () => { if (!checkbox || checkbox.checked) done(true); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); done(false); });
    dialog.addEventListener('close', () => done(false));
  });
}
