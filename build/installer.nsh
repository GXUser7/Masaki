; Удаление Masaki убирает и его регистрацию браузером (её пишет сам Masaki при запуске,
; src/main/defaultBrowser.ts), иначе в «Приложениях по умолчанию» остался бы пункт без программы.
!macro MasakiForgetExt EXT
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "MasakiHTML"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Masaki"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Masaki"
  DeleteRegKey HKCU "Software\Classes\MasakiURL"
  DeleteRegKey HKCU "Software\Classes\MasakiHTML"
  !insertmacro MasakiForgetExt ".htm"
  !insertmacro MasakiForgetExt ".html"
  !insertmacro MasakiForgetExt ".shtml"
  !insertmacro MasakiForgetExt ".xht"
  !insertmacro MasakiForgetExt ".xhtml"
  !insertmacro MasakiForgetExt ".pdf"
  !insertmacro MasakiForgetExt ".svg"
  !insertmacro MasakiForgetExt ".webp"
!macroend
