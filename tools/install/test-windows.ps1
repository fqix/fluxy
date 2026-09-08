# Isolated fixtures: no network access, executable launch, or system installation.
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$installerScript = Join-Path $root 'install.ps1'
$global:FluxyTestCalls = 0
$global:FluxyTestCorrupt = $false
$global:FluxyTestPayload = [Text.Encoding]::UTF8.GetBytes('harmless installer fixture')
$global:FluxyTestHash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($global:FluxyTestPayload))).Replace('-', '')
function Invoke-WebRequest {
    param($Uri, $OutFile, $TimeoutSec, $Method, [switch]$UseBasicParsing)
    if ($Method -eq 'Head') { return [PSCustomObject]@{ BaseResponse = [PSCustomObject]@{ ResponseUri = [Uri]'https://github.com/fqix/fluxy/releases/tag/v0.1.0' } } }
    if ($Uri.EndsWith('.sha256')) { [IO.File]::WriteAllText($OutFile, $global:FluxyTestHash + '  fixture.exe') }
    elseif ($global:FluxyTestCorrupt) { [IO.File]::WriteAllText($OutFile, 'corrupt') }
    else { [IO.File]::WriteAllBytes($OutFile, $global:FluxyTestPayload) }
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
    if ($ArgumentList -ne '/S') { throw 'Expected silent NSIS installation' }
    $global:FluxyTestCalls++
    return [PSCustomObject]@{ExitCode = 0}
}
$output = & $installerScript -Arch arm64 -DryRun
if (($output -join "`n") -notmatch '/releases/download/v0.1.0/Fluxy-0.1.0-win-arm64.exe') { throw 'Incorrect ARM64 download URL' }
if ($global:FluxyTestCalls -ne 0) { throw 'Dry-run launched an installer' }
foreach ($version in @('0.1.0', 'v0.1.0')) {
    $output = & $installerScript -Version $version -Arch x64 -DryRun
    if (($output -join "`n") -notmatch '/releases/download/v0.1.0/Fluxy-0.1.0-win-x64.exe') { throw 'Incorrect versioned download URL' }
}
& $installerScript -Version v0.1.0 -Arch x64
if ($global:FluxyTestCalls -ne 1) { throw 'Valid fixture was not installed' }
# Exercise the documented irm ... | iex execution shape with local script text.
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:PROCESSOR_ARCHITEW6432 = ''
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'Continue'
[IO.File]::ReadAllText($installerScript) | Invoke-Expression
$preferencesPreserved = $ErrorActionPreference -eq 'Continue' -and $ProgressPreference -eq 'Continue'
$ErrorActionPreference = 'Stop'
if (!$preferencesPreserved) { throw 'Installer changed the interactive shell preferences' }
if ($global:FluxyTestCalls -ne 2) { throw 'iex did not execute the verified installer' }
$global:FluxyTestCorrupt = $true
$rejected = $false
try { & $installerScript -Arch x64 } catch { $rejected = $_.Exception.Message -match 'Checksum mismatch' }
if (!$rejected -or $global:FluxyTestCalls -ne 2) { throw 'Corrupt fixture was executed' }
$rejected = $false
try { & $installerScript -Version '1.0.0/../../evil' } catch { $rejected = $true }
if (!$rejected) { throw 'Invalid release version was accepted' }
Write-Output 'Windows installer fixtures passed.'

$logPath = Join-Path ([IO.Path]::GetTempPath()) ('fluxy-log-test-' + [Guid]::NewGuid().ToString('N') + '.log')
try {
    $rejected = $false
    try { & $installerScript -Version 0.1.0 -Arch x64 -LogPath $logPath } catch {
        $rejected = $_.Exception.Message -match 'verifying installer' -and $_.Exception.Message.Contains($logPath)
    }
    if (!$rejected) { throw 'Installer failure did not identify its stage and log' }
    $log = [IO.File]::ReadAllText($logPath)
    if ($log -notmatch 'downloading installer' -or $log -notmatch 'Checksum mismatch') {
        throw 'Installer failure log is incomplete'
    }
} finally { Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue }
