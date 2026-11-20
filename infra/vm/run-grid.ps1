<#
.SYNOPSIS
  Start a grid on the VM in the background (nohup), or show its status.
.EXAMPLE
  ./infra/vm/run-grid.ps1 infra/vm/grids/demo.json
  ./infra/vm/run-grid.ps1 infra/vm/grids/demo.json -Parallel 1
  ./infra/vm/run-grid.ps1 -Status
#>
[CmdletBinding()]
param(
    [string]$Grid = 'infra/vm/grids/demo.json',   # path inside the repo (as deployed)
    [string]$Parallel = 'auto',
    [switch]$Status,
    [switch]$PassKey,    # force handing the Cosmos key over SSH stdin
    [string]$ResourceGroup = 'resist-hackathon-rg',
    [string]$VmName = 'resist-grid-vm',
    [string]$AdminUser = 'azureuser'
)
$ErrorActionPreference = 'Continue'
$key = Join-Path $HOME '.ssh/resist_vm_ed25519'
$ip = (az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv).Trim()
if (-not $ip) { throw "VM $VmName has no public IP (deallocated?)" }
$sshOpts = @('-i', $key, '-o', 'StrictHostKeyChecking=accept-new')
$Grid = $Grid -replace '\\', '/'
if ($Status) {
    & ssh @sshOpts "$AdminUser@$ip" "pgrep -af 'run_grid' | grep -v pgrep; tail -n 25 /opt/resist/logs/grid.log"
    return
}
$cmd = "cd /opt/resist && mkdir -p logs && nohup .venv/bin/python -m backend.inversion.run_grid '$Grid' " +
       "--parallel '$Parallel' > logs/grid.log 2>&1 < /dev/null & sleep 20; tail -n 20 /opt/resist/logs/grid.log"

# The VM identity reads the Cosmos key itself when it has Contributor on the RG. If it does not (granting needs
# Owner/User Access Administrator), hand the key to the grid process over SSH stdin: never printed, never on disk.
$principal = az vm show -g $ResourceGroup -n $VmName --query identity.principalId -o tsv
$scope = az group show -n $ResourceGroup --query id -o tsv
$hasRole = az role assignment list --assignee $principal --scope $scope --query '[0].id' -o tsv 2>$null
if (-not $hasRole -or $PassKey) {
    Write-Host 'VM identity has no role on the RG: passing the Cosmos key over SSH stdin.'
    $cfg = Get-Content (Join-Path (git rev-parse --show-toplevel).Trim() 'backend/cosmos.config.json') -Raw | ConvertFrom-Json
    $cosmosKey = az cosmosdb keys list --subscription $cfg.subscription_id -g $cfg.resource_group -n $cfg.account `
        --type keys --query primaryMasterKey -o tsv
    if (-not $cosmosKey) { throw 'could not read the Cosmos key with your az login' }
    $cmd = 'IFS= read -r COSMOS_GREMLIN_KEY && export COSMOS_GREMLIN_KEY && ' + $cmd
    $cosmosKey | & ssh @sshOpts "$AdminUser@$ip" $cmd
    Remove-Variable cosmosKey
    return
}
& ssh @sshOpts "$AdminUser@$ip" $cmd
