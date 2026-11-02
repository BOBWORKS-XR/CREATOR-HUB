(() => {
  const hash = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  const short = value => Array.from(typeof value === 'string' ? value : value?.message || 'Route status is unavailable.').slice(0, 512).join('');
  const unknown = reason => ({ schemaVersion: 1, outcome: 'review-required', route: 'unknown', recovery: 'read-only-recheck', reason: short(reason) });

  function decode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
      || !['review-required', 'not-attempted', 'legacy-review-required', 'activated', 'known-committed', 'verified-current'].includes(value.outcome)
      || !['verified-prior', 'verified-target', 'unknown'].includes(value.route)
      || !['none', 'explicit-client-apply', 'read-only-recheck'].includes(value.recovery)
      || (value.targetVersion !== null && (typeof value.targetVersion !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,127}$/.test(value.targetVersion)))
      || (value.reason !== null && (typeof value.reason !== 'string' || value.reason.length > 1024))
      || (value.handoffPath !== null && (typeof value.handoffPath !== 'string' || value.handoffPath.length > 4096))
      || !['intentSha256', 'targetExecutableSha256', 'expectedGeneration', 'activeGeneration'].every(key => hash(value[key]))) {
      throw Error('The MCP route response is incomplete or unsupported. Recheck before changing a connection.');
    }
    const target = value.route === 'verified-target' && ['activated', 'known-committed', 'verified-current'].includes(value.outcome)
      && value.recovery === 'none' && value.targetVersion && value.expectedGeneration && value.expectedGeneration === value.activeGeneration;
    if (target) return null;
    const prior = value.route === 'verified-prior' && value.targetVersion && value.expectedGeneration && value.activeGeneration
      && value.expectedGeneration !== value.activeGeneration && !['activated', 'known-committed', 'verified-current'].includes(value.outcome)
      && (value.recovery === 'read-only-recheck' || (value.recovery === 'explicit-client-apply' && ['review-required', 'legacy-review-required'].includes(value.outcome)));
    if (!prior && !(value.route === 'unknown' && value.recovery === 'read-only-recheck' && value.outcome === 'review-required')) {
      throw Error('The MCP route outcome is inconsistent. Recheck read-only before changing a connection.');
    }
    const hubOnlyManualInstall = typeof value.hubOnlyManualInstall === 'string'
      ? Array.from(value.hubOnlyManualInstall.slice(0, 1024)).slice(0, 512).join('') : '';
    return Object.freeze({ ...Object.fromEntries(['schemaVersion', 'outcome', 'route', 'recovery', 'targetVersion', 'reason',
      'intentSha256', 'targetExecutableSha256', 'expectedGeneration', 'activeGeneration', 'handoffPath'].map(key => [key, value[key]])), hubOnlyManualInstall });
  }

  function create() {
    let last = null, issue = '', checking = false;
    const subscribers = new Set();
    const view = () => {
      const canReview = Boolean(last && !issue && last.route === 'verified-prior' && last.recovery === 'explicit-client-apply');
      return {
        visible: Boolean(last), checking, canReview,
        title: issue ? 'MCP update status needs rechecking' : canReview ? 'MCP update needs review' : 'MCP update is not confirmed',
        message: issue ? 'The last reported update still needs review. The current route could not be checked.'
          : canReview ? `Hub ${last.targetVersion} is installed. New MCP connections still use the previous MCP tools.`
            : last?.route === 'verified-prior' ? 'New MCP connections still use the previous MCP tools. The update has not been confirmed.'
              : 'The MCP update could not be confirmed.',
        advice: canReview ? 'Open MCP, check the saved project, then Apply to one existing AI client.'
          : 'Recheck the update status before changing a connection. This check does not set up or activate MCP.',
        reason: last?.reason ? short(last.reason) : '', issue,
        hubOnlyManualInstall: last?.hubOnlyManualInstall || '',
        identities: last ? [last.targetVersion && `Target Hub: ${last.targetVersion}`,
          last.activeGeneration && `${issue ? 'Last reported' : 'Active'} generation: ${last.activeGeneration}`,
          last.expectedGeneration && `Target generation: ${last.expectedGeneration}`, last.intentSha256 && `Intent: ${last.intentSha256}`,
          last.handoffPath && `Retained handoff: ${last.handoffPath}`].filter(Boolean) : [],
      };
    };
    const notify = () => { const value = view(); for (const listener of subscribers) listener(value); };
    return Object.freeze({
      view,
      observe(value) {
        if (value === undefined || value === null) {
          if (last) issue = 'No route outcome was returned. The last reported notice is retained; no successful advance is assumed.';
        } else {
          try { last = decode(value); issue = ''; }
          catch (error) { if (!last) last = unknown(error.message); issue = short(error); }
        }
        notify();
      },
      failed(reason) { if (last) { issue = `Route recheck failed: ${short(reason)}`; notify(); } },
      checking(value) { checking = value === true; notify(); },
      subscribe(listener) { subscribers.add(listener); listener(view()); return () => subscribers.delete(listener); },
    });
  }

  function mount(container, service, { mcpPage = false } = {}) {
    if (!service) { container.hidden = true; return () => {}; }
    const document = container.ownerDocument;
    const make = (tag, className) => { const node = document.createElement(tag); if (className) node.className = className; return node; };
    container.classList.add('mcp-route-notice'); container.setAttribute('aria-label', 'MCP route update');
    const copy = make('div', 'mcp-route-copy'), title = make('p', 'mcp-route-title'), strong = make('strong');
    title.append(strong);
    const message = make('p'), advice = make('p'), reason = make('p', 'mcp-route-reason'), issue = make('p', 'mcp-route-reason');
    const manualInstall = make('p', 'mcp-route-manual-install');
    message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const details = make('details'), summary = make('summary'), identities = make('div');
    summary.textContent = 'Update details'; details.append(summary, reason, issue, manualInstall, identities);
    copy.append(title, message, advice, details);
    const actions = make('div', 'mcp-route-actions');
    const open = make('button', 'text-button'), recheck = make('button', 'icon-button');
    open.type = recheck.type = 'button'; open.textContent = 'Open MCP';
    recheck.title = 'Recheck MCP route'; recheck.setAttribute('aria-label', 'Recheck MCP route');
    const icon = make('span', 'icon icon-refresh'); icon.setAttribute('aria-hidden', 'true'); recheck.append(icon);
    if (!mcpPage) actions.append(open);
    actions.append(recheck); container.replaceChildren(copy, actions);
    const onOpen = () => service.openMcp();
    const onRecheck = () => { void service.recheck(); };
    open.addEventListener('click', onOpen); recheck.addEventListener('click', onRecheck);
    const unsubscribe = service.state.subscribe(value => {
      container.hidden = !value.visible; container.setAttribute('aria-busy', String(value.checking));
      strong.textContent = value.title; message.textContent = value.message;
      advice.textContent = mcpPage && value.canReview ? 'Check the saved project, then Apply to one existing AI client.' : value.advice;
      reason.textContent = value.reason; reason.hidden = !value.reason; issue.textContent = value.issue; issue.hidden = !value.issue;
      manualInstall.textContent = value.hubOnlyManualInstall; manualInstall.hidden = !value.hubOnlyManualInstall;
      identities.replaceChildren(...value.identities.map(text => { const line = make('p'); line.textContent = text; return line; }));
      details.hidden = !value.identities.length && !value.reason && !value.issue && !value.hubOnlyManualInstall; open.hidden = !value.canReview;
      open.disabled = recheck.disabled = value.checking;
    });
    return () => { unsubscribe(); open.removeEventListener('click', onOpen); recheck.removeEventListener('click', onRecheck); };
  }
  window.CreatorMcpRouteUpdate = Object.freeze({ create, mount });
})();
