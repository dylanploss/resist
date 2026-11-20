<#
.SYNOPSIS
  Allow your current public IP to reach the inversion server (TCP 8000) on the VM's NSG.
.EXAMPLE
  ./infra/vm/open-port.ps1 -AddMyIp           # add your IP, keep teammates' IPs
  ./infra/vm/open-port.ps1                     # show who is allowed
#>
[CmdletBinding()]
param(
    [switch]$AddMyIp,
    [int]$Port = 8000,
    [string]$ResourceGroup = 'resist-hackathon-rg',
    [string]$Nsg = 'resist-grid-vm-nsg',
    [string]$RuleName = 'AllowBackend8000'
)
$ErrorActionPreference = 'Continue'
$rule = az network nsg rule show -g $ResourceGroup --nsg-name $Nsg -n $RuleName -o json 2>$null | ConvertFrom-Json
$current = @(@($rule.sourceAddressPrefixes) + @($rule.sourceAddressPrefix) |
    Where-Object { $_ -and $_ -ne '*' } | ForEach-Object { $_ -replace '/32$', '' })
if ($AddMyIp) {
    $myIp = (Invoke-RestMethod -Uri 'https://api.ipify.org').Trim()
    $sources = @($current + $myIp | Sort-Object -Unique)
    az network nsg rule create -g $ResourceGroup --nsg-name $Nsg -n $RuleName --priority 1010 --direction Inbound `
        --access Allow --protocol Tcp --destination-port-ranges $Port --source-address-prefixes @sources -o none
    if ($LASTEXITCODE) { throw 'NSG rule update failed' }
    $current = $sources
    Write-Host "added $myIp"
}
Write-Host "TCP $Port allowed from: $(if ($current) { $current -join ', ' } else { '(nobody)' })"
