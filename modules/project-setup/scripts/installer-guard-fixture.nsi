Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!include LogicLib.nsh

; Match the template replacement point without including any real installer.
!macro CheckIfAppIsRunning executableName productName
  !error "The production hook must replace this macro"
!macroend
!include "${GUARD_FILE}"

Name "Creator Setup Guard Acceptance"
OutFile "${FIXTURE_EXE}"
Page custom LegacyPage
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LegacyPage
  ; A real upgrade can invoke the old uninstaller from this page. This fixture
  ; records reaching it, then exits without registry writes or installation.
  FileOpen $0 "$EXEDIR\legacy-page.reached" w
  FileWrite $0 "reached"
  FileClose $0
  Quit
FunctionEnd

Section
  !insertmacro CheckIfAppIsRunning "creator-project-setup.exe" "Creator Project Setup"
SectionEnd
