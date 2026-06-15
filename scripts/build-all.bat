@echo off
chcp 65001 >nul
:: ============================================================
::  MyLog 桌面通知助手 - 客户交付打包脚本 (Windows)
::
::  修复记录(2026-06-13):
::    1) GitHub 不通导致 electron-builder 下不到 electron-v32.3.3
::       -> 走国内镜像 npmmirror.com
::    2) 中文 productName 触发 rcedit ENOENT
::       -> productName 改为 ASCII
::    3) asar 打开,资产走 asarUnpack
::    4) 图标源 PNG 改了之后,必须先跑 generate-icons.js 重新生成 256x256 ico,
::       否则 Builder 报 "image ... must be at least 256x256"
::
::  产物:
::    1) dist-installer-new\MyLogNotifier Setup 1.0.0.exe (NSIS 安装版)
::    2) dist-installer-new\win-unpacked\MyLogNotifier.exe (免安装入口)
:: ============================================================
setlocal enabledelayedexpansion

:: 国内镜像,绕开 GitHub 超时
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo.
echo ============================================
echo  MyLog 桌面通知助手 - 一键打包
echo  (脚本作者:工程效能组 / v2026.06.13)
echo ============================================
echo.

cd /d "%~dp0"
echo [当前目录] %cd%
echo.

:: 1) 装依赖
if not exist "node_modules\electron-builder" (
  echo [1/4] 安装依赖,首次需要 1-3 分钟...
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo [1/4] 依赖已就绪,跳过安装
)

:: 2) 重新生成 ico(从 icon.png 派生三个 256x256 图标)
echo.
echo [2/4] 从 assets\icon.png 重新生成 3 个 .ico ...
call node generate-icons.js
if errorlevel 1 goto :fail

:: 3) NSIS 安装版
echo.
echo [3/4] 打包 NSIS 安装版(3-5 分钟)...
call npx --no-install electron-builder --win --x64
if errorlevel 1 goto :fail

:: 4) 便携版就是 win-unpacked,直接告知路径
echo.
echo [4/4] 便携版入口已就绪: dist-installer-new\win-unpacked\MyLogNotifier.exe

echo.
echo ============================================
echo  [OK] 打包完成!产物如下:
echo ============================================
echo.
if exist "dist-installer-new\MyLogNotifier Setup 1.0.0.exe" (
  echo [安装版]
  dir /b "dist-installer-new\MyLogNotifier Setup 1.0.0.exe"
)
if exist "dist-installer-new\win-unpacked\MyLogNotifier.exe" (
  echo.
  echo [便携版入口]
  echo   dist-installer-new\win-unpacked\MyLogNotifier.exe
)
echo.
echo 按任意键退出...
pause >nul
exit /b 0

:fail
echo.
echo ============================================
echo  [X] 打包失败!请把上方红色日志发给工程效能组
echo ============================================
echo.
echo 按任意键退出...
pause >nul
exit /b 1