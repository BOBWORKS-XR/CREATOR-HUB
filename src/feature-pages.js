(() => {
  const host = document.querySelector('#view-native-features');
  const pages = new Map();
  const mounts = new Map();
  const loading = new Set();
  let selected = null;
  let native = null;
  let subscription = null;
  let startup = Promise.resolve();
  let latestStatus = { integrated: false, features: [] };
  let generation = 0;
  let canLoad = true;
  const changed = () => window.dispatchEvent(new Event('creator-feature-state'));
  const api = {
    invoke: (...args) => (native?.invoke || window.CreatorHubNative.invoke)(...args),
    changed,
    retry(feature) { const page = pages.get(feature); if (canLoad && page && !page.busy()) { page.attempted = false; page.initialized = false; } return window.CreatorFeaturePages.show(feature); },
  };
  async function subscribe() {
    if (!subscription) {
      const listen = native?.listen || window.__TAURI__?.event?.listen;
      if (!listen) throw new Error('Feature events are unavailable. Restart Hub.');
      subscription = Promise.resolve(listen('feature-event', event => {
        const value = event?.payload;
        if (!value || !['setup', 'mcp'].includes(value.feature) || typeof value.name !== 'string') return;
        pages.get(value.feature)?.event(value.name, value.payload);
      })).catch(reason => { subscription = null; throw reason; });
    }
    await subscription;
  }
  function help(feature) {
    const extra = document.querySelector('#feature-help-content');
    const original = document.querySelector('#hub-help-content');
    extra.replaceChildren(); original.hidden = Boolean(feature); extra.hidden = !feature;
    document.querySelector('#context-help-title').textContent = feature === 'setup' ? 'Project Setup help' : feature === 'mcp' ? 'Creator Works MCP help' : 'Creator Hub help';
    for (const [question, answer] of pages.get(feature)?.help || []) {
      const details = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = question;
      const paragraph = document.createElement('p'); paragraph.textContent = answer;
      details.append(summary, paragraph); extra.append(details);
    }
  }
  function render() {
    host.hidden = !selected; host.inert = !selected;
    for (const [feature, page] of pages) {
      page.root.hidden = selected !== feature; page.root.inert = selected !== feature;
      if (selected !== feature) page.hide?.();
    }
    help(selected);
  }
  window.CreatorFeaturePages = Object.freeze({
    configure(value) {
      if (pages.size || subscription) throw new Error('Configure feature API before opening a page.');
      if (typeof value?.invoke !== 'function' || typeof value.listen !== 'function') throw new Error('Feature invoke/listen API required.');
      native = value;
    },
    async show(feature, options = {}) {
      if (Object.hasOwn(options, 'load')) canLoad = options.load === true;
      if (feature == null) { window.CreatorFeaturePages.hide(); return false; }
      if (!['setup', 'mcp'].includes(feature)) throw new Error('Unknown Hub feature.');
      selected = feature; render();
      const currentGeneration = generation;
      const open = async () => {
        if (currentGeneration !== generation) return false;
        let page = pages.get(feature);
        if (!page) {
          if (!mounts.has(feature)) mounts.set(feature, (async () => {
            const root = document.createElement('section'); root.id = `feature-${feature}`; root.className = 'feature-page';
            host.append(root);
            const module = await import(`./features/${feature}.js`);
            if (currentGeneration !== generation) { root.remove(); return null; }
            const mounted = module.mount(root, api); pages.set(feature, mounted); render(); return mounted;
          })());
          page = await mounts.get(feature);
        }
        if (!page || currentGeneration !== generation) return false;
        if (!canLoad) {
          page.field('retry').hidden = true;
          if (!page.initialized) page.field('status').textContent = 'Waiting for Hub startup';
          return page.initialized === true;
        }
        if (page.attempted) {
          if (!page.initialized && !page.field('error').hidden) page.field('retry').hidden = false;
          return page.initialized === true;
        }
        if ([...pages.entries()].some(([other, value]) => other !== feature && value.busy())) {
          page.field('status').textContent = 'Waiting for the other feature to finish';
          return false;
        }
        page.attempted = true;
        page.field('retry').hidden = true;
        loading.add(feature);
        try {
          // Shell routing must finish the single Hub terms gate first.
          if (document.querySelector('#usage-terms-dialog').open) throw new Error('Accept the Hub terms before opening a feature.');
          latestStatus = await api.invoke('feature_status');
          if (!canLoad) { page.attempted = false; return false; }
          if (latestStatus?.integrated !== true || !latestStatus.features?.includes(feature)) {
            page.enable(false, latestStatus?.issue || 'This Hub build has not linked this feature yet. Check again after updating Hub.');
            return false;
          }
          await subscribe();
          if (!canLoad) { page.attempted = false; return false; }
          page.enable(true);
          page.initialized = await page.initialize();
          page.field('retry').hidden = page.initialized || page.field('error').hidden;
          return page.initialized;
        } catch (reason) { page.enable(false, String(reason)); return false; }
        finally { loading.delete(feature); changed(); }
      };
      const result = startup.then(open); startup = result.catch(() => false);
      return result;
    },
    hide() { selected = null; render(); },
    active: feature => selected === feature,
    busy: () => loading.size > 0 || [...pages.values()].some(page => page.busy()),
    status: () => structuredClone(latestStatus),
    dispose() {
      if (loading.size || [...pages.values()].some(page => page.busy())) return false;
      generation++;
      for (const page of pages.values()) page.dispose();
      pages.clear(); mounts.clear(); host.replaceChildren(); selected = null;
      if (subscription) subscription.then(unlisten => unlisten()).catch(() => {});
      subscription = null; render(); return true;
    },
  });
})();
