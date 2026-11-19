# Azure (Contoso) setup for the hackathon

This guide is for David and Dylan, for tomorrow morning. It connects your laptop to the shared Cosmos
DB graph that stores the inversion results.

## What you get

- After `git pull` and one Azure login, the backend connects to the shared graph by itself. There is
  no key to copy and no `.env` file to edit.
- Inversions anyone has run come back instantly (`"source": "graph"`), and the 3D well tab shows their
  layers.
- If you're not logged in, the app still runs on the snapshot committed in `data/graph/inversions.json`.

## Before you start

| Need | Check |
|---|---|
| A user account in the **Contoso** tenant (`704b7209-73fa-43f5-8e84-21cd65fe5697`) | Ove confirms this, or you sign in once at <https://portal.azure.com> and switch the directory to **Contoso** |
| **Microsoft Authenticator** set up for that account (Contoso requires MFA) | You get a sign-in request on your phone when you log in |
| Access to the subscription `ME-MngEnvMCAP833807-bvorland-1` | Ove confirms that you have a role that can list Cosmos DB keys, for example Contributor on `resist-hackathon-rg` |
| **Azure CLI** 2.60 or newer | `az version` |
| The repo's normal setup (Python `.venv`, `npm install`) | [SETUP.md](../SETUP.md) |

## 1. Install the Azure CLI (skip if `az version` works)

```powershell
# Windows
winget install -e --id Microsoft.AzureCLI
```

```bash
# Mac
brew update && brew install azure-cli
```

Open a new terminal afterwards, so `az` is on your PATH.

## 2. Log in to Contoso

Use the device-code login. It works in every terminal, including VS Code's, and shows the MFA number
in the browser.

```powershell
az login --tenant 704b7209-73fa-43f5-8e84-21cd65fe5697 --use-device-code
```

1. The command prints a code and the address <https://microsoft.com/devicelogin>.
2. Open that address in a browser, enter the code, and choose your **Contoso** account.
3. Approve the request in Authenticator. If it asks for a number, the number is shown in the
   **browser** window.
4. If the CLI asks you to pick a subscription, choose `ME-MngEnvMCAP833807-bvorland-1`.

Then make it the default and check:

```powershell
az account set --subscription 2668e2c1-a6ab-42da-8bcf-edd50a6fc470
az account show --query "{name:name, tenant:tenantId}" -o table
```

The output must show `ME-MngEnvMCAP833807-bvorland-1` and tenant `704b7209-73fa-43f5-8e84-21cd65fe5697`.

## 3. Check that you can reach the database

```powershell
az cosmosdb list -g resist-hackathon-rg --query "[].name" -o tsv
```

This prints the account name (`resist-graph-…`). Next, check that you're allowed to read the key. The
command prints only `ok`, never the key itself:

```powershell
$acct = az cosmosdb list -g resist-hackathon-rg --query "[0].name" -o tsv
az cosmosdb keys list -g resist-hackathon-rg -n $acct --type keys --query "primaryMasterKey" -o tsv > $null; if ($?) { "ok" }
```

```bash
# Mac
acct=$(az cosmosdb list -g resist-hackathon-rg --query '[0].name' -o tsv)
az cosmosdb keys list -g resist-hackathon-rg -n "$acct" --type keys --query primaryMasterKey -o tsv > /dev/null && echo ok
```

## 4. Pull and start

```powershell
git checkout main
git pull
.venv\Scripts\python -m pip install -r backend\requirements.txt
.venv\Scripts\python -m backend.app
```

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Check that <http://localhost:5000/health> shows `"store": "cosmos"` and `"cosmos": "ok"`, then open
<http://localhost:5173>. On Mac, use `.venv/bin/python` instead of `.venv\Scripts\python`.

## 5. Optional: the Azure MCP server in VS Code

This lets Copilot query Azure, for example to list the Cosmos accounts. Add this to
`.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "Azure MCP Server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@azure/mcp@latest", "server", "start"],
      "env": { "AZURE_TOKEN_CREDENTIALS": "AzureCliCredential" }
    }
  }
}
```

The `AZURE_TOKEN_CREDENTIALS` line makes the server use your `az login` from step 2. Without it, the
server can pick up a token from another tenant and fail with `InvalidAuthenticationTokenTenant`.

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `AADSTS50076 ... you must use multi-factor authentication` | The login was started without `--tenant`, so MFA for Contoso was skipped | Run step 2 exactly, with `--tenant` and `--use-device-code` |
| `No subscriptions found for <you>@bouvet.no` | You logged in to your Bouvet tenant, not Contoso | Run step 2 again and choose the Contoso account in the browser |
| You never see the MFA number | The browser login opened somewhere you can't see it | Use `--use-device-code`; the number shows in the browser at <https://microsoft.com/devicelogin> |
| `az account show` shows another tenant | Several logins are cached | `az account set --subscription 2668e2c1-a6ab-42da-8bcf-edd50a6fc470`, or `az logout` and then step 2 |
| `AuthorizationFailed ... listKeys/action` | Your account has no role on `resist-hackathon-rg` | Ask Ove to grant access (see below) |
| `/health` shows `"cosmos": "unavailable"` | Not logged in, wrong tenant, or no permission; the reason is in the response | Fix the reason and restart the backend; the app keeps working from the snapshot meanwhile |
| The token expires during the day | Normal | Run step 2 again |

## For Ove: grant access (only if step 3 fails for someone)

```powershell
az role assignment create --assignee <their Contoso sign-in name> --role "Contributor" `
  --scope /subscriptions/2668e2c1-a6ab-42da-8bcf-edd50a6fc470/resourceGroups/resist-hackathon-rg
```

This gives access to the hackathon resource group only. Everything is deleted after the hackathon:

```powershell
az group delete -n resist-hackathon-rg --yes
```
