param(
  [string]$RepoDir = "",
  [switch]$Watch,
  [int]$IntervalSeconds = 4,
  [string]$Message = "Sync chemistry review site"
)

$ErrorActionPreference = "Stop"

$SourceDir = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $RepoDir) {
  $RepoDir = Join-Path (Split-Path $SourceDir.Path -Parent) "2027chemistry-review-sync"
}
$RepoRoot = Resolve-Path $RepoDir
$TargetDir = Join-Path $RepoRoot.Path "files-mentioned-by-the-user-00"

function Copy-SiteFiles {
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir "build") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir "tools") | Out-Null

  $files = @(
    "index.html",
    "styles.css",
    "app.js",
    "network_data.js",
    ".gitignore",
    ".nojekyll",
    "DEPLOYMENT.md"
  )
  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $SourceDir.Path $file) -Destination (Join-Path $TargetDir $file) -Force
  }
  Copy-Item -LiteralPath (Join-Path $SourceDir.Path ".nojekyll") -Destination (Join-Path $RepoRoot.Path ".nojekyll") -Force

  Copy-Item -LiteralPath (Join-Path $SourceDir.Path "tools\sync_github_pages.ps1") -Destination (Join-Path $TargetDir "tools\sync_github_pages.ps1") -Force
  Copy-Item -LiteralPath (Join-Path $SourceDir.Path "tools\render_hd_pages.mjs") -Destination (Join-Path $TargetDir "tools\render_hd_pages.mjs") -Force
  Copy-Item -LiteralPath (Join-Path $SourceDir.Path "build\page_images") -Destination (Join-Path $TargetDir "build") -Recurse -Force
  if (Test-Path (Join-Path $SourceDir.Path "build\page_images_hd")) {
    Copy-Item -LiteralPath (Join-Path $SourceDir.Path "build\page_images_hd") -Destination (Join-Path $TargetDir "build") -Recurse -Force
  }

  $pdf = Join-Path $TargetDir "chemistry_method.pdf"
  if (Test-Path $pdf) {
    Remove-Item -LiteralPath $pdf -Force
  }
}

function Publish-Site {
  Copy-SiteFiles
  Push-Location $RepoRoot.Path
  try {
    git add files-mentioned-by-the-user-00 .nojekyll
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
      Write-Host "No changes to publish."
      return
    }
    git commit -m $Message
    git push
  }
  finally {
    Pop-Location
  }
}

function Get-SourceSignature {
  $paths = @(
    "index.html",
    "styles.css",
    "app.js",
    "network_data.js",
    ".gitignore",
    ".nojekyll",
    "DEPLOYMENT.md",
    "tools\sync_github_pages.ps1",
    "tools\render_hd_pages.mjs"
  )
  $items = foreach ($path in $paths) {
    Get-Item -LiteralPath (Join-Path $SourceDir.Path $path)
  }
  $items += Get-ChildItem -LiteralPath (Join-Path $SourceDir.Path "build\page_images") -File -Recurse
  if (Test-Path (Join-Path $SourceDir.Path "build\page_images_hd")) {
    $items += Get-ChildItem -LiteralPath (Join-Path $SourceDir.Path "build\page_images_hd") -File -Recurse
  }
  ($items | Sort-Object FullName | ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }) -join "`n"
}

Publish-Site

if ($Watch) {
  Write-Host "Watching local site files. Press Ctrl+C to stop."
  $last = Get-SourceSignature
  while ($true) {
    Start-Sleep -Seconds $IntervalSeconds
    $current = Get-SourceSignature
    if ($current -ne $last) {
      Start-Sleep -Seconds 1
      Publish-Site
      $last = Get-SourceSignature
    }
  }
}
