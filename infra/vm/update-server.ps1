<#
.SYNOPSIS
  One command after each merge: bundle HEAD -> VM, update /opt/resist, pip install, restart resist-backend,
  wait for /health. Refuses while a grid is running on the VM (-Force overrides).
.EXAMPLE
  git switch main; git pull; ./infra/vm/update-server.ps1
#>
[CmdletBinding()]
param([switch]$KeyFromMyLogin, [switch]$Force)
& (Join-Path $PSScriptRoot 'deploy.ps1') -Restart -KeyFromMyLogin:$KeyFromMyLogin -Force:$Force
