@echo off
rem ============================================================
rem  Auto-start entry (referenced by Startup\start.bat.lnk)
rem  Runs silently with --hidden: no main window, tray only.
rem  For daily development use scripts\start-dev.bat (npm run dev).
rem ============================================================
set ELECTRON_RUN_AS_NODE=
npx electron . --hidden
