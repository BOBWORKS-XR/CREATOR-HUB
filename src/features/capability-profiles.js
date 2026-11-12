const sdkProfiles = {
  creator: { label: 'Altspace / Creator SDK', groups: 'core,creator' },
  banter: { label: 'Banter', groups: 'core,banter' },
  hybrid: { label: 'Altspace + Banter', groups: 'core,banter,creator' },
  none: { label: 'Unity core', groups: 'core' },
};
const manualLabels = {
  core: 'Token Saver', all: 'All tools (high context)', read: 'Inspection',
  'core,creator': 'Altspace / Creator SDK', 'core,banter': 'Banter',
  'core,banter,creator': 'Altspace + Banter', 'core,shadergraph': 'Shader Graph preview',
  'core,author': 'Unity authoring', 'core,test': 'Testing', none: 'Minimal routing',
};

export function capabilityView(selection, project) {
  const sdk = project?.sdkProfile;
  const detected = project?.valid && !sdk?.error ? sdkProfiles[sdk?.profile] : null;
  const verified = detected && sdk.recommendedToolGroups === detected.groups;
  if (selection !== 'auto') return {
    ready: true, label: manualLabels[selection] || `Current: ${selection}`, groups: selection,
    status: `Manual: ${manualLabels[selection] || selection}`,
    autoLabel: verified ? `Auto: ${detected.label}` : 'Auto (project SDK)',
  };
  return verified ? {
    ready: true, label: `Auto: ${detected.label}`, groups: detected.groups,
    status: `Detected: ${detected.label}`, autoLabel: `Auto: ${detected.label}`,
  } : {
    ready: false, label: 'Auto (project SDK)', groups: null, autoLabel: 'Auto (project SDK)',
    status: 'SDK not verified. Check the connection again or choose a manual capability profile.',
  };
}
