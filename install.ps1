<#
.SYNOPSIS
Downloads, verifies and installs a published Fluxy release on Windows.
.EXAMPLE
.\install.ps1 -Version 0.1.0
.EXAMPLE
.\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [ValidateSet('auto', 'x64', 'arm64')][string]$Arch = 'auto',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on macOS and Linux.' }
if ($Arch -eq 'auto') {
    $nativeArch = $env:PROCESSOR_ARCHITEW6432
    if (!$nativeArch) { $nativeArch = $env:PROCESSOR_ARCHITECTURE }
    switch ($nativeArch) {
        'AMD64' { $Arch = 'x64' }
        'ARM64' { $Arch = 'arm64' }
        default { throw 'Only x64 and arm64 are supported.' }
    }
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Version = $Version -replace '^v', ''
if ($Version -eq 'latest') {
    $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri 'https://github.com/fqix/fluxy/releases/latest' -TimeoutSec 60
    # Windows PowerShell uses HttpWebResponse; PowerShell 7 uses HttpResponseMessage.
    $latestUri = $response.BaseResponse.ResponseUri
    if (!$latestUri) { $latestUri = $response.BaseResponse.RequestMessage.RequestUri }
    if (!$latestUri -or $latestUri.AbsoluteUri -notmatch '^https://github\.com/fqix/fluxy/releases/tag/v(.+)$') {
        throw 'Could not resolve the latest release.'
    }
    $Version = $Matches[1]
}
if ($Version -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') { throw 'Invalid release version.' }
$tag = "v$Version"
$artifact = "Fluxy-$Version-win-$Arch.exe"
$url = "https://github.com/fqix/fluxy/releases/download/$tag/$artifact"
Write-Output "Fluxy: Windows / $Arch`n$url`n$url.sha256"
if ($DryRun) { return }
$work = Join-Path ([IO.Path]::GetTempPath()) ('fluxy-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $checksum = Join-Path $work 'checksum'
    $installer = Join-Path $work $artifact
    Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile $checksum -TimeoutSec 60
    $expected = ((Get-Content -LiteralPath $checksum -TotalCount 1) -split '\s+')[0]
    if ($expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid SHA-256 checksum file.' }
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $installer -TimeoutSec 900
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash -ne $expected) {
        throw 'Checksum mismatch; nothing was installed.'
    }
    $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -eq 3010) { Write-Output 'Fluxy installed. Windows reports that a restart is required.' }
    elseif ($process.ExitCode -ne 0) { throw "Fluxy installer failed (exit code $($process.ExitCode))." }
    else { Write-Output 'Fluxy installed. Open it from the Start menu.' }
} catch {
    throw "Fluxy installation failed. Verify that the release contains a Windows $Arch installer and checksum. $($_.Exception.Message)"
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
