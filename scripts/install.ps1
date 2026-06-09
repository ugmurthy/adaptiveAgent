$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:ADAPTIVE_AGENT_REPO_URL) { $env:ADAPTIVE_AGENT_REPO_URL.TrimEnd('/') } else { 'https://github.com/ugmurthy/adaptiveAgent' }
$InstallDir = if ($env:ADAPTIVE_AGENT_INSTALL_DIR) { $env:ADAPTIVE_AGENT_INSTALL_DIR } else { Join-Path (Join-Path $env:LOCALAPPDATA 'AdaptiveAgent') 'bin' }
$RequestedVersion = $env:ADAPTIVE_AGENT_VERSION

function Fail($Message) {
  Write-Error "adaptive-agent install: $Message"
  exit 1
}

function Get-RepoSlug {
  return ($RepoUrl -replace '^https://github.com/', '').TrimEnd('/')
}

function Resolve-ReleaseTag {
  if ($RequestedVersion) {
    if ($RequestedVersion.StartsWith('v')) { return $RequestedVersion }
    return "v$RequestedVersion"
  }

  $slug = Get-RepoSlug
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$slug/releases/latest" -Headers @{ 'User-Agent' = 'adaptive-agent-installer' }
  if (-not $release.tag_name) { Fail 'unable to resolve latest GitHub Release tag' }
  return [string]$release.tag_name
}

function Resolve-Target {
  if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
    # PowerShell Core on non-Windows can execute this script, but install.ps1 is
    # intentionally the Windows installer. Use install.sh for macOS/Linux.
    Fail 'install.ps1 supports Windows only; use scripts/install.sh on macOS/Linux'
  }

  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  switch ($arch) {
    'X64' { return 'windows-x64' }
    default { Fail "unsupported CPU architecture: $arch" }
  }
}

function Get-ExpectedChecksum($ChecksumsPath, $AssetName) {
  $line = Get-Content $ChecksumsPath | Where-Object { $_ -match [regex]::Escape($AssetName) } | Select-Object -First 1
  if (-not $line) { Fail "checksum for $AssetName not found in checksums.txt" }
  return ($line -split '\s+')[0].ToLowerInvariant()
}

function Assert-Checksum($ArchivePath, $ChecksumsPath, $AssetName) {
  $expected = Get-ExpectedChecksum $ChecksumsPath $AssetName
  $actual = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { Fail "checksum mismatch for $AssetName" }
}

function Write-PathInstructions {
  $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathParts = @($env:Path -split ';') + @($currentPath -split ';')
  if ($pathParts -contains $InstallDir) { return }

  Write-Host ''
  Write-Host "adaptive-agent was installed to $InstallDir, which is not on PATH."
  Write-Host 'Copy and run this command to add it to your user PATH:'
  $escaped = $InstallDir.Replace("'", "''")
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$escaped', 'User')"
  Write-Host 'Then open a new PowerShell session.'
}

function Main {
  $target = Resolve-Target
  $tag = Resolve-ReleaseTag
  $baseUrl = "$RepoUrl/releases/download/$tag"
  $asset = "adaptive-agent-$tag-$target.zip"
  $archiveUrl = "$baseUrl/$asset"
  $checksumUrl = "$baseUrl/checksums.txt"

  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "adaptive-agent-$([System.Guid]::NewGuid())"
  New-Item -ItemType Directory -Path $tempDir | Out-Null
  try {
    $archive = Join-Path $tempDir $asset
    $checksums = Join-Path $tempDir 'checksums.txt'
    $extractDir = Join-Path $tempDir 'extract'

    Write-Host "Installing adaptive-agent for $target"
    Write-Host "Downloading $archiveUrl"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archive
    Invoke-WebRequest -Uri $checksumUrl -OutFile $checksums
    Assert-Checksum $archive $checksums $asset

    New-Item -ItemType Directory -Path $extractDir | Out-Null
    Expand-Archive -Path $archive -DestinationPath $extractDir -Force

    $binary = Get-ChildItem -Path $extractDir -Filter 'adaptive-agent.exe' -Recurse | Select-Object -First 1
    if (-not $binary) { Fail 'archive did not contain adaptive-agent.exe' }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $installPath = Join-Path $InstallDir 'adaptive-agent.exe'
    Copy-Item -Path $binary.FullName -Destination $installPath -Force

    Write-Host "Installed $installPath"
    Write-PathInstructions
    & $installPath --version
  } finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Main
