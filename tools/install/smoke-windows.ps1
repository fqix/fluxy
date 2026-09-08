# Run only on a disposable Windows runner: this installs the latest public release.
$ErrorActionPreference = 'Stop'
$results = Join-Path (Get-Location) 'test-results/windows-installer'
New-Item -ItemType Directory -Path $results -Force | Out-Null
$child = Join-Path $results 'install-child.ps1'
@'
$ErrorActionPreference = 'Stop'
Write-Output "PowerShell $($PSVersionTable.PSVersion), architecture $env:PROCESSOR_ARCHITECTURE"
try {
    # Exercise the exact README command, including downloads and the real NSIS installer.
    irm https://raw.githubusercontent.com/fqix/fluxy/main/install.ps1 | iex
    Write-Output 'FLUXY_INSTALL_SHELL_SURVIVED'
} catch {
    Write-Output ($_ | Format-List * -Force | Out-String)
    exit 1
}
'@ | Set-Content -LiteralPath $child -Encoding utf8
foreach ($shell in @('powershell.exe', 'pwsh.exe')) {
    $log = Join-Path $results "$shell.log"
    & $shell -NoProfile -NonInteractive -File $child *> $log
    $exitCode = $LASTEXITCODE
    Get-Content -LiteralPath $log
    $installLog = Join-Path $env:TEMP 'fluxy-install.log'
    if (Test-Path -LiteralPath $installLog) { Copy-Item -LiteralPath $installLog -Destination (Join-Path $results "$shell-install.log") }
    if ($exitCode -ne 0) { throw "$shell exited with code $exitCode" }
    if (!(Select-String -LiteralPath $log -SimpleMatch 'FLUXY_INSTALL_SHELL_SURVIVED' -Quiet)) {
        throw "$shell did not reach the end of the installation command"
    }
    $entry = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall |
        Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Fluxy' } | Select-Object -First 1
    if (!$entry -or $entry.UninstallString -notmatch '^"([^"]+)"') { throw 'Fluxy per-user uninstall registration is missing' }
    $executable = Join-Path (Split-Path $Matches[1] -Parent) 'Fluxy.exe'
    if (!(Test-Path -LiteralPath $executable)) { throw 'Installed Fluxy executable is missing' }
    Write-Output "Verified $shell installation: $executable, version $((Get-Item -LiteralPath $executable).VersionInfo.ProductVersion)"
}
