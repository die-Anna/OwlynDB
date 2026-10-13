; ---------------------------------------------------------------------------------------------------------------------
; Eigener Deinstallieren-Dialog
;
; electron-builder bindet build/installer.nsh vor seinen Vorlagen ein (node_modules/app-builder-lib/templates/nsis), und
; zwar in zwei Durchläufen: für das Deinstallationsprogramm (BUILD_UNINSTALLER) und für den Installer. Der Installer
; bleibt, wie er ist (One-Click). Im Deinstallationsprogramm tritt an die Stelle der Rückfrage-Box eine eigene Seite:
; Logo, was entfernt wird, auf Wunsch auch die Daten, ein Hinweis, wenn OwlynDB noch läuft; danach Fortschritt und
; Abschluss – hell oder dunkel wie die App. Still aufgerufen (/S, Updates) läuft alles wie bei electron-builder.
; ---------------------------------------------------------------------------------------------------------------------

!ifdef BUILD_UNINSTALLER
  !include LogicLib.nsh
  !include nsDialogs.nsh
  !include WinMessages.nsh
  !include WinVer.nsh
  ; für die stille App-Prüfung von electron-builder (siehe customCheckAppRunning; ohne eigenes Makro bindet
  ; allowOnlyOneInstallerInstance.nsh das selbst ein)
  !include getProcessInfo.nsh
  Var pid

  ; scharf bei 125 % oder 150 % Skalierung statt hochgerechnet
  ManifestDPIAware true
  UninstallCaption "${PRODUCT_NAME} deinstallieren"
  ; gleicher Titel auch während und nach dem Entfernen (sonst hängt NSIS »: Deinstalliere« an)
  UninstallSubCaption 1 " "
  UninstallSubCaption 2 " "

  ; Ordner der Profile – Tests lenken ihn um, damit nie ein echtes Profil gelöscht wird
  !define /ifndef OWLYN_APPDATA "$APPDATA"

  !define /ifndef STM_SETICON 0x0170
  !define /ifndef PBM_SETBARCOLOR 0x0409
  !define /ifndef PBM_SETBKCOLOR 0x2001

  ; Farben wie die App (ui/src/styles.scss): hell, dunkel
  !define owlynFg "0x1F2328 0xDFE1E5"
  !define owlynDim "0x66707B 0x9DA3AD"
  !define owlynDanger "0xC93C37 0xF06A64"
  !define owlynWarn "0xB26B00 0xE0A440"

  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.owlynGuiInit
  ; vor der Fortschrittsseite aus oneClick.nsh; die Abschlussseite folgt in customHeader
  UninstPage custom un.owlynConfirmShow un.owlynConfirmLeave

  ; $owlynTheme: 0 hell, 1 dunkel, 2 hoher Kontrast (dann die Systemfarben COLOR_WINDOWTEXT auf COLOR_WINDOW)
  !macro owlynColor HWND LIGHT DARK
    ${If} $owlynTheme == 1
      SetCtlColors ${HWND} ${DARK} 0x1E1F22
    ${ElseIf} $owlynTheme == 2
      SetCtlColors ${HWND} SYSCLR:8 SYSCLR:5
    ${Else}
      SetCtlColors ${HWND} ${LIGHT} 0xFFFFFF
    ${EndIf}
  !macroend

  !macro owlynHide ID
    GetDlgItem $0 $HWNDPARENT ${ID}
    ShowWindow $0 ${SW_HIDE}
  !macroend

  ; Pixel bei 96 dpi → Pixel auf diesem Bildschirm
  !macro owlynScale VAR PX
    IntOp ${VAR} ${PX} * $owlynDpi
    IntOp ${VAR} ${VAR} / 96
  !macroend

  !macro owlynSaveRegs
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
  !macroend

  !macro owlynRestoreRegs
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  !macroend

  ; Kopf einer Seite: Logo, Titel, Untertitel (Seite in $0)
  !macro owlynHead TITLE SUB
    ${NSD_CreateIcon} 14u 12u 32u 32u ""
    Pop $1
    !insertmacro owlynColor $1 ${owlynFg}
    !insertmacro owlynScale $2 48
    System::Call 'kernel32::GetModuleHandleW(p 0) p.r3'
    ; 103 = Symbol des Programms (hier das Logo); LoadIconWithScaleDown verkleinert sauber aus 256 px
    System::Call 'comctl32::LoadIconWithScaleDown(p r3, p 103, i r2, i r2, *p .r4) i.r5'
    ${If} $5 != 0
      System::Call 'user32::LoadImageW(p r3, p 103, i 1, i r2, i r2, i 0) p.r4'
    ${EndIf}
    SendMessage $1 ${STM_SETICON} $4 0
    ${NSD_CreateLabel} 56u 12u -70u 16u "${TITLE}"
    Pop $1
    SendMessage $1 ${WM_SETFONT} $owlynFontTitle 1
    !insertmacro owlynColor $1 ${owlynFg}
    ${NSD_CreateLabel} 56u 29u -70u 10u "${SUB}"
    Pop $1
    SendMessage $1 ${WM_SETFONT} $owlynFont 1
    !insertmacro owlynColor $1 ${owlynDim}
  !macroend

  ; App-Prüfung: still (Update, /S) wie electron-builder; sonst erst freundlich schließen (OwlynDB fragt selbst nach,
  ; wenn noch etwas offen ist) – ohne die Rückfrage-Box, die Seite hat schon darauf hingewiesen
  !macro customCheckAppRunning
    ${If} ${Silent}
      !insertmacro IS_POWERSHELL_AVAILABLE
      !insertmacro _CHECK_APP_RUNNING
    ${Else}
      Call un.owlynCloseApp
    ${EndIf}
  !macroend

  !macro customUnInit
    Call un.owlynInit
  !macroend

  !macro customUnInstall
    Call un.owlynUninstallStart
  !macroend

  !macro owlynFunctions
    Var owlynTheme
    Var owlynDpi
    Var owlynProfile
    Var owlynNewDir
    Var owlynHasData
    Var owlynDeleteData
    Var owlynRunning
    Var owlynProgress
    Var owlynFont
    Var owlynFontBold
    Var owlynFontTitle
    Var owlynCheck
    Var owlynDataText

    ; 1, wenn der Text (zweitoberster Stapelplatz) das Suchwort (oberster) enthält, sonst 0
    Function un.owlynContains
      Exch $1
      Exch
      Exch $0
      Push $2
      Push $3
      Push $4
      StrLen $2 $1
      StrCpy $3 0
      ${Do}
        StrCpy $4 $0 $2 $3
        ${If} $4 == ""
          StrCpy $4 0
          ${Break}
        ${EndIf}
        ${If} $4 == $1
          StrCpy $4 1
          ${Break}
        ${EndIf}
        IntOp $3 $3 + 1
      ${Loop}
      StrCpy $0 $4
      Pop $4
      Pop $3
      Pop $2
      Exch
      Pop $1
      Exch $0
    FunctionEnd

    ; 1, wenn im Ordner (oberster Stapelplatz) Daten liegen – wie electron/profile.ts
    Function un.owlynUsed
      Exch $0
      ${If} ${FileExists} "$0\connections.json"
      ${OrIf} ${FileExists} "$0\saved-queries.json"
      ${OrIf} ${FileExists} "$0\history.jsonl"
      ${OrIf} ${FileExists} "$0\ssh-host-keys.json"
        StrCpy $0 1
      ${Else}
        StrCpy $0 0
      ${EndIf}
      Exch $0
    FunctionEnd

    Function un.owlynInit
      !insertmacro owlynSaveRegs
      StrCpy $owlynDeleteData 0
      StrCpy $owlynProgress 0
      StrCpy $owlynCheck ""
      ; Profil wie electron/profile.ts: das neue, sonst ein benutztes altes (AtlasDB, dann dbviewer)
      StrCpy $owlynNewDir "${OWLYN_APPDATA}\${PRODUCT_NAME}"
      StrCpy $owlynProfile $owlynNewDir
      Push $owlynNewDir
      Call un.owlynUsed
      Pop $owlynHasData
      ${If} $owlynHasData == 0
        Push "${OWLYN_APPDATA}\AtlasDB"
        Call un.owlynUsed
        Pop $owlynHasData
        ${If} $owlynHasData == 1
          StrCpy $owlynProfile "${OWLYN_APPDATA}\AtlasDB"
        ${Else}
          Push "${OWLYN_APPDATA}\dbviewer"
          Call un.owlynUsed
          Pop $owlynHasData
          ${If} $owlynHasData == 1
            StrCpy $owlynProfile "${OWLYN_APPDATA}\dbviewer"
          ${EndIf}
        ${EndIf}
      ${EndIf}

      ; Darstellung: hoher Kontrast hat Vorrang (HIGHCONTRAST.dwFlags & HCF_HIGHCONTRASTON), dann die Wahl in OwlynDB
      ; (⋯-Menü), sonst wie Windows
      StrCpy $owlynTheme ""
      System::Call '*(i 12, i 0, p 0) p.r1'
      System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r1, i 0)'
      System::Call '*$1(i, i .r2)'
      System::Free $1
      IntOp $2 $2 & 1
      ${If} $2 == 1
        StrCpy $owlynTheme 2
      ${EndIf}
      ClearErrors
      FileOpen $0 "$owlynProfile\ui-theme.json" r
      ${If} $owlynTheme == ""
      ${AndIfNot} ${Errors}
        FileRead $0 $1
        FileClose $0
        Push $1
        Push '"dark"'
        Call un.owlynContains
        Pop $0
        ${If} $0 == 1
          StrCpy $owlynTheme 1
        ${Else}
          Push $1
          Push '"light"'
          Call un.owlynContains
          Pop $0
          ${If} $0 == 1
            StrCpy $owlynTheme 0
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${If} $owlynTheme == ""
        ClearErrors
        ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
        ${If} ${Errors}
        ${OrIf} $0 <> 0
          StrCpy $owlynTheme 0
        ${Else}
          StrCpy $owlynTheme 1
        ${EndIf}
      ${EndIf}
      !insertmacro owlynRestoreRegs
    FunctionEnd

    ; $owlynRunning: 1, wenn OwlynDB.exe dieser Installation läuft – dann lässt sie sich nicht zum Schreiben öffnen
    ; (ERROR_SHARING_VIOLATION; andere Fehler wie fehlende Rechte zählen nicht)
    Function un.owlynIsRunning
      Push $0
      Push $1
      StrCpy $owlynRunning 0
      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) i.r0 ?e'
        Pop $1
        ${If} $0 = -1
          ${If} $1 = 32
            StrCpy $owlynRunning 1
          ${EndIf}
        ${Else}
          System::Call 'kernel32::CloseHandle(i r0)'
        ${EndIf}
      ${EndIf}
      Pop $1
      Pop $0
    FunctionEnd

    Function un.owlynGuiInit
      System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
      ${If} $0 < 96
        System::Call 'user32::GetDC(p 0) p.r1'
        System::Call 'gdi32::GetDeviceCaps(p r1, i 88) i.r0'
        System::Call 'user32::ReleaseDC(p 0, p r1)'
      ${EndIf}
      StrCpy $owlynDpi $0
      CreateFont $owlynFont "Segoe UI" 10 400
      CreateFont $owlynFontBold "Segoe UI" 10 600
      CreateFont $owlynFontTitle "Segoe UI" 13 600

      ${If} $owlynTheme == 1
        ; dunkle Titelleiste (Windows 11 und 10 ab 2004: 20, davor 19)
        System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i.r0'
        ${If} $0 != 0
          System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
        ${EndIf}
      ${EndIf}
      !insertmacro owlynColor $HWNDPARENT ${owlynFg}

      ; Kopf der Vorlage, Linien, Markentext und »Zurück« weg
      !insertmacro owlynHide 1034
      !insertmacro owlynHide 1035
      !insertmacro owlynHide 1036
      !insertmacro owlynHide 1037
      !insertmacro owlynHide 1038
      !insertmacro owlynHide 1039
      !insertmacro owlynHide 1028
      !insertmacro owlynHide 1256
      !insertmacro owlynHide 3

      ; Fenster innen: $2 breit, $3 hoch
      System::Call '*(i, i, i, i) p.r1'
      System::Call 'user32::GetClientRect(p $HWNDPARENT, p r1)'
      System::Call '*$1(i, i, i .r2, i .r3)'
      System::Free $1
      ; Knöpfe: breiter, rechts unten wie in den Dialogen der App
      GetDlgItem $4 $HWNDPARENT 1
      System::Call '*(i, i, i, i) p.r1'
      System::Call 'user32::GetWindowRect(p r4, p r1)'
      System::Call '*$1(i .r5, i .r6, i .r7, i .r8)'
      System::Free $1
      IntOp $9 $8 - $6
      !insertmacro owlynScale $5 112
      !insertmacro owlynScale $6 16
      !insertmacro owlynScale $7 8
      IntOp $8 $3 - $6
      IntOp $8 $8 - $9
      ; Abbrechen ganz rechts, davor der Hauptknopf
      IntOp $1 $2 - $6
      IntOp $1 $1 - $5
      GetDlgItem $0 $HWNDPARENT 2
      System::Call 'user32::SetWindowPos(p r0, p 0, i r1, i r8, i r5, i r9, i 0x14)'
      IntOp $1 $1 - $7
      IntOp $1 $1 - $5
      System::Call 'user32::SetWindowPos(p r4, p 0, i r1, i r8, i r5, i r9, i 0x14)'
      ${ForEach} $1 1 2 + 1
        GetDlgItem $0 $HWNDPARENT $1
        SendMessage $0 ${WM_SETFONT} $owlynFont 1
        ${If} $owlynTheme == 1
          System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
        ${EndIf}
      ${Next}
      ; Seitenfläche: ganze Breite, vom oberen Rand bis über die Knöpfe
      IntOp $8 $8 - $6
      GetDlgItem $0 $HWNDPARENT 1018
      System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i r2, i r8, i 0x14)'
    FunctionEnd

    ; Text unter »Auch die Daten löschen«, je nach Haken
    Function un.owlynDataText
      ${NSD_GetState} $owlynCheck $0
      ${If} $0 == ${BST_CHECKED}
        ${NSD_SetText} $owlynDataText "Verbindungen samt Passwörtern, Verlauf, gespeicherte Abfragen und Einstellungen werden endgültig gelöscht."
        !insertmacro owlynColor $owlynDataText ${owlynDanger}
      ${Else}
        ${NSD_SetText} $owlynDataText "Verbindungen samt Passwörtern, Verlauf, gespeicherte Abfragen und Einstellungen bleiben sonst erhalten – eine neue Installation findet sie wieder."
        !insertmacro owlynColor $owlynDataText ${owlynDim}
      ${EndIf}
      System::Call 'user32::InvalidateRect(p $owlynDataText, p 0, i 1)'
    FunctionEnd

    Function un.owlynDataToggle
      Pop $0
      Call un.owlynDataText
    FunctionEnd

    Function un.owlynConfirmShow
      Call un.owlynIsRunning
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      !insertmacro owlynColor $0 ${owlynFg}
      !insertmacro owlynHead "${PRODUCT_NAME} deinstallieren" "Version ${VERSION}"

      ${NSD_CreateLabel} 56u 46u -70u 26u "Entfernt werden das Programm und seine Verknüpfungen auf dem Desktop und im Startmenü."
      Pop $1
      SendMessage $1 ${WM_SETFONT} $owlynFont 1
      !insertmacro owlynColor $1 ${owlynFg}

      ${If} ${FileExists} "$owlynProfile\*.*"
        ${NSD_CreateCheckbox} 56u 76u -70u 12u "Auch die Daten löschen"
        Pop $owlynCheck
        SendMessage $owlynCheck ${WM_SETFONT} $owlynFontBold 1
        !insertmacro owlynColor $owlynCheck ${owlynFg}
        ${If} $owlynTheme == 1
          ; Windows 11 zeichnet den Text dunkler Kontrollkästchen hell, Windows 10 schwarz – dort ohne Windows-Stil,
          ; dann gilt die eigene Textfarbe
          ${WinVerGetBuild} $2
          ${If} $2 >= 22000
            System::Call 'uxtheme::SetWindowTheme(p $owlynCheck, w "DarkMode_Explorer", p 0)'
          ${Else}
            System::Call 'uxtheme::SetWindowTheme(p $owlynCheck, w "", w "")'
          ${EndIf}
        ${EndIf}
        ${NSD_OnClick} $owlynCheck un.owlynDataToggle
        ${NSD_CreateLabel} 68u 90u -82u 36u ""
        Pop $owlynDataText
        SendMessage $owlynDataText ${WM_SETFONT} $owlynFont 1
        Call un.owlynDataText
        ; Ordner in einer Zeile, zu lange Pfade in der Mitte gekürzt (SS_PATHELLIPSIS)
        ${NSD_CreateLabel} 68u 127u -82u 11u "Ordner: $owlynProfile"
        Pop $1
        ${NSD_AddStyle} $1 0x8000
        SendMessage $1 ${WM_SETFONT} $owlynFont 1
        !insertmacro owlynColor $1 ${owlynDim}
      ${EndIf}

      ${If} $owlynRunning == 1
        ${NSD_CreateLabel} 56u -30u -70u 24u "${PRODUCT_NAME} ist noch geöffnet und wird zum Deinstallieren geschlossen – bei ungespeicherten Änderungen fragt es vorher nach."
        Pop $1
        SendMessage $1 ${WM_SETFONT} $owlynFont 1
        !insertmacro owlynColor $1 ${owlynWarn}
      ${EndIf}

      GetDlgItem $1 $HWNDPARENT 1
      SendMessage $1 ${WM_SETTEXT} 0 "STR:Deinstallieren"
      GetDlgItem $1 $HWNDPARENT 3
      ShowWindow $1 ${SW_HIDE}
      nsDialogs::Show
    FunctionEnd

    Function un.owlynConfirmLeave
      ${If} $owlynCheck != ""
        ${NSD_GetState} $owlynCheck $0
        ${If} $0 == ${BST_CHECKED}
          StrCpy $owlynDeleteData 1
        ${EndIf}
      ${EndIf}
    FunctionEnd

    ; Fortschrittsseite (eingebaute Seite, läuft im Arbeits-Thread): Farben, Schrift, Lage
    Function un.owlynProgressPage
      ${If} $owlynProgress == 1
        Return
      ${EndIf}
      StrCpy $owlynProgress 1
      !insertmacro owlynSaveRegs
      FindWindow $0 "#32770" "" $HWNDPARENT
      ; NSIS setzt bei eingebauten Seiten nur die Lage, nicht die Größe
      GetDlgItem $1 $HWNDPARENT 1018
      System::Call '*(i, i, i, i) p.r2'
      System::Call 'user32::GetWindowRect(p r1, p r2)'
      System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)'
      System::Call '*$2(i .r3, i .r4, i .r5, i .r6)'
      System::Free $2
      IntOp $5 $5 - $3
      IntOp $6 $6 - $4
      System::Call 'user32::SetWindowPos(p r0, p 0, i r3, i r4, i r5, i r6, i 0x14)'
      !insertmacro owlynColor $0 ${owlynFg}
      ; Statuszeile groß, darunter der Balken – mit Rand, etwas über der Mitte
      !insertmacro owlynScale $7 24
      IntOp $8 $5 - $7
      IntOp $8 $8 - $7
      IntOp $9 $6 * 36
      IntOp $9 $9 / 100
      !insertmacro owlynScale $3 30
      GetDlgItem $1 $0 1006
      SendMessage $1 ${WM_SETFONT} $owlynFontTitle 1
      !insertmacro owlynColor $1 ${owlynFg}
      System::Call 'user32::SetWindowPos(p r1, p 0, i r7, i r9, i r8, i r3, i 0x14)'
      IntOp $9 $9 + $3
      !insertmacro owlynScale $4 10
      IntOp $9 $9 + $4
      !insertmacro owlynScale $3 6
      GetDlgItem $1 $0 1004
      System::Call 'user32::SetWindowPos(p r1, p 0, i r7, i r9, i r8, i r3, i 0x14)'
      ${If} $owlynTheme == 1
        ; ohne Windows-Stil, damit die Farben greifen (BGR)
        System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
        SendMessage $1 ${PBM_SETBKCOLOR} 0 0x35302D
        SendMessage $1 ${PBM_SETBARCOLOR} 0 0xF08A4D
      ${EndIf}
      ; Knöpfe gibt es hier nichts zu drücken
      ${ForEach} $2 1 3 + 1
        GetDlgItem $1 $HWNDPARENT $2
        ShowWindow $1 ${SW_HIDE}
      ${Next}
      !insertmacro owlynRestoreRegs
    FunctionEnd

    ; OwlynDB schließen, bevor Dateien verschwinden: Hauptfenster wie mit dem X (OwlynDB fragt bei laufenden Abfragen
    ; oder ungespeicherten Änderungen selbst nach), bis 30 s warten, dann auf Wunsch beenden
    Function un.owlynCloseApp
      Call un.owlynProgressPage
      Call un.owlynIsRunning
      ${If} $owlynRunning == 0
        Return
      ${EndIf}
      !insertmacro owlynSaveRegs
      SetDetailsPrint textonly
      DetailPrint "${PRODUCT_NAME} wird geschlossen …"
      SetDetailsPrint none
      ; Prozesse dieser Installation über Win32_Process: das Deinstallationsprogramm ist 32 Bit, Get-Process kennt dort
      ; den Pfad von 64-Bit-Prozessen nicht
      System::Call 'kernel32::SetEnvironmentVariableW(w "OWLYN_DIR", w "$INSTDIR\")'
      StrCpy $1 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$env:OWLYN_DIR, 'OrdinalIgnoreCase') } | ForEach-Object {`
      nsExec::Exec `$1 $$p = Get-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue; if ($$p) { [void]$$p.CloseMainWindow() } }"`
      Pop $0
      StrCpy $2 0
      ${Do}
        Sleep 500
        Call un.owlynIsRunning
        ${If} $owlynRunning == 0
          ${Break}
        ${EndIf}
        IntOp $2 $2 + 1
      ${LoopUntil} $2 >= 60
      ${If} $owlynRunning == 1
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "${PRODUCT_NAME} ist noch geöffnet – vielleicht wartet dort noch eine Rückfrage.$\r$\n$\r$\nJetzt sofort beenden? Nicht Gespeichertes geht dabei verloren.$\r$\n»Nein« bricht die Deinstallation ab." IDYES owlynKill
        SetErrorLevel 1
        Quit
        owlynKill:
        nsExec::Exec `$1 Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
        Pop $0
        StrCpy $2 0
        ${Do}
          Sleep 500
          Call un.owlynIsRunning
          ${If} $owlynRunning == 0
            ${Break}
          ${EndIf}
          IntOp $2 $2 + 1
        ${LoopUntil} $2 >= 20
        ${If} $owlynRunning == 1
          MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} lässt sich nicht beenden. Bitte ${PRODUCT_NAME} schließen und die Deinstallation danach erneut starten."
          SetErrorLevel 1
          Quit
        ${EndIf}
      ${EndIf}
      !insertmacro owlynRestoreRegs
    FunctionEnd

    ; Anfang der Deinstallation (vor dem Entfernen der Dateien); bei Updates nichts davon
    Function un.owlynUninstallStart
      ${If} ${isUpdated}
        Return
      ${EndIf}
      ${If} ${isDeleteAppData}
        StrCpy $owlynDeleteData 1
      ${EndIf}
      ${IfNot} ${Silent}
        Call un.owlynProgressPage
        ; nach dem Entfernen gleich weiter zur Abschlussseite
        SetAutoClose true
      ${EndIf}
      ${If} $owlynDeleteData == 1
        SetDetailsPrint textonly
        DetailPrint "Daten werden gelöscht …"
        SetDetailsPrint none
        RMDir /r "$owlynProfile"
        ${If} $owlynNewDir != $owlynProfile
          RMDir /r "$owlynNewDir"
        ${EndIf}
        ; Reste: eine Datei war gesperrt (2 = nicht vollständig gelöscht)
        ${If} ${FileExists} "$owlynProfile\*.*"
        ${OrIf} ${FileExists} "$owlynNewDir\*.*"
          StrCpy $owlynDeleteData 2
        ${EndIf}
      ${EndIf}
      SetDetailsPrint textonly
      DetailPrint "${PRODUCT_NAME} wird entfernt …"
      SetDetailsPrint none
    FunctionEnd

    Function un.owlynDoneShow
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      !insertmacro owlynColor $0 ${owlynFg}
      !insertmacro owlynHead "${PRODUCT_NAME} ist deinstalliert" "Version ${VERSION}"
      ; $2: Ordner nennen
      StrCpy $2 0
      ${If} $owlynDeleteData == 1
        ${NSD_CreateLabel} 56u 46u -70u 26u "Verbindungen, Verlauf und Einstellungen sind ebenfalls gelöscht."
        Pop $1
        SendMessage $1 ${WM_SETFONT} $owlynFont 1
        !insertmacro owlynColor $1 ${owlynFg}
      ${ElseIf} $owlynDeleteData == 2
        ${NSD_CreateLabel} 56u 46u -70u 26u "Die Daten ließen sich nicht vollständig löschen – vielleicht läuft noch ein ${PRODUCT_NAME}, etwa die portable Version."
        Pop $1
        SendMessage $1 ${WM_SETFONT} $owlynFont 1
        !insertmacro owlynColor $1 ${owlynWarn}
        StrCpy $2 1
      ${ElseIf} $owlynHasData == 1
        ${NSD_CreateLabel} 56u 46u -70u 26u "Verbindungen, Verlauf und Einstellungen sind noch da – eine neue Installation findet sie wieder."
        Pop $1
        SendMessage $1 ${WM_SETFONT} $owlynFont 1
        !insertmacro owlynColor $1 ${owlynFg}
        StrCpy $2 1
      ${EndIf}
      ${If} $2 == 1
        ${NSD_CreateLabel} 56u 73u -70u 11u "Ordner: $owlynProfile"
        Pop $1
        ${NSD_AddStyle} $1 0x8000
        SendMessage $1 ${WM_SETFONT} $owlynFont 1
        !insertmacro owlynColor $1 ${owlynDim}
      ${EndIf}
      ; »Schließen« allein ganz rechts, an der Stelle von »Abbrechen«
      GetDlgItem $2 $HWNDPARENT 2
      ShowWindow $2 ${SW_HIDE}
      System::Call '*(i, i, i, i) p.r3'
      System::Call 'user32::GetWindowRect(p r2, p r3)'
      System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r3, i 2)'
      System::Call '*$3(i .r4, i .r5)'
      System::Free $3
      GetDlgItem $1 $HWNDPARENT 1
      SendMessage $1 ${WM_SETTEXT} 0 "STR:Schließen"
      System::Call 'user32::SetWindowPos(p r1, p 0, i r4, i r5, i 0, i 0, i 0x15)'
      ShowWindow $1 ${SW_SHOW}
      GetDlgItem $1 $HWNDPARENT 3
      ShowWindow $1 ${SW_HIDE}
      nsDialogs::Show
    FunctionEnd
  !macroend
!endif

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    ; ohne ONE_CLICK zeigt uninstaller.nsh keine Rückfrage-Box, läuft nicht still und beendet sich nicht gleich nach dem
    ; Entfernen – das übernehmen die Seiten hier
    !undef ONE_CLICK
    UninstPage custom un.owlynDoneShow
    !insertmacro owlynFunctions
  !endif
!macroend
