; Assistant d'installation du tracker Les Ailes Françaises
Unicode true
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VERSION4
  !define VERSION4 "0.0.0.0"
!endif
!define APP "Air France Virtuel Tracker"
!define EXE "Air France Virtuel Tracker.exe" ; nom de fichier gardé pour les mises à jour
!define SHORT "Les Ailes Françaises - Tracker"
!define MENU "Les Ailes Françaises"
!define UNINST "Désinstaller Air France Virtuel Tracker.exe"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\fr.airfrancevirtuel.tracker"
!define REGKEY "Software\Air France Virtuel\Tracker"

Name "${APP}"
Caption "Installation – Les Ailes Françaises · Tracker ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${REGKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Les Ailes Françaises · Tracker de vol ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"
!include "LogicLib.nsh"

!define MUI_ICON "${RES}\icon.ico"
!define MUI_UNICON "${RES}\icon.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${RES}\sidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${RES}\sidebar.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${RES}\header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "${RES}\header.bmp"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Veux-tu vraiment annuler l'installation du tracker Les Ailes Françaises ?"

!define MUI_WELCOMEPAGE_TITLE "Bienvenue dans l'installation du tracker Les Ailes Françaises"
!define MUI_WELCOMEPAGE_TEXT "Cet assistant va installer le tracker de vol Les Ailes Françaises ${VERSION} (bêta) sur ton ordinateur.$\r$\n$\r$\nLe tracker suit tes vols dans Microsoft Flight Simulator 2020 et 2024 : phases du vol, Max ton copilote, annonces à bord, hangar et rapport de vol.$\r$\n$\r$\nLes prochaines versions s'installeront automatiquement.$\r$\n$\r$\nClique sur Suivant pour continuer."
!insertmacro MUI_PAGE_WELCOME
!define MUI_LICENSEPAGE_TEXT_TOP "Lis les conditions d'utilisation du tracker."
!insertmacro MUI_PAGE_LICENSE "${RES}\licence.txt"
!insertmacro MUI_PAGE_DIRECTORY
!define MUI_PAGE_CUSTOMFUNCTION_SHOW InstShow
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Le tracker est installé"
!define MUI_FINISHPAGE_TEXT "Le tracker Les Ailes Françaises est prêt.$\r$\n$\r$\nTu le retrouves sur ton bureau et dans le menu Démarrer.$\r$\n$\r$\nBons vols !"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Lancer le tracker maintenant"
!insertmacro MUI_PAGE_FINISH

!define MUI_WELCOMEPAGE_TITLE "Désinstallation du tracker Les Ailes Françaises"
!define MUI_WELCOMEPAGE_TEXT "Cet assistant va retirer le tracker de ton ordinateur.$\r$\n$\r$\nTes réglages, ta flotte, tes sons et tes rapports de vol sont conservés : tu les retrouveras si tu réinstalles le tracker."
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "French"

VIProductVersion "${VERSION4}"
VIAddVersionKey /LANG=${LANG_FRENCH} "ProductName" "${APP}"
VIAddVersionKey /LANG=${LANG_FRENCH} "CompanyName" "Les Ailes Françaises"
VIAddVersionKey /LANG=${LANG_FRENCH} "FileDescription" "Installation du tracker Les Ailes Françaises"
VIAddVersionKey /LANG=${LANG_FRENCH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_FRENCH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_FRENCH} "LegalCopyright" "Les Ailes Françaises - projet de loisir non officiel, sans lien avec Air France"

; ---------- écran d'installation « premium » ----------
; La page standard d'installation est rhabillée : image à gauche, panneau bleu à droite,
; pourcentage, barre rouge et étapes cochées une à une. L'installation elle-même ne change pas.
Var Inner
Var LPct
Var LEta
Var S1
Var S2
Var S3
Var S4
Var S5
Var FBig
Var FTitle
Var FText

Function .onInit
  InitPluginsDir
  File "/oname=$PLUGINSDIR\progress.bmp" "${RES}\progress.bmp"
FunctionEnd

; Crée un texte (STATIC) dans la page : x y largeur hauteur (en pixels), texte, police, couleur
!macro AFV_LABEL VAR X Y W H TEXT FONT COLOR
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i 0x50000000, i ${X}, i ${Y}, i ${W}, i ${H}, p $Inner, p 0, p 0, p 0) p.s'
  Pop ${VAR}
  SendMessage ${VAR} ${WM_SETFONT} ${FONT} 1
  SetCtlColors ${VAR} ${COLOR} 0x0A1E4A
!macroend

Function InstShow
  FindWindow $Inner "#32770" "" $HWNDPARENT
  ${If} $Inner == 0
    Return
  ${EndIf}
  ; zone plein écran (celle des pages Bienvenue et Fin)
  GetDlgItem $0 $HWNDPARENT 1044
  System::Call "*(i 0, i 0, i 0, i 0) p.r1"
  System::Call "user32::GetWindowRect(p r0, p r1)"
  System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r1, i 2)"
  System::Call "*$1(i .r2, i .r3, i .r4, i .r5)"
  System::Free $1
  IntOp $6 $4 - $2
  IntOp $7 $5 - $3
  ${If} $6 < 200
    Return
  ${EndIf}
  ; on cache l'en-tête blanc et on agrandit la page
  ${ForEach} $8 1034 1039 + 1
    GetDlgItem $9 $HWNDPARENT $8
    ShowWindow $9 ${SW_HIDE}
  ${Next}
  System::Call "user32::SetWindowPos(p $Inner, p 0, i r2, i r3, i r6, i r7, i 0x14)"
  SetCtlColors $Inner 0xFFFFFF 0x0A1E4A
  ; échelle : la maquette fait 314 pixels de haut
  IntOp $R9 $7 * 1000
  IntOp $R9 $R9 / 314
  ; image de gauche (44 % de la largeur)
  IntOp $R0 $6 * 44
  IntOp $R0 $R0 / 100
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5000004E, i 0, i 0, i $R0, i r7, p $Inner, p 0, p 0, p 0) p.r8'
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\progress.bmp", i 0, i $R0, i r7, i 0x10) p.r9'
  SendMessage $8 0x172 0 $9
  ; panneau de droite
  IntOp $R1 $R0 + 22
  IntOp $R2 $6 - $R1
  IntOp $R2 $R2 - 20
  IntOp $R3 22 * $R9
  IntOp $R3 $R3 / 1000
  IntOp $R4 28 * $R9
  IntOp $R4 $R4 / 1000
  IntOp $R5 50 * $R9
  IntOp $R5 $R5 / 1000
  CreateFont $FTitle "Segoe UI" 11 700
  CreateFont $FBig "Segoe UI" 24 800
  CreateFont $FText "Segoe UI" 9 400
  IntOp $0 22 * $R9
  IntOp $0 $0 / 1000
  !insertmacro AFV_LABEL $8 $R1 $0 $R2 $R4 "Installation en cours" $FTitle 0xFFFFFF
  IntOp $0 56 * $R9
  IntOp $0 $0 / 1000
  !insertmacro AFV_LABEL $LPct $R1 $0 $R2 $R5 "0 %" $FBig 0xFFFFFF
  ; barre de progression (celle de Windows, recolorée en rouge)
  GetDlgItem $8 $Inner 1004
  IntOp $0 108 * $R9
  IntOp $0 $0 / 1000
  System::Call "user32::SetWindowPos(p r8, p 0, i $R1, i r0, i $R2, i 8, i 0x14)"
  System::Call 'uxtheme::SetWindowTheme(p r8, w " ", w " ")'
  SendMessage $8 0x409 0 0x2E10C8
  SendMessage $8 0x2001 0 0x783A1E
  IntOp $0 122 * $R9
  IntOp $0 $0 / 1000
  !insertmacro AFV_LABEL $LEta $R1 $0 $R2 $R3 "Préparation…" $FText 0xC9D4EE
  ; on cache le texte d'état, la liste et le bouton « Détails »
  ${ForEach} $9 1006 1006 + 1
    GetDlgItem $8 $Inner $9
    ShowWindow $8 ${SW_HIDE}
  ${Next}
  GetDlgItem $8 $Inner 1016
  ShowWindow $8 ${SW_HIDE}
  GetDlgItem $8 $Inner 1027
  ShowWindow $8 ${SW_HIDE}
  ; étapes
  IntOp $0 156 * $R9
  IntOp $0 $0 / 1000
  !insertmacro AFV_LABEL $S1 $R1 $0 $R2 $R3 "○   Vérification de l’ordinateur" $FText 0x8FA3D3
  IntOp $0 $0 + $R4
  !insertmacro AFV_LABEL $S2 $R1 $0 $R2 $R3 "○   Copie des fichiers" $FText 0x8FA3D3
  IntOp $0 $0 + $R4
  !insertmacro AFV_LABEL $S3 $R1 $0 $R2 $R3 "○   Raccourcis bureau et menu Démarrer" $FText 0x8FA3D3
  IntOp $0 $0 + $R4
  !insertmacro AFV_LABEL $S4 $R1 $0 $R2 $R3 "○   Inscription dans Windows" $FText 0x8FA3D3
  IntOp $0 $0 + $R4
  !insertmacro AFV_LABEL $S5 $R1 $0 $R2 $R3 "○   Mises à jour automatiques" $FText 0x8FA3D3
