@echo off
chcp 65001 > nul
echo 在庫管理システムを起動します...
cd /d "%~dp0"

:: すでに起動済みならブラウザだけ開いて終了
powershell -Command "try { Invoke-WebRequest http://localhost:8000/ -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }" > nul 2>&1
if %errorlevel% equ 0 (
    echo サーバーはすでに起動しています
    start http://localhost:8000
    exit /b
)

pip install -r requirements.txt -q

echo.
echo サーバーを起動中...
start "在庫管理サーバー" python -m uvicorn app:app --host 0.0.0.0 --port 8000

:wait
timeout /t 1 /nobreak > nul
powershell -Command "try { Invoke-WebRequest http://localhost:8000/ -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }" > nul 2>&1
if %errorlevel% neq 0 (
    echo 起動待ち中...
    goto wait
)

echo ブラウザを開いています...
start http://localhost:8000
echo.
echo 「在庫管理サーバー」ウィンドウを閉じるとサーバーが停止します
