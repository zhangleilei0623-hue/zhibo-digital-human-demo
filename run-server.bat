@echo off
cd /d "C:\Users\86137\Documents\Codex\2026-06-14\new-chat-2\outputs"
echo.
echo Zhibo Digital Human - Coze Bridge
echo Token is used only in this command window.
echo Press Enter without token to use local fallback mode.
echo.
set /p COZE_API_TOKEN=Paste Coze PAT token and press Enter: 
set /p COZE_BOT_ID=Paste Coze Bot ID and press Enter [default 7622560093951164466]: 
if "%COZE_BOT_ID%"=="" set COZE_BOT_ID=7622560093951164466
set PORT=8787
set COZE_TIMEOUT_MS=60000
echo.
echo Starting bridge on http://localhost:8787 ...
node coze-bridge-server.js
pause
