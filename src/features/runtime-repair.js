export function bundledServerPath(status) {
  if (status?.managedRouting !== true || status?.runtime?.ready !== true || status?.runtime?.bundled !== true) return null;
  const command = status.runtime.command;
  if (typeof command !== 'string' || command.length > 4096 || /[\x00-\x1f]/.test(command)) return null;
  const normalized = command.replaceAll('\\', '/');
  if (!/^[a-z]:\//i.test(normalized) || normalized.slice(3).split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  if (!/\/runtime\/node\.exe$/i.test(normalized)) return null;
  return normalized.replace(/\/runtime\/node\.exe$/i, '/creator-works-mcp.mjs');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function sameSettingsExceptServer(before, after) {
  if (!before || !after || Array.isArray(before) || Array.isArray(after)
    || typeof before !== 'object' || typeof after !== 'object') return false;
  const withoutServer = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'mcp_server_path'));
  return JSON.stringify(stable(withoutServer(before))) === JSON.stringify(stable(withoutServer(after)));
}
