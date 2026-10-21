; Extra installer steps for electron-builder's NSIS installer.

; Uninstalling: take this copy's hooks out of ~/.claude/settings.json, so Claude Code
; doesn't keep calling a bridge that no longer exists. Skipped when the uninstall is
; part of an upgrade, which keeps the same paths. Never fails the uninstall.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\resources\node\node.exe" 0 +3
      nsExec::ExecToLog /TIMEOUT=8000 '"$INSTDIR\resources\node\node.exe" "$INSTDIR\resources\app\lib\claude-hooks.js" uninstall-this-copy'
      Pop $0
  ${endIf}
!macroend
