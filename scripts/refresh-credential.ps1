# 一条命令刷新演示凭证（WeKnora-Agent 本机便捷入口）。
#
# 它不签发 Token，也不做登录代理：只是调用 WeKnora 验证目录里官方的
# issue_user_token.py（正式 auth/login，多工作空间安全处理），然后把新 JWT
# 同步进本仓库 .env 供 CLI 使用。工作台侧再点「读取本机凭证」即可。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\refresh-credential.ps1

param(
  [string]$WeKnoraRepo = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "WeKnora"),
  [string]$BaseUrl = "http://127.0.0.1:18082",
  [string]$Email = "15918868657@163.com",
  [string]$WorkspaceId = "2"
)

$ErrorActionPreference = "Stop"
$AgentRoot = Split-Path $PSScriptRoot -Parent
$Python = Join-Path $AgentRoot ".venv\Scripts\python.exe"
$Tool = Join-Path $WeKnoraRepo "examples\mcp-validation\scripts\issue_user_token.py"
$Accounts = Join-Path $AgentRoot "accounts.json"
$Credential = Join-Path $WeKnoraRepo "examples\mcp-validation\deploy\workbench-user-token.local.json"

foreach ($path in @($Python, $Tool, $Accounts)) {
  if (-not (Test-Path $path)) { throw "缺少文件：$path（先用 .env.example 建好 .env，并把 accounts.json 放好）" }
}

Write-Host "正在通过 WeKnora 正式登录接口签发凭证…"
& $Python $Tool --base-url $BaseUrl --email $Email --workspace-id $WorkspaceId --accounts-file $Accounts
if ($LASTEXITCODE -ne 0) { throw "凭证签发失败（退出码 $LASTEXITCODE）" }

$cred = Get-Content $Credential -Raw | ConvertFrom-Json
$envPath = Join-Path $AgentRoot ".env"
if (Test-Path $envPath) {
  $lines = Get-Content $envPath | ForEach-Object {
    if ($_ -match '^WEKNORA_USER_TOKEN=') { "WEKNORA_USER_TOKEN=$($cred.token)" }
    elseif ($_ -match '^WEKNORA_WORKSPACE_ID=') { "WEKNORA_WORKSPACE_ID=$($cred.profile.tenant_id)" }
    else { $_ }
  }
  # UTF-8 without BOM: python-dotenv would otherwise read a BOM into the first key.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)
  Write-Host ".env 已同步（CLI 可直接使用）。"
}

Write-Host ""
Write-Host "凭证文件：$Credential"
Write-Host "到期时间：$($cred.expires_at)"
Write-Host "下一步：工作台打开「配置 Token」→ 点「读取本机凭证」→「连接工作台」。"