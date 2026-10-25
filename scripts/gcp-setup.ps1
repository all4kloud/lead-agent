<#
  Configuración de Google Cloud para lead-agent. Reutiliza el proyecto, Artifact Registry,
  cuentas de servicio y Workload Identity que ya creó scripts/gcp-setup.ps1 de estimates-saas.
  Se puede volver a correr.

  Uso (PowerShell, desde la carpeta del repo):
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    .\scripts\gcp-setup.ps1 -ProjectId all4kloud-estimates

  Los secretos se leen del PORTAPAPELES: copias el valor (Ctrl+C) y presionas Enter.
  Así no hay que pegar nada en la terminal ni escribir llaves en archivos.
#>
param(
  [Parameter(Mandatory = $true)] [string] $ProjectId,
  [string] $GitHubRepo = 'all4kloud/lead-agent',
  [string] $EstimatesRepo = 'all4kloud/estimates-saas'
)
$ErrorActionPreference = 'Stop'
function G { & gcloud @args; if ($LASTEXITCODE -ne 0) { throw "Falló: gcloud $($args -join ' ')" } }
function Exists {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & gcloud @args *> $null } finally { $ErrorActionPreference = $prev }
  return ($LASTEXITCODE -eq 0)
}

$RuntimeSa = "estimates-runtime@$ProjectId.iam.gserviceaccount.com"
$DeploySa  = "estimates-deploy@$ProjectId.iam.gserviceaccount.com"
G config set project $ProjectId | Out-Null
$ProjectNumber = (& gcloud projects describe $ProjectId --format='value(projectNumber)').Trim()

Write-Host '== Permitir que este repo use el mismo acceso de GitHub (Workload Identity)' -ForegroundColor Cyan
G iam workload-identity-pools providers update-oidc github-provider --location=global --workload-identity-pool=github-pool `
  --attribute-condition="assertion.repository in ['$EstimatesRepo','$GitHubRepo']" | Out-Null
G iam service-accounts add-iam-policy-binding $DeploySa --role=roles/iam.workloadIdentityUser `
  --member="principalSet://iam.googleapis.com/projects/$ProjectNumber/locations/global/workloadIdentityPools/github-pool/attribute.repository/$GitHubRepo" `
  --quiet | Out-Null

Write-Host '== Secretos (se leen del portapapeles)' -ForegroundColor Cyan
$Secrets = [ordered]@{
  'lead-agent-anthropic-key'             = 'API key de Claude (console.anthropic.com -> API Keys, empieza con sk-ant-)'
  'lead-agent-supabase-service-role-key' = 'service_role key del proyecto de Supabase lead-agent'
  'lead-agent-zoho-client-id'            = 'Zoho Self Client: Client ID'
  'lead-agent-zoho-client-secret'        = 'Zoho Self Client: Client Secret'
  'lead-agent-zoho-refresh-token'        = 'Zoho: refresh token (ver README)'
  'lead-agent-twilio-auth-token'         = 'Twilio Auth Token (déjalo vacío hasta tener el número)'
}
foreach ($name in $Secrets.Keys) {
  if (Exists secrets describe $name) {
    Write-Host "   $name ya existe (para cambiarlo, borra su valor actual con una versión nueva)."
  } else {
    Write-Host ''
    Write-Host "   $($Secrets[$name])" -ForegroundColor Yellow
    $r = Read-Host '   Copia el valor (Ctrl+C) y presiona Enter. Escribe "omitir" para dejarlo vacío'
    $val = if ($r -eq 'omitir') { 'NOT_SET' } else { (Get-Clipboard -Raw) }
    if ([string]::IsNullOrWhiteSpace($val)) { $val = 'NOT_SET' }
    $val = $val.Trim()
    $tmp = [IO.Path]::GetTempFileName()
    try {
      [IO.File]::WriteAllText($tmp, $val)
      G secrets create $name --replication-policy=automatic --data-file=$tmp | Out-Null
    } finally { Remove-Item $tmp -Force }
    $shown = if ($val -eq 'NOT_SET') { 'NOT_SET' } else { "$($val.Substring(0, [Math]::Min(6, $val.Length)))... ($($val.Length) caracteres)" }
    Write-Host "   guardado: $shown" -ForegroundColor Green
    Set-Clipboard -Value ' '
  }
  G secrets add-iam-policy-binding $name --member="serviceAccount:$RuntimeSa" --role=roles/secretmanager.secretAccessor --quiet | Out-Null
}
# resend-api-key ya existe (lo creó estimates-saas) y la cuenta de runtime ya puede leerlo.

Write-Host ''
Write-Host "== Listo. Variables para GitHub ($GitHubRepo -> Settings -> Secrets and variables -> Actions -> Variables):" -ForegroundColor Green
Write-Host "   GCP_PROJECT_ID   = $ProjectId"
Write-Host '   GCP_REGION       = us-east1'
Write-Host "   WIF_PROVIDER     = projects/$ProjectNumber/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
Write-Host "   DEPLOY_SA        = $DeploySa"
Write-Host "   RUNTIME_SA       = $RuntimeSa"
Write-Host '   y las del README (PUBLIC_URL, ALLOWED_ORIGINS, SUPABASE_URL, RESEND_FROM_EMAIL, NOTIFY_EMAIL...)'
