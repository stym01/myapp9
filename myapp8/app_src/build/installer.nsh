; electron-builder NSIS include: runs before the "app running" check and
; before old files are removed on update/uninstall.
;
; Every Solvro version back to well before 2.3.0 starts a native helper
; process (WinKeyServer.exe, from node-global-key-listener) that older
; builds never terminate on quit. That orphaned process keeps files in the
; install directory locked, which makes the installer fail with
; "Solvro cannot be closed" / "Failed to uninstall old application files".
;
; 2.3.1+ kills it properly on quit (see main.js's will-quit handler), but an
; update FROM an older, already-running version still hits this, since the
; bug is in the version that's quitting, not the one being installed. Killing
; the helper here fixes it unconditionally, for upgrades from any old
; version, without depending on the old app's code.
;
; This is the NEW version's installer, whichever version started it, so the
; rules below also hold for updates coming from older builds:
;
; 1. An update never shows the wizard. Older builds start it without /S when
;    "Install & restart" is clicked.
; 2. An update only installs after a PC restart, or when the user clicked "Install
;    & restart". Older builds also start this installer whenever the app closes,
;    which is also how the overlay opens. That run stops here without touching
;    anything and leaves the update for the next restart.
; 3. Even then, nothing in use gets interrupted. The installer has to replace
;    hope.exe and the app, so if either is running it stops and tries again after
;    the next restart.
; 4. An update never brings back an app that has been uninstalled.

; Windows runs this once at the next sign-in, then forgets it.
!define UPDATE_RUN_ONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define UPDATE_RUN_ONCE_VALUE "SolvroUpdate"

!macro deferUpdateUntilRestart
  WriteRegStr HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_VALUE}" `"$EXEPATH" --updated /S --at-restart`
  Quit
!macroend

!macro preInit
  ${if} ${isUpdated}
    SetSilent silent
  ${endif}
!macroend

!macro customInit
  ${if} ${isUpdated}
    ${ifNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Quit
    ${endif}

    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--at-restart" $R1
    ${if} ${Errors}
    ${andIfNot} ${isForceRun}
      !insertmacro deferUpdateUntilRestart
    ${endif}

    ${nsProcess::FindProcess} "hope.exe" $R0
    ${if} $R0 == 0
      !insertmacro deferUpdateUntilRestart
    ${endif}

    ; After "Install & restart" the app has just been told to quit, so give it a
    ; moment. A running program's file can't be opened for writing (error 32), so
    ; still locked after that means the app is in use. Any other error isn't that:
    ; an install for all users hasn't asked for admin rights yet, so it can't open
    ; the file either way.
    StrCpy $2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $R1 0
    ${do}
      System::Call 'kernel32::CreateFileW(w r2, i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r0 ?e'
      Pop $1
      ${if} $0 <> -1
        System::Call 'kernel32::CloseHandle(p r0)'
        ${exitdo}
      ${endif}
      ${if} $1 != 32
        ${exitdo}
      ${endif}
      IntOp $R1 $R1 + 1
      ${if} $R1 >= 6
        !insertmacro deferUpdateUntilRestart
      ${endif}
      Sleep 1000
    ${loop}
  ${else}
    nsExec::Exec 'taskkill /F /IM hope.exe'
  ${endif}
  nsExec::Exec 'taskkill /F /IM WinKeyServer.exe'
  ; Whitelist BOTH the install directory and the hope subfolder in Windows
  ; Defender BEFORE files are extracted, so nothing gets quarantined mid-install.
  nsExec::Exec 'powershell -NoProfile -Command "Add-MpPreference -ExclusionPath \"$INSTDIR\",\"$INSTDIR\resources\hope\" -ErrorAction SilentlyContinue"'
!macroend

; After install completes: create a scheduled task so hope.exe can run
; elevated without a UAC prompt every time. The installer is already
; elevated, so schtasks /create with /rl HIGHEST succeeds here and the
; task persists — Electron triggers it later with schtasks /run.
!macro customInstall
  ; Installed now, so a run scheduled for after the next restart has nothing to do.
  DeleteRegValue HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_VALUE}"
  nsExec::Exec 'schtasks /delete /tn "SolvroHope" /f'
  nsExec::Exec 'schtasks /create /tn "SolvroHope" /tr "\"$INSTDIR\resources\hope\hope.exe\" --launcher \"$INSTDIR\Solvro.exe\"" /sc ONCE /st 00:00 /sd 01/01/2099 /rl HIGHEST /f'
  ; Allow the task to run on battery power (schtasks defaults to disabling this)
  nsExec::Exec 'powershell -NoProfile -Command "$$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Set-ScheduledTask -TaskName SolvroHope -Settings $$s -ErrorAction SilentlyContinue"'
!macroend

; Clean up on uninstall
!macro customUnInit
  DeleteRegValue HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_VALUE}"
  nsExec::Exec 'taskkill /F /IM WinKeyServer.exe'
  nsExec::Exec 'taskkill /F /IM hope.exe'
  nsExec::Exec 'schtasks /delete /tn "SolvroHope" /f'
  nsExec::Exec 'powershell -NoProfile -Command "Remove-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
!macroend
