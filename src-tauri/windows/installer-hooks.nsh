; Preserve active Hub workflows; never use Tauri's default force-close path.
; Tauri includes hooks before defining MAINBINARYSRCPATH, including GUI-init code.
!include WinMessages.nsh
!ifndef CREATOR_HUB_PREFLIGHT_EXE
  !define DOLLAR "$"
  !if "$%CARGO_TARGET_DIR%" == "${DOLLAR}%CARGO_TARGET_DIR%"
    !define CREATOR_HUB_PREFLIGHT_EXE "${__FILEDIR__}\..\target\release\creator-hub.exe"
  !else if "$%CARGO_TARGET_DIR%" == ""
    !define CREATOR_HUB_PREFLIGHT_EXE "${__FILEDIR__}\..\target\release\creator-hub.exe"
  !else
    !define CREATOR_HUB_PREFLIGHT_EXE "$%CARGO_TARGET_DIR%\release\creator-hub.exe"
  !endif
  !undef DOLLAR
!endif
!ifmacrondef CheckIfAppIsRunning
  !error "Expected Tauri running-app macro is missing; review installer template"
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  ; Tauri launches /UPDATE immediately before exiting. Allow that exit to
  ; finish, but never bypass the same running-app guard or terminate a process.
  ${Do}
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
    ; GUI-init precedes the first page, which normally names and shows the owner.
    ${IfNot} ${Silent}
      SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:${productName}"
      ShowWindow $HWNDPARENT ${SW_SHOW}
      BringToFront
    ${EndIf}
    ; Retry skips only the cancel exit below and repeats the exact safety check.
    MessageBox MB_ICONSTOP|MB_RETRYCANCEL \
      "Creator Hub could not continue the installation.$\r$\n$\r$\nSave your work and close Creator Hub, including preview windows, then choose Retry. Your other apps can stay open.$\r$\n$\r$\nIf Hub is already closed, choose Cancel and reopen your installed Hub. No app data is removed by this check." /SD IDCANCEL IDRETRY +3
    SetErrorLevel 10
    Abort
  ${EndIf}
  ${LoopUntil} $0 == "0"
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
