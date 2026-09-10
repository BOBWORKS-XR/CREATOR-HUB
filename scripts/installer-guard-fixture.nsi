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
