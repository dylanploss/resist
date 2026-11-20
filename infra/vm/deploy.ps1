<#
.SYNOPSIS
  Ship the current branch HEAD to the VM as a git bundle (no GitHub token on the VM), bootstrap it, and
  optionally restart the resist-backend service and wait for /health.
.DESCRIPTION
  The bundle is incremental when the VM already has a checkout. Refuses to touch /opt/resist while a grid
  (run_grid) is running, since replacing the code would mix versions inside that grid (-Force overrides).
  -KeyFromMyLogin: interim for when the VM identity has no role on the RG: reads the Cosmos key with *your*
  az login and pipes it over SSH into /etc/resist/backend.env (root-only, 600); never printed or committed.
.EXAMPLE
  ./infra/vm/deploy.ps1                   # code + venv + service unit (starts it if not running)
  ./infra/vm/deploy.ps1 -Restart          # = update-server.ps1
#>
[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$KeyFromMyLogin,
    [switch]$Force,
    [string]$ResourceGroup = 'resist-hackathon-rg',
    [string]$VmName = 'resist-grid-vm',
    [string]$AdminUser = 'azureuser',
    [int]$Port = 8000
)
$ErrorActionPreference = 'Continue'
$repo = (git rev-parse --show-toplevel).Trim()
$key = Join-Path $HOME '.ssh/resist_vm_ed25519'
$ip = (az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv).Trim()
if (-not $ip) { throw "VM $VmName has no public IP (deallocated? run: az vm start -g $ResourceGroup -n $VmName)" }
$target = "$AdminUser@$ip"
$sshOpts = @('-i', $key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')
function Invoke-Vm([string]$cmd) { & ssh @sshOpts $target $cmd }
if (git -C $repo status --porcelain --untracked-files=no) { Write-Warning 'Uncommitted changes are NOT deployed (bundle = HEAD).' }

$grid = Invoke-Vm "pgrep -f 'backend.inversion.run_grid' >/dev/null && echo running || true"
if ($grid -match 'running' -and -not $Force) {
    throw 'A grid (run_grid) is running on the VM; updating /opt/resist now would mix code versions. Wait (run-grid.ps1 -Status) or use -Force.'
}

# Incremental bundle when the VM's commit is known locally; nothing to ship when it is already at HEAD.
$head = (git -C $repo rev-parse HEAD).Trim()
$vmHead = "$(Invoke-Vm 'git -C /opt/resist rev-parse HEAD 2>/dev/null || true')".Trim()
$source = '/opt/resist'
if ($vmHead -ne $head) {
    $range = 'HEAD'
    if ($vmHead -match '^[0-9a-f]{40}$') {
        git -C $repo cat-file -e "$vmHead^{commit}" 2>$null
        if ($LASTEXITCODE -eq 0) { $range = "$vmHead..HEAD" }
    }
    $bundle = Join-Path ([IO.Path]::GetTempPath()) 'resist.bundle'
    git -C $repo bundle create $bundle $range 2>&1 | Out-Null
    if ($LASTEXITCODE) { throw "git bundle create $range failed" }
    Write-Host ("bundle {0} = {1:N1} MB" -f $range, ((Get-Item $bundle).Length / 1MB))
    & scp @sshOpts $bundle "${target}:/tmp/resist.bundle"
    if ($LASTEXITCODE) { throw 'scp of the bundle failed' }
    $source = '/tmp/resist.bundle'
}
& scp @sshOpts "$repo/infra/vm/bootstrap.sh" "${target}:/tmp/bootstrap.sh"
Invoke-Vm "sed -i 's/\r$//' /tmp/bootstrap.sh && bash /tmp/bootstrap.sh $source" |
    Where-Object { $_ -notmatch '^(Get|Hit|Ign|Reading|Building|Selecting|Preparing|Unpacking|Setting up|Processing)' }
if ($LASTEXITCODE) { throw 'bootstrap failed' }

# DLIS files that are not tracked in git (the bundle already carries tracked ones).
$tracked = @(git -C $repo ls-files data | Where-Object { $_ -like '*.dlis' })
$missing = @(Get-ChildItem "$repo/data" -Filter *.dlis | Where-Object { "data/$($_.Name)" -notin $tracked })
if ($missing) {
    & scp @sshOpts ($missing | ForEach-Object FullName) "${target}:/opt/resist/data/"
    if ($LASTEXITCODE) { throw 'scp of data failed' }
}

if ($KeyFromMyLogin) {
    $cfg = Get-Content "$repo/backend/cosmos.config.json" -Raw | ConvertFrom-Json
    $cosmosKey = az cosmosdb keys list --subscription $cfg.subscription_id -g $cfg.resource_group -n $cfg.account `
        --type keys --query primaryMasterKey -o tsv
    if (-not $cosmosKey) { throw 'could not read the Cosmos key with your az login' }
    "COSMOS_GREMLIN_KEY=$cosmosKey" | & ssh @sshOpts $target `
        "sudo sh -c 'umask 077; mkdir -p /etc/resist; cat > /etc/resist/backend.env'"
    Remove-Variable cosmosKey
    Write-Host 'Cosmos key written to /etc/resist/backend.env on the VM (root-only).'
    $Restart = $true
}

if ($Restart) {
    Invoke-Vm 'sudo systemctl restart resist-backend'
    $url = "http://${ip}:$Port/health"
    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep 5
        try { $h = Invoke-RestMethod $url -TimeoutSec 5 } catch { $h = $null }
    } until ($h -or (Get-Date) -gt $deadline)
    if (-not $h) {
        Invoke-Vm 'sudo journalctl -u resist-backend -n 30 --no-pager'
        throw "no /health from $url (NSG? run open-port.ps1 -AddMyIp)"
    }
    Write-Host "health: $($h | ConvertTo-Json -Compress -Depth 4)"
}
Write-Host "deployed $($head.Substring(0,7)) to ${target}:/opt/resist; server http://${ip}:$Port"
