# Creator Project Setup 0.2.2 Preview

Run `Creator-Project-Setup-0.2.2-Windows.exe`. The portable app does not need to be
installed. It uses the Microsoft Edge WebView2 runtime; the setup EXE is available
for machines that need that prerequisite installed.

For a new project, enter a name and parent folder. Setup checks the required Unity
Editor, Android tools, Windows support, and URP template. Sign-in, licensing, and
missing Unity installations still go through Unity Hub.

Automatic registration requires Hub 3.21.1 or newer, opened at least once. With
older Hub versions, use Add > Add project from disk, or update/open Hub and choose
Recheck Hub and add project. Restarting an old Hub version alone is insufficient.
A private official Unity CLI helper is downloaded once (about
21 MB). Registration can be retried without recreating the project. The app checks
the registration database, not whether a row is currently visible in Hub's window.

If Hub was already running and the new project is missing, choose **Restart Unity
Hub** and confirm after its downloads/installations finish. This fully restarts
Hub, including when its window was hidden in the system tray. Unity Editors stay
open. A cancelled or refused restart does not recreate or alter the project and
never force-closes Hub. You can also fully quit Hub manually, then use Open Unity
Hub. Merely closing Hub's window might only hide it.

For an existing project, choose **Existing project** and inspect the folder.
Inspection does not change files. Close Unity, review the findings, and approve
the backup before starting repair or validation.

Repair is a preview for the tested Unity 6000.3.21f1 / Creator SDK 4.0.14 recipe.
Backups cover settings, manifests, and generated Visual Scripting data, not the
whole project. Keep a full backup for valuable content. Failed repairs retain
logs and backups; recovery is manual. No automatic SDK migration or material
conversion is performed.

This build is unsigned. Windows may show an Unknown Publisher or SmartScreen
warning. Only run a copy from a source you trust.
