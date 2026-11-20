<#
.SYNOPSIS
  Idempotently create the RESIST CPU inversion-grid VM in resist-hackathon-rg.
.DESCRIPTION
  NSG with SSH only from the caller's public IP, Ubuntu 22.04 VM with a
  system-assigned identity (Contributor on resist-hackathon-rg only),
  SSH key ~/.ssh/resist_vm_ed25519, tags, auto-shutdown 22:00 W. Europe.
  Falls back F72s_v2 -> F64s_v2 -> F48s_v2 -> F64as_v6 -> D64as_v5 (each regional, then zones 1-3)
  on capacity/policy failure.
.EXAMPLE
  ./infra/vm/create-vm.ps1
  ./infra/vm/create-vm.ps1 -AddMyIp   # add current IP to the SSH rule of an existing NSG
#>
[CmdletBinding()]
param(
    [string]$ResourceGroup = 'resist-hackathon-rg',
    [string]$Subscription = '2668e2c1-a6ab-42da-8bcf-edd50a6fc470',
    [string]$Location = 'swedencentral',
    [string]$VmName = 'resist-grid-vm',
    [string[]]$Sizes = @('Standard_F72s_v2', 'Standard_F64s_v2', 'Standard_F48s_v2', 'Standard_F64as_v6', 'Standard_D64as_v5'),
    [string]$Image = 'Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest',
    [string[]]$Zones = @('', '1', '2', '3'),  # '' = regional; zones often have capacity when regional fails
    [int]$OsDiskGb = 128,
    [string]$AdminUser = 'azureuser',
    [string]$ShutdownTime = '2200',
    [string]$ShutdownTz = 'W. Europe Standard Time',
    [switch]$AddMyIp
)
$ErrorActionPreference = 'Continue'  # native stderr must not throw (PS 5.1); exit codes are checked
$nsg = "$VmName-nsg"
$keyPath = Join-Path $HOME '.ssh/resist_vm_ed25519'
$tags = @('project=resist', 'event=hackathon', 'owner=ove', 'SecurityControl=Ignore', 'CostControl=Ignore')

function Invoke-Az { $out = & az @args; if ($LASTEXITCODE) { throw "az $($args -join ' ') failed" }; $out }

Invoke-Az account set --subscription $Subscription | Out-Null
$myIp = (Invoke-RestMethod -Uri 'https://api.ipify.org').Trim()
Write-Host "Caller public IP: $myIp"

# SSH key (private key stays in ~/.ssh, never in the repo)
if (-not (Test-Path $keyPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $keyPath) | Out-Null
    $empty = if ($PSVersionTable.PSVersion -ge [version]'7.3') { '' } else { '""' }
    & ssh-keygen -t ed25519 -f $keyPath -N $empty -C 'resist-grid-vm' -q
    if ($LASTEXITCODE) { throw 'ssh-keygen failed' }
}

# NSG: SSH inbound only from caller IP
$existingNsg = az network nsg show -g $ResourceGroup -n $nsg --query id -o tsv 2>$null
if (-not $existingNsg) {
    Invoke-Az network nsg create -g $ResourceGroup -n $nsg -l $Location --tags @tags -o none
}
$rule = az network nsg rule show -g $ResourceGroup --nsg-name $nsg -n AllowSshMyIp -o json 2>$null | ConvertFrom-Json
$sources = @($myIp)
if ($rule -and $AddMyIp) {
    $prev = @($rule.sourceAddressPrefixes) + @($rule.sourceAddressPrefix) | Where-Object { $_ -and $_ -ne '*' }
    $sources = @($prev + $myIp | ForEach-Object { $_ -replace '/32$', '' } | Sort-Object -Unique)
}
if (-not $rule -or $AddMyIp) {
    Invoke-Az network nsg rule create -g $ResourceGroup --nsg-name $nsg -n AllowSshMyIp --priority 1000 `
        --direction Inbound --access Allow --protocol Tcp --destination-port-ranges 22 `
        --source-address-prefixes @sources -o none
    Write-Host "SSH allowed from: $($sources -join ', ')"
}

