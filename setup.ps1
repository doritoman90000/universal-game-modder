# Universal Game Modder - setup (Windows PowerShell)
# One-command install for the free open-core edition (v0.1.0).

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host "Universal Game Modder - setup" -ForegroundColor Cyan
Write-Host "-----------------------------------"

# 1. Node check
try {
    $nodeVersion = node --version
    Write-Host "Node.js found: $nodeVersion"
} catch {
    Write-Host "ERROR: Node.js not found. Install Node.js 18+ from https://nodejs.org and re-run." -ForegroundColor Red
    exit 1
}

# 2. Install dependencies
Write-Host "Installing dependencies (npm install)..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: npm install failed." -ForegroundColor Red; exit 1 }

# 3. Build (dist/ ships prebuilt, but rebuild to be safe if src/ is present)
if (Test-Path "tsconfig.json") {
    Write-Host "Building (npm run build)..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: build failed; prebuilt dist/ will be used if present." -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Next: register the server with your MCP client. See README.md -> Install." -ForegroundColor Green
Write-Host "The free edition needs no external paths - ugm.config.json ships with empty placeholders."
