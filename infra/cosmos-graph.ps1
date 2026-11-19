<#
.SYNOPSIS
  Provision (idempotently) the Azure Cosmos DB for Apache Gremlin graph used by the inversion store.

.DESCRIPTION
  Creates or reuses, inside resource group resist-hackathon-rg ONLY:
    - resource group   resist-hackathon-rg (tags project=resist event=hackathon owner=ove)
    - Cosmos account   resist-graph-<4 chars> (Gremlin, serverless, Session, one region, public network)
    - Gremlin database resist and graph inversions (partition key /pk)
  and writes the NON-SECRET connection settings to backend/cosmos.config.json (tracked in git).

  The account key is never written anywhere by this script. The backend fetches it at startup with
  the caller's own Azure login (see backend/inversion/cosmos_config.py and SETUP.md).

  Safe to run again: the account is discovered by tag resist-role=inversion-graph in the resource
  group (or read from backend/cosmos.config.json), and every create step is skipped when the
  resource already exists.
#>
[CmdletBinding()]
param(
    [string]$ResourceGroup = 'resist-hackathon-rg',
    [string]$Location = 'swedencentral',
    [string]$AccountName = '',
    [string]$Database = 'resist',
    [string]$Graph = 'inversions',
    [string]$TenantId = '704b7209-73fa-43f5-8e84-21cd65fe5697',
    [string]$SubscriptionId = '2668e2c1-a6ab-42da-8bcf-edd50a6fc470',
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\backend\cosmos.config.json')
)
$ErrorActionPreference = 'Stop'
$tags = @('project=resist', 'event=hackathon', 'owner=ove')

function Invoke-Az {
    $out = & az @args
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..2] -join ' ') failed ($LASTEXITCODE)" }
    return $out
}

# Guard: right tenant, right subscription
$acct = Invoke-Az account show -o json | ConvertFrom-Json
if ($acct.tenantId -ne $TenantId) {
    throw "Wrong tenant ($($acct.tenantId)). Run: az login --tenant $TenantId --use-device-code"
}
Invoke-Az account set --subscription $SubscriptionId | Out-Null

# Resource group
if ((Invoke-Az group exists -n $ResourceGroup) -ne 'true') {
    Write-Host "Creating resource group $ResourceGroup in $Location"
    Invoke-Az group create -n $ResourceGroup -l $Location --tags @tags -o none
} else { Write-Host "Resource group $ResourceGroup exists" }

# Account: explicit > config file > tag discovery > new random name
if (-not $AccountName -and (Test-Path $ConfigPath)) {
    $AccountName = (Get-Content $ConfigPath -Raw | ConvertFrom-Json).account
}
if (-not $AccountName) {
    $found = Invoke-Az cosmosdb list -g $ResourceGroup --query "[?tags.\`"resist-role\`"=='inversion-graph'].name | [0]" -o tsv
    if ($found) { $AccountName = "$found".Trim() }
}
if (-not $AccountName) {
    $suffix = -join ((97..122) | Get-Random -Count 4 | ForEach-Object { [char]$_ })
    $AccountName = "resist-graph-$suffix"
}
$have = Invoke-Az cosmosdb list -g $ResourceGroup --query "[?name=='$AccountName'].name | [0]" -o tsv
if (-not $have) {
    Write-Host "Creating Cosmos account $AccountName (Gremlin, serverless, $Location); takes 5-10 min"
    Invoke-Az cosmosdb create -n $AccountName -g $ResourceGroup `
        --capabilities EnableGremlin EnableServerless `
        --default-consistency-level Session `
        --locations regionName=$Location failoverPriority=0 isZoneRedundant=False `
        --public-network-access Enabled `
        --tags @tags 'resist-role=inversion-graph' -o none
} else { Write-Host "Cosmos account $AccountName exists" }

# Database and graph
$db = & az cosmosdb gremlin database show -a $AccountName -g $ResourceGroup -n $Database --query name -o tsv 2>$null
if (-not $db) {
    Write-Host "Creating Gremlin database $Database"
    Invoke-Az cosmosdb gremlin database create -a $AccountName -g $ResourceGroup -n $Database -o none
} else { Write-Host "Gremlin database $Database exists" }
$gr = & az cosmosdb gremlin graph show -a $AccountName -g $ResourceGroup -d $Database -n $Graph --query name -o tsv 2>$null
if (-not $gr) {
    Write-Host "Creating graph $Graph (partition key /pk)"
    Invoke-Az cosmosdb gremlin graph create -a $AccountName -g $ResourceGroup -d $Database -n $Graph --partition-key-path /pk -o none
} else { Write-Host "Graph $Graph exists" }

# Non-secret connection settings (tracked)
$region = Invoke-Az cosmosdb show -n $AccountName -g $ResourceGroup --query "locations[0].locationName" -o tsv
$config = [ordered]@{
    tenant_id       = $TenantId
    subscription_id = $SubscriptionId
    resource_group  = $ResourceGroup
    account         = $AccountName
    region          = "$region".Trim()
    capacity        = 'serverless'
    endpoint        = "wss://$AccountName.gremlin.cosmos.azure.com:443/"
    database        = $Database
    graph           = $Graph
    partition_key   = '/pk'
}
($config | ConvertTo-Json) + "`n" | Set-Content -Path $ConfigPath -Encoding utf8 -NoNewline
Write-Host "Wrote $ConfigPath (no secrets)"
Write-Host "Account: $AccountName  RG: $ResourceGroup  Region: $($config.region)  Capacity: serverless"
