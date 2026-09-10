; Preserve active Hub workflows; never use Tauri's default force-close path.
; Tauri includes hooks before defining MAINBINARYSRCPATH, including GUI-init code.
!ifndef CREATOR_HUB_PREFLIGHT_EXE
  !if "$%CARGO_TARGET_DIR%" != ""
    !define CREATOR_HUB_PREFLIGHT_EXE "$%CARGO_TARGET_DIR%\release\creator-hub.exe"
  !else
    !define CREATOR_HUB_PREFLIGHT_EXE "${__FILEDIR__}\..\target\release\creator-hub.exe"
  !endif
!endif
!ifmacrondef CheckIfAppIsRunning
  !error "Expected Tauri running-app macro is missing; review installer template"
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  ; Tauri launches /UPDATE immediately before exiting. Allow that exit to
  ; finish, but never bypass the same running-app guard or terminate a process.
  Push $2
  Push $3
  InitPluginsDir
  File /oname=$PLUGINSDIR\creator-hub-preflight.exe "${CREATOR_HUB_PREFLIGHT_EXE}"
  ${GetParameters} $2
  ClearErrors
  ${GetOptions} $2 "/UPDATE" $3
  ${IfNot} ${Errors}
    nsExec::ExecToStack /TIMEOUT=12000 `"$PLUGINSDIR\creator-hub-preflight.exe" --installer-preflight-wait`
  ${Else}
    nsExec::ExecToStack /TIMEOUT=12000 `"$PLUGINSDIR\creator-hub-preflight.exe" --installer-preflight`
  ${EndIf}
  Pop $0
  Pop $1
  Pop $3
  Pop $2
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK \
      "Close Creator Hub before continuing.$\r$\n$\r$\nSave your work, close any old Hub preview windows, then run this installer again. Your other apps can stay open.$\r$\n$\r$\nIf Hub is already closed, the safety check failed. Nothing was installed." /SD IDOK
    SetErrorLevel 10
    Abort
  ${EndIf}
!macroend

; The legacy uninstall page can run before the install section.
!ifdef MUI_CUSTOMFUNCTION_GUIINIT
  !error "Review existing GUI initialization before adding Hub preflight"
!endif
!define MUI_CUSTOMFUNCTION_GUIINIT CreatorHubEarlyPreflight
Function CreatorHubEarlyPreflight
  Push $0
  Push $1
  !insertmacro CheckIfAppIsRunning "creator-hub.exe" "Creator Hub"
  Pop $1
  Pop $0
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "creator-hub.exe" "Creator Hub"
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "creator-hub.exe" "Creator Hub"
!macroend
