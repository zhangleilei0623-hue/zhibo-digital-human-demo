@echo off
cd /d "C:\Users\86137\Documents\Codex\2026-06-14\new-chat-2\outputs"
echo.
echo 智播云枢数字人 Coze 桥接服务
echo Token 不会写入网页；只在当前命令窗口临时使用。
echo 如果直接回车，将使用本地备选模式。
echo.
set /p COZE_API_TOKEN=请输入 Coze 个人访问令牌:
set /p COZE_BOT_ID=请输入 Coze 智能体 Bot ID（直接回车使用默认值）:
if "%COZE_BOT_ID%"=="" set COZE_BOT_ID=7622560093951164466
set PORT=8787
node coze-bridge-server.js
pause
