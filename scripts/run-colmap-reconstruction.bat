@echo off
setlocal

rem Double-click defaults to the current user's Downloads directory.
set "CAPTURE_DIR=%~1"
if not defined CAPTURE_DIR set "CAPTURE_DIR=%USERPROFILE%\Downloads"

rem Optional flags: -UseGpu and -AllowSmallSparseModel.
set "OPTION_ARGS="
if /I "%~2"=="-UseGpu" set "OPTION_ARGS=%OPTION_ARGS% -UseGpu"
if /I "%~3"=="-UseGpu" set "OPTION_ARGS=%OPTION_ARGS% -UseGpu"
if /I "%~2"=="-AllowSmallSparseModel" set "OPTION_ARGS=%OPTION_ARGS% -AllowSmallSparseModel"
if /I "%~3"=="-AllowSmallSparseModel" set "OPTION_ARGS=%OPTION_ARGS% -AllowSmallSparseModel"

echo Capture directory: %CAPTURE_DIR%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-colmap-reconstruction.ps1" ^
  -CaptureDir "%CAPTURE_DIR%" ^
  -OutputDir "%CAPTURE_DIR%\reconstruction" %OPTION_ARGS%

if errorlevel 1 (
  echo.
  echo Reconstruction failed. See the error above.
  if exist "%CAPTURE_DIR%\reconstruction\reconstruction-report.json" (
    echo.
    echo Reconstruction report:
    type "%CAPTURE_DIR%\reconstruction\reconstruction-report.json"
  )
  pause
  exit /b 1
)

echo.
echo Reconstruction completed.
echo Output: %CAPTURE_DIR%\reconstruction
pause
