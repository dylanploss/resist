<#
.SYNOPSIS
  Copy the VM's inversion snapshot (data/graph/inversions.json) and grid logs back into this checkout.
.DESCRIPTION
  Results are already in Cosmos (the shared store); this only refreshes the committed snapshot backup.
  Review with `git diff --stat data/graph/inversions.json`, then commit.
#>
[CmdletBinding()]
param(
    [string]$ResourceGroup = 'resist-hackathon-rg',
    [string]$VmName = 'resist-grid-vm',
    [string]$AdminUser = 'azureuser'
)
$ErrorActionPreference = 'Continue'
$repo = (git rev-parse --show-toplevel).Trim()
$key = Join-Path $HOME '.ssh/resist_vm_ed25519'
$ip = (az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv).Trim()
if (-not $ip) { throw "VM $VmName has no public IP (deallocated?)" }
$sshOpts = @('-i', $key, '-o', 'StrictHostKeyChecking=accept-new')
New-Item -ItemType Directory -Force "$repo/logs/grid" | Out-Null
& scp @sshOpts "${AdminUser}@${ip}:/opt/resist/data/graph/inversions.json" "$repo/data/graph/inversions.json"
if ($LASTEXITCODE) { throw 'scp of the snapshot failed' }
& scp @sshOpts -r "${AdminUser}@${ip}:/opt/resist/logs/grid/*" "$repo/logs/grid/" 2>$null
git -C $repo --no-pager diff --stat -- data/graph/inversions.json
