; Single-file portable launcher: unpack runtime, run as the current user, and
; keep persistent WebView/account data beside the original launcher.
Unicode true
!include "LogicLib.nsh"
!include "x64.nsh"

Name "MyJellyfinClient Portable"
OutFile "${OUTPUT_FILE}"
Icon "${APP_ICON}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
SetCompressor /SOLID lzma
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "MyJellyfinClient Portable"
VIAddVersionKey /LANG=1033 "FileDescription" "MyJellyfinClient portable launcher"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "MyJellyfinClient contributors"

Var DataDir
Var AppExitCode

Section
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "MyJellyfinClient requires Windows x64."
    SetErrorLevel 1
    Quit
  ${EndIf}

  StrCpy $DataDir "$EXEDIR\MyJellyfinClient-data"
  ClearErrors
  CreateDirectory "$DataDir"
  GetTempFileName $0 "$DataDir"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Cannot write portable data beside this EXE. Move it to a writable folder and try again."
    SetErrorLevel 1
    Quit
  ${EndIf}
  Delete "$0"

  InitPluginsDir
  ClearErrors
  !include /CHARSET=UTF8 "${PAYLOAD_MANIFEST}"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Unable to unpack the application. Check free disk space and try again."
    SetErrorLevel 1
    Quit
  ${EndIf}

  System::Call 'kernel32::SetEnvironmentVariableW(w "MJC_WEBVIEW_DATA", w "$DataDir") i.r0'
  ${If} $0 == 0
    MessageBox MB_OK|MB_ICONSTOP "Unable to configure portable data."
    SetErrorLevel 1
    Quit
  ${EndIf}
  SetOutPath "$PLUGINSDIR\app"
  ClearErrors
  ExecWait '"$PLUGINSDIR\app\my-jellyfin-client.exe"' $AppExitCode
  SetOutPath "$EXEDIR"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Unable to start MyJellyfinClient. Microsoft Edge WebView2 Runtime must be installed."
    SetErrorLevel 1
  ${Else}
    SetErrorLevel $AppExitCode
  ${EndIf}
  ; NSIS removes its unique plugin directory after the application exits.
SectionEnd
