@echo off
setlocal

rem Double-click defaults to the current user's Downloads directory.
set "CAPTURE_DIR=%~1"
if not defined CAPTURE_DIR set "CAPTURE_DIR=%USERPROFILE%\Downloads"

set "GPU_ARGS="
if /I "%~2"=="-UseGpu" set "GPU_ARGS=-UseGpu"

echo Capture directory: %CAPTURE_DIR%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-colmap-reconstruction.ps1" ^
  -CaptureDir "%CAPTURE_DIR%" ^
  -OutputDir "%CAPTURE_DIR%\reconstruction" %GPU_ARGS%

if errorlevel 1 (
  echo.
  echo Reconstruction failed. See the error above.
  pause
  exit /b 1
)

echo.
echo Reconstruction completed.
echo Output: %CAPTURE_DIR%\reconstruction
pause