# VM (size fallback on capacity / policy errors)
$vmId = az vm show -g $ResourceGroup -n $VmName --query id -o tsv 2>$null
if (-not $vmId) {
    $created = $false
    :sizes foreach ($size in $Sizes) {
        foreach ($zone in $Zones) {
            Write-Host "Creating $VmName as $size (zone: $(if ($zone) { $zone } else { 'none' })) ..."
            $zoneArg = if ($zone) { @('--zone', $zone) } else { @() }
            az vm create -g $ResourceGroup -n $VmName -l $Location --image $Image --size $size @zoneArg `
                --os-disk-size-gb $OsDiskGb --storage-sku Premium_LRS --admin-username $AdminUser `
                --ssh-key-values "$keyPath.pub" --nsg $nsg --public-ip-sku Standard `
                --assign-identity '[system]' --tags @tags -o none 2>&1 |
                Select-String -Pattern 'SkuNotAvailable|QuotaExceeded|RequestDisallowedByPolicy|Message:' |
                Select-Object -First 2 | ForEach-Object { Write-Warning $_.Line.Trim() }
            if (az vm show -g $ResourceGroup -n $VmName --query id -o tsv 2>$null) {
                $created = $true; Write-Host "Created with size $size zone '$zone'"; break sizes
            }
            # a failed attempt can leave a zonal public IP behind; drop it so the next zone can try
            az network public-ip delete -g $ResourceGroup -n "${VmName}PublicIP" -o none 2>$null
        }
        Write-Warning "Size $size not available; trying next."
    }
    if (-not $created) { throw 'All VM sizes failed.' }
}
else { Write-Host "VM $VmName already exists." }

# Auto-shutdown 22:00 W. Europe (az takes UTC; convert)
$tz = [TimeZoneInfo]::FindSystemTimeZoneById($ShutdownTz)
$local = [datetime]::ParseExact($ShutdownTime, 'HHmm', $null)
$utc = [TimeZoneInfo]::ConvertTimeToUtc([datetime]::SpecifyKind($local, 'Unspecified'), $tz).ToString('HHmm')
Invoke-Az vm auto-shutdown -g $ResourceGroup -n $VmName --time $utc -o none
Write-Host "Auto-shutdown: $ShutdownTime $ShutdownTz ($utc UTC)"

# Managed identity -> Contributor on this RG only
$principal = Invoke-Az vm show -g $ResourceGroup -n $VmName --query identity.principalId -o tsv
if (-not $principal) {
    Invoke-Az vm identity assign -g $ResourceGroup -n $VmName -o none
    $principal = Invoke-Az vm show -g $ResourceGroup -n $VmName --query identity.principalId -o tsv
}
$scope = Invoke-Az group show -n $ResourceGroup --query id -o tsv
$has = az role assignment list --assignee $principal --scope $scope --role Contributor --query '[0].id' -o tsv 2>$null
$roleOk = [bool]$has
if (-not $has) {
    for ($i = 0; $i -lt 6; $i++) {
        $err = az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal `
            --role Contributor --scope $scope -o none 2>&1
        if ($LASTEXITCODE -eq 0) { $roleOk = $true; break }
        if ("$err" -match 'AuthorizationFailed') { break }   # caller lacks roleAssignments/write; retrying won't help
        Start-Sleep 10  # identity propagation
    }
}
if (-not $roleOk) {
    Write-Warning ("Could not grant the VM identity ($principal) Contributor on $scope (needs Owner or User Access " +
        "Administrator). Ask an owner to run: az role assignment create --assignee-object-id $principal " +
        "--assignee-principal-type ServicePrincipal --role Contributor --scope $scope. Until then run-grid.ps1 " +
        "hands the Cosmos key to the grid process over SSH stdin (-PassKey).")
}

$ip = Invoke-Az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv
$size = Invoke-Az vm show -g $ResourceGroup -n $VmName --query hardwareProfile.vmSize -o tsv
Write-Host "VM: $VmName  size: $size  ip: $ip  identity: $(if ($roleOk) { "Contributor on $scope" } else { 'NO role (see warning)' })"
Write-Host "ssh -i $keyPath $AdminUser@$ip"

