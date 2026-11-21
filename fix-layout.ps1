# Run from the repo root: powershell -ExecutionPolicy Bypass -File .\fix-layout.ps1
New-Item -ItemType Directory -Force migrations, test | Out-Null
Move-Item -Force 00*.sql migrations\
Move-Item -Force helpers.js, registration.test.js, ui.test.js test\
if (Test-Path _.gitignore) { Move-Item -Force _.gitignore .gitignore }
if ((Test-Path env.txt) -and -not (Test-Path .env)) { Copy-Item env.txt .env }
Write-Host "Layout fixed. Now: npm install; npm run db:up; npm run migrate; npm run seed; npm start"
