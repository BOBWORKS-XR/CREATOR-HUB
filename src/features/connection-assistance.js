export const liveCheck = 'Call get_bridge_status. Which Unity project answered, is its bridge ready, and what running MCP version does mcpServerVersion report? If that field is missing, say "version not reported"; do not guess from the bridge version or saved settings. Do not change anything.';

// Describe the next local step, not whether a separate AI process is connected.
export function connectionStep({ status, project, activePath, client, label, canApply, differentRuntime }) {
  if (!project.trim()) return ['browse', 'Choose the Unity project you want to connect.', 'Choose project'];
  if (!status) return ['check', 'Check this folder before changing its connection.', 'Check this project'];
  if (!status.project?.valid) return ['browse', 'This is not a Unity project folder. Choose the folder that contains Assets, Packages and ProjectSettings.', 'Choose project'];
  if (!status.runtime.ready) return ['home', 'Hub could not find its MCP tools. Check Home for a Hub update before changing your project.', 'Go to Home'];
  const p = status.project;
  if (client?.id === 'claude' && p.claudeProjectEntry === 'present' && p.claudeProjectRoute === 'oldProjectRouter') {
    return ['project-update', 'Claude uses an older connection for this project. Update it here without changing your other projects.', 'Update this project connection'];
  }
  if (typeof p.bridgeInstalled !== 'boolean' || typeof p.bridgeCurrent !== 'boolean' || (!p.bridgeInstalled && p.bridgeCurrent)) {
    return ['check', 'Hub could not verify the Unity bridge. Check again before changing anything.', 'Check again'];
  }
  if (!p.bridgeInstalled) return ['install', 'Add the Unity bridge so your AI can talk to this project. Your AI app settings stay the same.', 'Review bridge installation'];
  if (!p.bridgeCurrent) return ['update', 'This project has a different bridge from the one in Hub. Review before replacing it.', 'Review bridge update'];
  if (p.stateStatus !== 'fresh') return ['check', 'The bridge is installed. Open this project in Unity, wait for scripts to finish compiling, then check again.', 'Check again'];
  if (!client && label) return ['check', `Hub did not receive a status for ${label}. Check again before changing anything.`, 'Check again'];
  if (!client) return ['prompt', 'Hub saw recent Unity activity. Choose your AI app above to check its connection.', 'Copy connection check'];
  if (client.id === 'claude' && p.claudeProjectEntry === 'present') {
    if (p.claudeProjectRoute === 'direct') return ['prompt', "Claude starts MCP directly for this project. Changing Hub's connection won't affect it. If it works, no setup needed.", 'Copy connection check'];
    if (p.claudeProjectRoute === 'shared') return ['prompt', "Claude uses Hub's connection. No setup needed. If Claude reports an older version, check for an update below.", 'Copy connection check'];
    return ['prompt', 'This project has Claude Code settings. Open Claude Code here and type /mcp to check them before setting up anything else.', 'Copy connection check'];
  }
  if (client.id === 'claude' && p.claudeProjectEntry === 'unreadable') return ['prompt', 'Hub could not check this project\'s Claude settings. Open Claude Code in the project and check there first. Hub has not changed the file.', 'Copy connection check'];
  if (client.issue || client.supported !== true || typeof client.configured !== 'boolean') return ['client-status', "Hub could not verify this app's saved connection. Look at its status before changing it.", 'Show app status'];
  if (client.configured) return ['prompt', `Hub found saved settings for ${label}. Before changing them, ask ${label} to check that it reaches this project.`, 'Copy connection check'];
  if (differentRuntime) return ['runtime', 'Your saved setup uses a different copy of MCP. Keep it if intentional, or review switching to the copy included with Hub before connecting this app.', 'Review MCP choice'];
  if (activePath !== project || !canApply) return ['setup', 'Hub could not confirm a connection for this app. Review your project and selected apps before connecting.', 'Go to setup'];
  const message = client.id === 'claude'
    ? 'Claude Code may already connect through this project. Try the read-only check first. If it works, leave your settings as they are.'
    : `Hub did not find a saved connection for ${label}. You can connect just this app to the selected project.`;
  return ['connect', message, `Review connection for ${label}`];
}
