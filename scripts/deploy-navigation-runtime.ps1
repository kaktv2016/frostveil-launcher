# Default is a read-only preflight. -Apply is for the explicitly approved deployment only.
[CmdletBinding()]
param([switch]$Apply,[string]$ApprovalPlanHash)
$ErrorActionPreference='Stop'
$workspaceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$launcherRoot=Join-Path $workspaceRoot 'skyrim-rp-launcher'
$taskRoot=Join-Path $workspaceRoot 'skymp'
$serverRoot=Join-Path $taskRoot 'build\dist\server'
$deliveryRoot=Join-Path $launcherRoot '.local\navigation-runtime-fix\delivery'
$planPath=Join-Path $deliveryRoot 'deployment-plan.json'
$expectedPlanHash='4a3bd3bce682643cf56302959e0b647f4fd7841bfe94e3640c3d7b41a62cfda5'
function Assert-Identity([string]$Path,$Expected){
 if(!(Test-Path -LiteralPath $Path -PathType Leaf)){throw "Missing deployment file: $Path"}
 if((Get-Item -LiteralPath $Path).Length -ne $Expected.size -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected.sha256){throw "Deployment identity changed: $Path"}
}
if((Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedPlanHash){throw 'Sealed deployment plan changed; review before proceeding'}
$plan=Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
if($plan.status -ne 'SEALED_LOCAL_CANDIDATE_AWAITING_SINGLE_DEPLOYMENT_APPROVAL'){throw 'Unexpected deployment candidate status'}
$settingsPath=Join-Path $serverRoot 'server-settings.json'
$config=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
if($config.listenHost -ne '127.0.0.1' -or !$config.offlineMode -or ($config.uiListenHost -and $config.uiListenHost -ne '127.0.0.1')){throw 'Local operator authority requires loopback offline configuration'}
if(@($config.loadOrder).Count -ne 6){throw 'Server load order changed'}
$espTarget=[IO.Path]::GetFullPath([string]$config.loadOrder[5])
if($espTarget -ne [IO.Path]::GetFullPath((Join-Path $serverRoot 'data\FrostveilCourierNavigation.esp'))){throw 'Unexpected server navigation ESP path'}
$bundleSource=[string]$plan.server.bundle.path
$espSource=Join-Path $deliveryRoot 'modpack\reviewed-content\FrostveilCourierNavigation.esp'
$wrapperPath=Join-Path $serverRoot 'dist_back\skymp5-server.js'
Assert-Identity $bundleSource $plan.server.bundle
Assert-Identity $espSource $plan.navigation[0]
Assert-Identity $config.gamemodePath $plan.server.before.bundle
Assert-Identity $espTarget $plan.server.before.esp
Assert-Identity $wrapperPath $plan.server.before.wrapper
Assert-Identity $plan.installer.path $plan.installer
Assert-Identity $plan.correspondingSource.path $plan.correspondingSource
Assert-Identity $plan.modpack.correspondingSource.path $plan.modpack.correspondingSource
Assert-Identity (Join-Path $deliveryRoot 'source-repair-plan.json') $plan.recipe
if(Get-Process -Name SkyrimSE -ErrorAction SilentlyContinue){throw 'Close Skyrim before deploying the shared server ESP'}
$endpoint=@(Get-NetUDPEndpoint -LocalPort 7777 -ErrorAction SilentlyContinue)
if($endpoint.Count -gt 1){throw 'Ambiguous server listener'}
$serverProcess=$null
if($endpoint.Count -eq 1){
 $serverProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($endpoint[0].OwningProcess)"
 if($serverProcess.Name -ne 'node.exe' -or $serverProcess.CommandLine -notmatch 'dist_back[/\\]skymp5-server\.js'){throw 'Unrecognized server process; refusing to stop it'}
}
if(!$Apply){
 [pscustomobject]@{status='READ_ONLY_PREFLIGHT_PASS';approvalRequired=$true;planSHA256=$expectedPlanHash;serverRunning=[bool]$serverProcess;bundleSHA256=$plan.server.bundle.sha256;espSHA256=$plan.navigation[0].sha256;worldBackup=$false;gameWrites=0;serverWrites=0} | ConvertTo-Json
 return
}
if($ApprovalPlanHash -ne $expectedPlanHash){throw 'Apply requires the exact owner-approved plan hash'}
if(!(Test-Path -LiteralPath (Join-Path $deliveryRoot 'publication-verified.json'))){throw 'Publish and anonymously verify Launcher/modpack/R2 first; publication-verified.json is required'}
$published=Get-Content -LiteralPath (Join-Path $deliveryRoot 'publication-verified.json') -Raw | ConvertFrom-Json
if($published.planSHA256 -ne $expectedPlanHash -or $published.anonymousVerification -ne 'PASS' -or $published.launcherVersion -ne '0.1.18' -or $published.modpackVersion -ne '1.0.6'){throw 'Publication evidence does not match the approved artifacts'}
$nodeExe='C:\Program Files\nodejs\node.exe'
if(!(Test-Path -LiteralPath $nodeExe -PathType Leaf)){throw 'Expected Node runtime not found'}
$deployRoot=Join-Path $taskRoot ('build\rp-audit\navigation-runtime\deploy-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
New-Item -ItemType Directory -Path $deployRoot | Out-Null
Copy-Item -LiteralPath $settingsPath -Destination (Join-Path $deployRoot 'server-settings-before.json')
Copy-Item -LiteralPath $config.gamemodePath -Destination (Join-Path $deployRoot 'gamemode-before.cjs')
Copy-Item -LiteralPath $espTarget -Destination (Join-Path $deployRoot 'FrostveilCourierNavigation-before.esp')
Assert-Identity (Join-Path $deployRoot 'gamemode-before.cjs') $plan.server.before.bundle
Assert-Identity (Join-Path $deployRoot 'FrostveilCourierNavigation-before.esp') $plan.server.before.esp
if($serverProcess){Stop-Process -Id $serverProcess.ProcessId;Wait-Process -Id $serverProcess.ProcessId -ErrorAction SilentlyContinue}
if(Get-NetUDPEndpoint -LocalPort 7777 -ErrorAction SilentlyContinue){throw 'Server port still busy'}
$bundleTarget=Join-Path $taskRoot ('rp-gamemode\deployed\'+$plan.server.bundle.sha256+'.cjs')
try{
 if(Test-Path -LiteralPath $bundleTarget){Assert-Identity $bundleTarget $plan.server.bundle}else{Copy-Item -LiteralPath $bundleSource -Destination $bundleTarget}
 Copy-Item -LiteralPath $espSource -Destination $espTarget
 $config.gamemodePath=$bundleTarget
 $settingsTemporary=Join-Path $deployRoot 'server-settings-after.json'
 $config | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $settingsTemporary -Encoding utf8
 Copy-Item -LiteralPath $settingsTemporary -Destination $settingsPath
 Assert-Identity $bundleTarget $plan.server.bundle
 Assert-Identity $espTarget $plan.navigation[0]
 Assert-Identity $wrapperPath $plan.server.before.wrapper
}catch{
 Copy-Item -LiteralPath (Join-Path $deployRoot 'server-settings-before.json') -Destination $settingsPath
 Copy-Item -LiteralPath (Join-Path $deployRoot 'FrostveilCourierNavigation-before.esp') -Destination $espTarget
 throw
}
$logPath=Join-Path $deployRoot 'server-console.log'
$startScript=Join-Path $deployRoot 'start-visible-server.ps1'
$scriptText=@"
`$Host.UI.RawUI.WindowTitle='Frostveil Courier Navigation + Admin'
Set-Location -LiteralPath '$serverRoot'
`$env:FROSTVEIL_BEACON_PREVIEW='1'
`$env:FROSTVEIL_ADMIN_LOCAL='1'
Write-Host 'Frostveil - Ctrl+C to stop. No world backup/reset/migration.'
Write-Host 'Admin commands require an explicit current owner-session grant; offline profile IDs are not proof of authority.'
& '$nodeExe' 'dist_back/skymp5-server.js' 2>&1 | Tee-Object -FilePath '$logPath'
Write-Host 'Server stopped.'
"@
$scriptText | Set-Content -LiteralPath $startScript -Encoding utf8
$visible=Start-Process powershell.exe -ArgumentList @('-NoExit','-ExecutionPolicy','Bypass','-File',('"'+$startScript+'"')) -WindowStyle Normal -PassThru
$deadline=[DateTimeOffset]::UtcNow.AddSeconds(45)
$started=$null
while([DateTimeOffset]::UtcNow -lt $deadline){
 $candidate=Get-NetUDPEndpoint -LocalPort 7777 -ErrorAction SilentlyContinue
 if($candidate){$started=Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.OwningProcess)";if($started.CommandLine -match 'dist_back[/\\]skymp5-server\.js'){break};$started=$null}
 if($visible.HasExited){break};Start-Sleep -Milliseconds 500
}
if(!$started){throw "Server startup not verified; inspect $logPath and preserve current world/economy. Code/config backups: $deployRoot"}
$receipt=[pscustomobject]@{status='DEPLOYED_LOCALHOST';planSHA256=$expectedPlanHash;at=[DateTimeOffset]::UtcNow.ToString('o');serverPid=$started.ProcessId;powershellPid=$visible.Id;bundleSHA256=$plan.server.bundle.sha256;espSHA256=$plan.navigation[0].sha256;backupDirectory=$deployRoot;startScript=$startScript;log=$logPath;worldBackup=$false;worldMigration=$false;installedGameWrites=0;nativeGameplay='PENDING'}
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $deliveryRoot 'active-deployment.json') -Encoding utf8
$receipt | ConvertTo-Json -Depth 8