FunctionEnd

; Met à jour une étape : 0 = en cours, 1 = terminée ; et le pourcentage
!macro AFV_STEP VAR STATE TEXT PCT
  ${If} ${VAR} != ""
    ${If} ${STATE} == 1
      SendMessage ${VAR} ${WM_SETTEXT} 0 "STR:✓   ${TEXT}"
      SetCtlColors ${VAR} 0x3DDC84 0x0A1E4A
    ${Else}
      SendMessage ${VAR} ${WM_SETTEXT} 0 "STR:●   ${TEXT}"
      SetCtlColors ${VAR} 0xFFFFFF 0x0A1E4A
    ${EndIf}
    System::Call "user32::InvalidateRect(p ${VAR}, p 0, i 1)"
  ${EndIf}
  ${If} $LPct != ""
    SendMessage $LPct ${WM_SETTEXT} 0 "STR:${PCT} %"
    System::Call "user32::InvalidateRect(p $LPct, p 0, i 1)"
  ${EndIf}
!macroend
!macro AFV_ETA TEXT
  ${If} $LEta != ""
    SendMessage $LEta ${WM_SETTEXT} 0 "STR:${TEXT}"
    System::Call "user32::InvalidateRect(p $LEta, p 0, i 1)"
  ${EndIf}
!macroend

Section "Tracker" SecMain
  SectionIn RO
  !insertmacro AFV_STEP $S1 0 "Vérification de l’ordinateur" 2
  !insertmacro AFV_ETA "Fermeture du tracker s’il est ouvert…"
  DetailPrint "Fermeture du tracker s'il est ouvert…"
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 800
  !insertmacro AFV_STEP $S1 1 "Vérification de l’ordinateur" 8
  !insertmacro AFV_STEP $S2 0 "Copie des fichiers" 10
  !insertmacro AFV_ETA "Environ 20 secondes restantes"
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRC}\*"
  !insertmacro AFV_STEP $S2 1 "Copie des fichiers" 85
  !insertmacro AFV_STEP $S3 0 "Raccourcis bureau et menu Démarrer" 88
  !insertmacro AFV_ETA "Presque terminé…"

  ; anciens raccourcis (nom d'avant 0.6.0)
  Delete "$SMPROGRAMS\Air France Virtuel\${APP}.lnk"
  RMDir "$SMPROGRAMS\Air France Virtuel"
  IfFileExists "$DESKTOP\${APP}.lnk" 0 +3
    Delete "$DESKTOP\${APP}.lnk"
    CreateShortcut "$DESKTOP\${SHORT}.lnk" "$INSTDIR\${EXE}"
  CreateDirectory "$SMPROGRAMS\${MENU}"
  CreateShortcut "$SMPROGRAMS\${MENU}\${SHORT}.lnk" "$INSTDIR\${EXE}"
  IfSilent +2
    CreateShortcut "$DESKTOP\${SHORT}.lnk" "$INSTDIR\${EXE}"
  !insertmacro AFV_STEP $S3 1 "Raccourcis bureau et menu Démarrer" 92
  !insertmacro AFV_STEP $S4 0 "Inscription dans Windows" 94
  WriteUninstaller "$INSTDIR\${UNINST}"

  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${SHORT}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "Les Ailes Françaises"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\${UNINST}"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\${UNINST}" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" "$0"
  !insertmacro AFV_STEP $S4 1 "Inscription dans Windows" 98
  !insertmacro AFV_STEP $S5 1 "Mises à jour automatiques" 100
  !insertmacro AFV_ETA "Installation terminée !"
  Sleep 700
SectionEnd

; Mise à jour silencieuse lancée par le tracker : relance l'appli à la fin.
Function .onInstSuccess
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  IfErrors done
    Exec '"$INSTDIR\${EXE}" --updated'
  done:
FunctionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 800
  Delete "$DESKTOP\${APP}.lnk"
  Delete "$DESKTOP\${SHORT}.lnk"
  Delete "$SMPROGRAMS\Air France Virtuel\${APP}.lnk"
  RMDir "$SMPROGRAMS\Air France Virtuel"
  Delete "$SMPROGRAMS\${MENU}\${SHORT}.lnk"
  RMDir "$SMPROGRAMS\${MENU}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd
