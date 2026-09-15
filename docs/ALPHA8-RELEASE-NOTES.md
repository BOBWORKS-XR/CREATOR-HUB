# Creator Hub: Creator Plugins Preview

Release draft. Publish only after the exact packaged acceptance gates pass.

- **Creator Plugins in Hub:** browse community contributions with screenshots,
  creator credits, search and filters. Start Location by **Mr. E / egon.gb**
  is the first listed contribution.
- **Seven categories:** Visual Scripting, Prefabs, Plugins, Editor tools,
  Recipes, MCP tools and AI skills. Each type has incorporation guidance.
- **Verified downloads:** size and SHA-256 checks, with no silent execution.
- **Experimental Unity integration:** select a project, add its Editor-only
  Creator Plugins menu, then send supported packages to Unity for review.
  Loading, queued, cancelled and imported states are distinguished.
- **Organize selected assets:** review graph/prefab moves into an existing
  Visual Scripting/VS or Prefabs folder, or create a suitable folder. Unity
  moves preserve GUID references. Scenes are never saved automatically.
- **Fixes:** bounded Windows helper-installation retry and missing native
  permissions for Hub update commands. Embedded helper bytes stay identical
  across Windows checkouts and the standalone apps.

**Windows prerelease: expect bugs and keep project backups.** Review every
package's scripts and replacements in Unity's Import Package window. A verified
download or successful import is not a code-safety or gameplay guarantee.
MCP tools and AI skills provide instructions; they do not configure AI clients.

Start Location includes extra C# and scene assets. Review the file selection
and its documented dependencies. Its licence is maintainer-reported open
permission, not a named MIT licence for that contribution.

[Share a creation](https://github.com/SideQuestVR/Creator-Community/issues/new?template=contribution.yml)
or report a bug with the app version and relevant local logs. Sharing logs is
optional; nothing is uploaded automatically.
