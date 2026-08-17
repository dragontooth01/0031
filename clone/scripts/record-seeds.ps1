# record-seeds.ps1 - pre-record list APIs of the 14 backend pages through the local clone server proxy.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\record-seeds.ps1 [-BaseUrl http://localhost:8000]
param([string]$BaseUrl = 'http://localhost:8000')

$ErrorActionPreference = 'Stop'
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
$auth = @{ 'User-Agent' = $ua; 'Accept' = 'application/json, text/plain, */*'; platform = '3'; model = 'pc'; 'device-version' = '1.0'; width = '900'; height = '900' }

# login to backend admin (account: 18300000001 / 123456)
try {
  $login = Invoke-WebRequest -Uri "$BaseUrl/api/company/login/" -Method POST -Body '{"admin_name":"18300000001","admin_pwd":"123456"}' -ContentType 'application/json' -Headers $auth -UseBasicParsing -TimeoutSec 30
} catch {
  Write-Host "login request failed: $($_.Exception.Message)"
  if ($_.Exception.Response) { Write-Host "HTTP $([int]$_.Exception.Response.StatusCode)" }
  exit 1
}
if ($null -eq $login -or $null -eq $login.Content) {
  Write-Host "login response empty (is the clone server running at $BaseUrl ?)"
  exit 1
}
$j = $login.Content | ConvertFrom-Json
if ($j.code -ne 0) { throw "login failed: $($j.msg)" }
Write-Host "login OK: $($j.data.company_name)"

$setc = $login.Headers['Set-Cookie']
$sid = (($setc -split ',' | Where-Object { $_ -match 'company_session_id' } | Select-Object -First 1) -split ';')[0]
$cid = (($setc -split ',' | Where-Object { $_ -match 'company_id=' } | Select-Object -First 1) -split ';')[0]
$cookie = $sid + '; ' + $cid
$h = @{
  'Cookie' = $cookie
  'session-id' = ($sid -replace 'company_session_id=', '')
  'company-id' = ($cid -replace 'company_id=', '')
  platform = '3'; model = 'pc'; 'device-version' = '1.0'; width = '900'; height = '900'
  'User-Agent' = $ua; 'Accept' = 'application/json, text/plain, */*'
}

$endpoints = @(
  @('/company/v2/department/member/list/', 'POST'),
  @('/company/v2/department/list/', 'POST'),
  @('/company/department/member/all/', 'POST'),
  @('/company/role/list/', 'POST'),
  @('/company/role/sys_role_type/list/', 'POST'),
  @('/permission/web/group/permission/list/', 'POST'),
  @('/company/account/info/', 'GET'),
  @('/company/self/config/', 'GET'),
  @('/company/introduce/info/', 'GET'),
  @('/company/sub_company/list/', 'POST'),
  @('/company/sub_company/authorization/list/', 'POST'),
  @('/company/permission/list/', 'GET'),
  @('/company/permission/member/list/', 'POST'),
  @('/company/permission_group/list/', 'GET'),
  @('/company/system/list/', 'POST'),
  @('/project/company/project/setting/get/', 'GET'),
  @('/project/company/project_identify/setting/get/', 'GET'),
  @('/company/project/payment/setting/', 'GET'),
  @('/budget/material/list/', 'POST'),
  @('/budget/material/count/', 'POST'),
  @('/budget/material/unit/list/', 'POST'),
  @('/budget/material_type/list/', 'POST'),
  @('/budget/material/enable/list/', 'POST'),
  @('/budget/material_lib/list/', 'POST'),
  @('/budget/band/material/list/', 'POST'),
  @('/budget/project_quota_type/list/', 'POST'),
  @('/budget/v2/project_quota/list/', 'POST'),
  @('/budget/sys_project_quota_type/list/', 'POST'),
  @('/budget/template/list/', 'POST'),
  @('/budget/worker_type/list/', 'POST'),
  @('/budget/worker_item/list/', 'POST'),
  @('/budget/specification/list/', 'POST'),
  @('/budget/sys_specification/list/', 'POST'),
  @('/commodity/type/list/', 'POST'),
  @('/commodity/sub_type/list/', 'POST'),
  @('/commodity/list/', 'POST'),
  @('/commodity/band_unit/list/', 'POST'),
  @('/company/v2/supplier_map/list/', 'POST'),
  @('/company/supplier_type/list/', 'POST'),
  @('/company/supplier_map/list/', 'POST'),
  @('/template/craft_template/list/', 'POST'),
  @('/template/list/', 'POST'),
  @('/template_lib/craft/list/', 'POST'),
  @('/template_lib/sys_craft/list/', 'POST'),
  @('/template_lib/sys_step/list/', 'POST'),
  @('/template/market/craft_template/list/', 'POST'),
  @('/company/terminology/list/', 'POST'),
  @('/company/terminology/role/list/', 'POST')
)

$ok = 0; $fail = 0
foreach ($ep in $endpoints) {
  $url = "$BaseUrl/api$($ep[0])"
  $method = $ep[1]
  try {
    if ($method -eq 'GET') {
      $r = Invoke-WebRequest -Uri $url -Headers $h -UseBasicParsing -TimeoutSec 30
    } else {
      $r = Invoke-WebRequest -Uri $url -Method POST -Body '{}' -ContentType 'application/json' -Headers $h -UseBasicParsing -TimeoutSec 30
    }
    $code = ($r.Content | ConvertFrom-Json).code
    if ($code -eq 0) { Write-Host "OK   $($ep[0])"; $ok++ }
    else { Write-Host "CODE $code  $($ep[0])"; $fail++ }
  } catch {
    Write-Host "ERR  $($ep[0]) : $($_.Exception.Message)"; $fail++
  }
}
Write-Host "==== done: ok $ok, fail/nonzero $fail ===="
