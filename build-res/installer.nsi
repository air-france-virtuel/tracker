; Assistant d'installation du tracker Air France Virtuel
Unicode true
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VERSION4
  !define VERSION4 "0.0.0.0"
!endif
!define APP "Air France Virtuel Tracker"
!define EXE "Air France Virtuel Tracker.exe"
!define UNINST "Désinstaller Air France Virtuel Tracker.exe"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\fr.airfrancevirtuel.tracker"
!define REGKEY "Software\Air France Virtuel\Tracker"

Name "${APP}"
Caption "Installation – Air France Virtuel Tracker ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${REGKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Air France Virtuel · Tracker de vol ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "${RES}\icon.ico"
!define MUI_UNICON "${RES}\icon.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${RES}\sidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${RES}\sidebar.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${RES}\header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "${RES}\header.bmp"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Veux-tu vraiment annuler l'installation du tracker Air France Virtuel ?"

!define MUI_WELCOMEPAGE_TITLE "Bienvenue dans l'installation du tracker Air France Virtuel"
!define MUI_WELCOMEPAGE_TEXT "Cet assistant va installer le tracker de vol Air France Virtuel ${VERSION} (bêta) sur ton ordinateur.$\r$\n$\r$\nLe tracker suit tes vols dans Microsoft Flight Simulator 2020 et 2024 : phases du vol, Max ton copilote, annonces à bord, hangar et rapport de vol.$\r$\n$\r$\nLes prochaines versions s'installeront automatiquement.$\r$\n$\r$\nClique sur Suivant pour continuer."
!insertmacro MUI_PAGE_WELCOME
!define MUI_LICENSEPAGE_TEXT_TOP "Lis les conditions d'utilisation du tracker."
!insertmacro MUI_PAGE_LICENSE "${RES}\licence.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Le tracker est installé"
!define MUI_FINISHPAGE_TEXT "Le tracker Air France Virtuel est prêt.$\r$\n$\r$\nTu le retrouves sur ton bureau et dans le menu Démarrer.$\r$\n$\r$\nBons vols !"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Lancer le tracker maintenant"
!insertmacro MUI_PAGE_FINISH

!define MUI_WELCOMEPAGE_TITLE "Désinstallation du tracker Air France Virtuel"
!define MUI_WELCOMEPAGE_TEXT "Cet assistant va retirer le tracker de ton ordinateur.$\r$\n$\r$\nTes réglages, ta flotte, tes sons et tes rapports de vol sont conservés : tu les retrouveras si tu réinstalles le tracker."
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "French"

VIProductVersion "${VERSION4}"
VIAddVersionKey /LANG=${LANG_FRENCH} "ProductName" "${APP}"
VIAddVersionKey /LANG=${LANG_FRENCH} "CompanyName" "Air France Virtuel"
VIAddVersionKey /LANG=${LANG_FRENCH} "FileDescription" "Installation du tracker Air France Virtuel"
VIAddVersionKey /LANG=${LANG_FRENCH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_FRENCH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_FRENCH} "LegalCopyright" "Air France Virtuel - projet de fans"

Section "Tracker" SecMain
  SectionIn RO
  DetailPrint "Fermeture du tracker s'il est ouvert…"
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 800
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRC}\*"
  WriteUninstaller "$INSTDIR\${UNINST}"

  CreateDirectory "$SMPROGRAMS\Air France Virtuel"
  CreateShortcut "$SMPROGRAMS\Air France Virtuel\${APP}.lnk" "$INSTDIR\${EXE}"
  IfSilent +2
    CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "Air France Virtuel"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\${UNINST}"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\${UNINST}" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" "$0"
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
  Delete "$SMPROGRAMS\Air France Virtuel\${APP}.lnk"
  RMDir "$SMPROGRAMS\Air France Virtuel"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd
