const key = 'creator-hub.mcp-product-review.v1';

function validPath(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f]/.test(path)) return false;
  const normalized = path.replaceAll('\\', '/');
  return (/^(?:[a-z]:\/|\/)/i.test(normalized))
    && !normalized.split('/').some(part => part === '.' || part === '..');
}

export function productReviewFingerprint(report) {
  if (!report || !['conflict', 'legacy-only'].includes(report.status)
    || !Array.isArray(report.backups) || !Array.isArray(report.recovery)
    || report.recovery.some(item => item?.historical_completed !== true)) return null;
  if (![report.currentPath, report.legacyPath].every(validPath)
    || report.currentPath.replaceAll('\\', '/') === report.legacyPath.replaceAll('\\', '/')) return null;
  const paths = report.status === 'conflict' ? [report.currentPath, report.legacyPath] : [report.legacyPath];
  if (report.backups.length !== paths.length) return null;
  const backups = [...report.backups];
  if (backups.some(path => typeof path !== 'string') || new Set(backups).size !== backups.length) return null;
  const files = [];
  for (const path of paths) {
    const normalized = path.replaceAll('\\', '/');
    const slash = normalized.lastIndexOf('/');
    if (slash < 0 || slash === normalized.length - 1) return null;
    const prefix = `${normalized.slice(0, slash)}/.creator-hub-settings-backups/${normalized.slice(slash + 1)}.`;
    const matching = backups.filter(backup => {
      const name = backup.replaceAll('\\', '/');
      return name.startsWith(prefix) && /^[a-f0-9]{64}\.bak$/.test(name.slice(prefix.length));
    });
    if (matching.length !== 1) return null;
    files.push([path, matching[0]]);
  }
  return JSON.stringify({ status: report.status, currentPath: report.currentPath, legacyPath: report.legacyPath, files });
}

// This remembers a completed UI review, not authorization for native writes.
export function recalledProductReview(report, storage) {
  const fingerprint = productReviewFingerprint(report);
  if (!fingerprint) return false;
  const saved = storage.getItem(key);
  if (saved === null) return false;
  if (saved.length > 32768) throw new Error('Saved review is invalid. Review your setup again.');
  const receipt = JSON.parse(saved);
  if (receipt?.version !== 1 || typeof receipt.fingerprint !== 'string'
    || Object.keys(receipt).sort().join(',') !== 'fingerprint,version') {
    throw new Error('Saved review is invalid. Review your setup again.');
  }
  return receipt.fingerprint === fingerprint;
}

export function rememberProductReview(report, storage) {
  const fingerprint = productReviewFingerprint(report);
  if (!fingerprint) throw new Error('The settings backup could not be verified. Review your setup again.');
  const value = JSON.stringify({ version: 1, fingerprint });
  if (value.length > 32768) throw new Error('The saved review is too large. Your settings are kept.');
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error('The setup review could not be remembered. Your settings are kept.');
}
