@echo off
chcp 65001 >nul
cd /d %~dp0
title 亮宅·易施工 本地克隆系统 (端口 8000)
echo ==============================================
echo   亮宅 · 易施工 本地克隆系统
echo   门户:      http://localhost:8000/
echo   前台:      http://localhost:8000/liangzhai/
echo   后台:      http://localhost:8000/enterprise/
echo ==============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未检测到 Node.js，请先安装: https://nodejs.org/
  pause
  exit /b 1
)
node server.js
pause
