@echo off
chcp 65001 >nul 2>&1
title Onyx Agent Monitor Control
color 0A
set "MONITOR_DIR=e:\OneDrive\onyx-monitor"
set "PORT=3847"
set "CDP_PORT=9000"
set "IDE_EXE=%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe"

:MENU
cls
echo.
echo  ======================================
echo       Onyx Agent Monitor Control
echo  ======================================
echo.
echo   [1]  Start Server
echo   [2]  Stop Server
echo   [3]  Open Tunnel
echo   [4]  Close Tunnel
echo   [5]  Status
echo   [6]  Launch IDE with CDP
echo   [0]  Exit
echo.
echo   * Server runs in the background (no window).
echo     You can close this menu safely.
echo.
echo     Made by AirZone
echo.
set "choice="
set /p choice="  Choose [0-6]: "

if "%choice%"=="1" goto START
if "%choice%"=="2" goto STOP
if "%choice%"=="3" goto TUNNEL_START
if "%choice%"=="4" goto TUNNEL_STOP
if "%choice%"=="5" goto STATUS
if "%choice%"=="6" goto LAUNCH_IDE
if "%choice%"=="0" goto EXIT
goto MENU

:EXIT
echo.
echo  Bye!
ping -n 2 127.0.0.1 >nul
taskkill /PID %PID% /F >nul 2>&1
exit

:START
echo.
echo  Stopping old instance...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%.*LISTEN" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo  Starting server on port %PORT%...
powershell -Command "Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%MONITOR_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%MONITOR_DIR%\server.log' -RedirectStandardError '%MONITOR_DIR%\server.err.log'"
timeout /t 3 /nobreak >nul
node -e "require('http').get('http://localhost:%PORT%/', r => {console.log('  OK - Status: ' + r.statusCode); process.exit(0)}).on('error', e => {console.log('  FAIL: ' + e.message); process.exit(1)})"
echo.
pause
goto MENU

:STOP
echo.
echo  Stopping server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%.*LISTEN" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
    echo  Stopped PID %%a
)
echo  Done.
echo.
pause
goto MENU

:TUNNEL_START
echo.
echo  Starting Cloudflare tunnel...
set "SERVER_RUNNING="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%.*LISTEN" 2^>nul') do (
    set "SERVER_RUNNING=1"
)
if not defined SERVER_RUNNING (
    echo  Server not running! Start it first [1].
    echo.
    pause
    goto MENU
)
REM Kill any existing tunnel first to prevent duplicates
taskkill /IM cloudflared.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul
REM Run hidden, log to file
del "%MONITOR_DIR%\tunnel.log" >nul 2>&1
powershell -Command "Start-Process -FilePath '%MONITOR_DIR%\cloudflared.exe' -ArgumentList 'tunnel','--url','http://localhost:%PORT%' -WindowStyle Hidden -RedirectStandardOutput '%MONITOR_DIR%\tunnel.log' -RedirectStandardError '%MONITOR_DIR%\tunnel.err.log'"
echo  Waiting for tunnel URL...
set "TUNNEL_URL="
for /L %%i in (1,1,15) do (
    if not defined TUNNEL_URL (
        timeout /t 1 /nobreak >nul
        for /f "tokens=*" %%u in ('findstr /C:"trycloudflare.com" "%MONITOR_DIR%\tunnel.err.log" 2^>nul') do (
            for /f "tokens=1 delims= " %%x in ('powershell -Command "if ('%%u' -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $matches[0] }"') do (
                set "TUNNEL_URL=%%x"
            )
        )
    )
)
echo.
if defined TUNNEL_URL (
    echo  ========================================
    echo   Tunnel URL:
    echo   %TUNNEL_URL%
    echo  ========================================
) else (
    echo  Could not detect URL. Check tunnel.err.log
)
echo.
pause
goto MENU

:TUNNEL_STOP
echo.
echo  Stopping tunnel...
taskkill /IM cloudflared.exe /F >nul 2>&1
echo  Tunnel stopped.
echo.
pause
goto MENU

:LAUNCH_IDE
echo.
echo  Launching Antigravity IDE with CDP on port %CDP_PORT%...
echo.
echo  NOTE: This will close and reopen the IDE.
echo        Save your work first!
echo.
set /p confirm="  Continue? (Y/N): "
if /I not "%confirm%"=="Y" goto MENU
echo  Closing IDE...
taskkill /IM "Antigravity IDE.exe" /F >nul 2>&1
timeout /t 3 /nobreak >nul
echo  Starting IDE with --remote-debugging-port=%CDP_PORT%...
start "" "%IDE_EXE%" --remote-debugging-port=%CDP_PORT%
timeout /t 5 /nobreak >nul
echo  Reconnecting CDP from monitor server...
node -e "require('http').get('http://localhost:%PORT%/api/reset', r => {let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log('  ' + d);process.exit(0)})}).on('error', e => {console.log('  Server not running: ' + e.message);process.exit(0)})" 2>nul
echo.
pause
goto MENU

:STATUS
echo.
echo  === Server ===
node -e "require('http').get('http://localhost:%PORT%/', r => {console.log('  Server: RUNNING (port %PORT%)');process.exit(0)}).on('error', () => {console.log('  Server: NOT RUNNING');process.exit(0)})" 2>nul
echo.
echo  === Bridge ===
node -e "require('http').get('http://127.0.0.1:3848/health', r => {let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log('  Bridge: ' + d);process.exit(0)})}).on('error', () => {console.log('  Bridge: NOT RUNNING');process.exit(0)})" 2>nul
echo.
echo  === Tunnel ===
tasklist /FI "IMAGENAME eq cloudflared.exe" /NH 2>nul | findstr /C:"cloudflared" >nul && echo   Tunnel: RUNNING || echo   Tunnel: NOT RUNNING
echo.
echo  === CDP ===
node -e "require('http').get('http://localhost:9000/json', r => {console.log('  CDP: AVAILABLE');process.exit(0)}).on('error', () => {console.log('  CDP: NOT AVAILABLE');process.exit(0)})" 2>nul
echo.
pause
goto MENU
