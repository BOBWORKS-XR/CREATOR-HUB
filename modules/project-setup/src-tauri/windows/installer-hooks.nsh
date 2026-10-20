; Refuse running-app replacement instead of Tauri's default force-kill path.
; Older installed uninstallers remain legacy: installerProtocol stays 0.
!ifmacrondef CheckIfAppIsRunning
  !error "Expected Tauri running-app macro is missing; review installer template"
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& { param([string]$$exe); try { $$name = [IO.Path]::GetFileNameWithoutExtension($$exe); $$running = @(Get-Process -ErrorAction Stop | Where-Object { $$_.ProcessName -eq $$name }); if ($$running.Count -gt 0) { exit 10 }; exit 0 } catch { exit 11 } }" "${executableName}"`
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK \
      "${productName} is running, or Setup could not verify that it is closed.$\r$\n$\r$\nFinish your work and close the app, then try again. Setup will not force-close it." /SD IDOK
    SetErrorLevel 10
    Abort
  ${EndIf}
!macroend

; The reinstall page may run a legacy uninstaller before the install section.
; Refuse that path before displaying any installer page, not only before copying.
!ifdef MUI_CUSTOMFUNCTION_GUIINIT
  !error "Review existing GUI initialization before adding Setup preflight"
!endif
!define MUI_CUSTOMFUNCTION_GUIINIT CreatorSetupEarlyPreflight
Function CreatorSetupEarlyPreflight
  Push $0
  Push $1
  !insertmacro CheckIfAppIsRunning "creator-project-setup.exe" "Creator Project Setup"
  Pop $1
  Pop $0
FunctionEnd
