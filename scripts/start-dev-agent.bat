@echo off
rem ============================================================
rem  Agent / scripted dev launch: starts the desktop client
rem  WITHOUT keeping it in the caller's process tree.
rem
rem  Why: when electron.exe is spawned directly from an agent or
rem  CI shell, the whole tree is torn down with the parent and the
rem  GPU child dies with 0xC0000005 -> "GPU process isn't usable.
rem  Goodbye." Handing the bat to Explorer detaches it into the
rem  normal desktop session, where it behaves like a manual start.
rem
rem  Do NOT add --no-sandbox: it is not needed once the process
rem  runs in the desktop session (verified 2026-10-19).
rem ============================================================
cd /d "%~dp0.."
start "" "node_modules\electron\dist\electron.exe" .
