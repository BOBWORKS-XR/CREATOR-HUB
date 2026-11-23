Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!macro CheckIfAppIsRunning executableName productName
  !error "Production hook must replace this macro"
!macroend
!include "${GUARD_FILE}"
Name "Creator Hub Guard Test"
OutFile "${FIXTURE_EXE}"
Page custom LegacyPage
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!ifdef LOCK_PREFLIGHT_FIXTURE
SilentInstall silent
Function .onInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\creator-hub-preflight.exe "${CREATOR_HUB_PREFLIGHT_EXE}"
  System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR\creator-hub-preflight.exe", i 0x80000000, i 0, p 0, i 3, i 128, p 0) p.r8'
  ${If} $8 == -1
    SetErrorLevel 91
    Abort
  ${EndIf}
  ; Intentionally hold a no-share handle until this disposable process exits.
FunctionEnd
!endif
!ifdef TRANSIENT_PREFLIGHT_FIXTURE
SilentInstall silent
Function .onInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\creator-hub-preflight.exe "${CREATOR_HUB_PREFLIGHT_EXE}"
  FileOpen $0 "$EXEDIR\lock-target.txt" w
  FileWrite $0 "$PLUGINSDIR\creator-hub-preflight.exe"
  FileClose $0
  StrCpy $9 0
  ${DoUntil} ${FileExists} "$EXEDIR\lock-held.txt"
    Sleep 50
    IntOp $9 $9 + 1
    ${If} $9 >= 200
      SetErrorLevel 92
      Abort
    ${EndIf}
  ${Loop}
FunctionEnd
!endif
Function LegacyPage
  FileOpen $0 "$EXEDIR\legacy-page.reached" w
  FileWrite $0 "reached"
  FileClose $0
  Quit
FunctionEnd
Section
  !insertmacro NSIS_HOOK_PREINSTALL
  FileOpen $0 "$EXEDIR\install-section.reached" w
  FileWrite $0 "reached"
  FileClose $0
SectionEnd
