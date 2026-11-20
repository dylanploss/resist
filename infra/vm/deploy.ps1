<#
.SYNOPSIS
  Ship the current branch HEAD to the grid VM as a git bundle (no GitHub token on the VM) and bootstrap it.
.EXAMPLE
  ./infra/vm/deploy.ps1
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
if (-not $ip) { throw "VM $VmName has no public IP (deallocated? run: az vm start -g $ResourceGroup -n $VmName)" }
$target = "$AdminUser@$ip"
$sshOpts = @('-i', $key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')
if (git -C $repo status --porcelain --untracked-files=no) { Write-Warning 'Uncommitted changes are NOT deployed (bundle = HEAD).' }

$bundle = Join-Path ([IO.Path]::GetTempPath()) 'resist.bundle'
git -C $repo bundle create $bundle HEAD
if ($LASTEXITCODE) { throw 'git bundle failed' }
Write-Host ("bundle {0:N0} MB, HEAD {1}" -f ((Get-Item $bundle).Length / 1MB), (git -C $repo rev-parse --short HEAD))

& scp @sshOpts $bundle "$repo/infra/vm/bootstrap.sh" "${target}:/tmp/"
if ($LASTEXITCODE) { throw 'scp failed' }
& ssh @sshOpts $target "sed -i 's/\r$//' /tmp/bootstrap.sh && bash /tmp/bootstrap.sh /tmp/resist.bundle"
if ($LASTEXITCODE) { throw 'bootstrap failed' }

# DLIS files that are not tracked in git (the bundle already carries tracked ones).
$tracked = @(git -C $repo ls-files data | Where-Object { $_ -like '*.dlis' })
$missing = Get-ChildItem "$repo/data" -Filter *.dlis | Where-Object { "data/$($_.Name)" -notin $tracked }
if ($missing) {
    & scp @sshOpts ($missing | ForEach-Object FullName) "${target}:/opt/resist/data/"
    if ($LASTEXITCODE) { throw 'scp of data failed' }
}
Write-Host "deployed to ${target}:/opt/resist ($($missing.Count) untracked DLIS copied)"
Write-Host "ssh $($sshOpts[0..1] -join ' ') $target"
