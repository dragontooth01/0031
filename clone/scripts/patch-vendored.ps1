# patch-vendored.ps1 — 预改写 vendored SPA，使其可在本地服务器原样运行
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patch-vendored.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$enc = New-Object System.Text.UTF8Encoding($false)

function Read-Text([string]$p) { return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$p, [string]$c) { [System.IO.File]::WriteAllText($p, $c, $enc) }
function Patch-File([string]$p, [string]$from, [string]$to) {
  if (-not (Test-Path $p)) { Write-Host "  skip (missing): $p"; return }
  $c = Read-Text $p
  if ($c.Contains($from)) {
    $c = $c.Replace($from, $to)
    Write-Text $p $c
    Write-Host "  patched: $([IO.Path]::GetFileName($p))"
  } else {
    Write-Host "  noop: $([IO.Path]::GetFileName($p))"
  }
}

$lz = Join-Path $root 'vendor\liangzhai'
$ent = Join-Path $root 'vendor\enterprise'

Write-Host '== frontend (liangzhai) =='
$htmls = @('index.html', 'subwin.html')
foreach ($h in $htmls) {
  $p = Join-Path $lz $h
  if (Test-Path $p) {
    $c = Read-Text $p
    if (-not $c.Contains('/__shim.js')) {
      $c = $c.Replace('<script>var ipcRenderer', '<script src=/__shim.js></script><script>var ipcRenderer')
      Write-Text $p $c
      Write-Host "  shim injected: $h"
    } else {
      Write-Host "  shim already: $h"
    }
  }
}
$lzjs = Get-ChildItem (Join-Path $lz 'js') -Filter '*.js'
foreach ($f in $lzjs) { Patch-File $f.FullName 'https://lzapi.e-shigong.com/api' '/api' }

Write-Host '== backend (enterprise) =='
# index.html 保持绝对路径（/css /js /favicon.ico ...），由服务器根路径兜底 + history 路由 fallback 提供，
# 这样后台 SPA 在 /enterprise /budget /supplier /template /user 任意路径下都能正确加载。
Write-Host '  index.html keeps absolute paths (root fallback serves them)'
$entjs = Get-ChildItem (Join-Path $ent 'js') -Filter '*.js'
foreach ($f in $entjs) {
  Patch-File $f.FullName 'https://lzapi.e-shigong.com/api' '/api'
}
# 后台静态资源（登录页 logo 等，webpack 绝对路径 /img/ 等）从原站下载
$entImg = Join-Path $ent 'img'
if (-not (Test-Path $entImg)) { New-Item -ItemType Directory -Force -Path $entImg | Out-Null }
foreach ($img in @('logo.47caff6c.png', 'logo2.1adee691.png', 'temp_type1.c008439f.png', 'temp_type2.fc376880.png', 'preview1.777aa60b.png', 'preview2.49873a73.png', 'no_file.6a0919f8.png', 'iphone.5ec894fd.png')) {
  $p = Join-Path $entImg $img
  if (-not (Test-Path $p)) {
    try {
      Invoke-WebRequest -Uri ("https://enterprise.e-shigong.com/img/" + $img) -UseBasicParsing -TimeoutSec 30 -OutFile $p
      Write-Host "  downloaded img/$img"
    } catch { Write-Host "  skip img/$img" }
  }
}
# 版本检查文件（前端 GET /version.json?t=...，缺失会导致 axios 404 报"网络错误"）
$verJson = Join-Path $ent 'version.json'
if (-not (Test-Path $verJson)) {
  try {
    Invoke-WebRequest -Uri 'https://enterprise.e-shigong.com/version.json' -UseBasicParsing -TimeoutSec 30 -OutFile $verJson
    Write-Host '  downloaded version.json'
  } catch { Write-Host '  skip version.json' }
}

# ===== 本地化：外链静态资源下载 + 引用改写（可离线显示） =====
# 后台：登录页图、示例图、说明图、新浪表情
$entImg2 = Join-Path $ent 'img'
New-Item -ItemType Directory -Force -Path (Join-Path $entImg2 'emoji') | Out-Null
$entAssets = @(@('lz_enterprise_login_img.png', 'https://cdn.e-shigong.com/lz_enterprise_login_img.png'), @('lz_enterprise_login_bg.jpg', 'https://cdn.e-shigong.com/lz_enterprise_login_bg.jpg'), @('visit1.jpg', 'https://cdn.e-shigong.com/images/visit1.jpg'), @('visit2.jpg', 'https://cdn.e-shigong.com/images/visit2.jpg'), @('new_project1.png', 'https://cdn.e-shigong.com/static/image/new_project1.png'), @('new_project2.png', 'https://cdn.e-shigong.com/static/image/new_project2.png'), @('budget_desc.png', 'http://cdn.e-shigong.com/budget_desc.png'), @('emoji\pcmoren_huaixiao_org.png', 'http://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/50/pcmoren_huaixiao_org.png'), @('emoji\pcmoren_tian_org.png', 'http://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/40/pcmoren_tian_org.png'), @('emoji\pcmoren_wu_org.png', 'http://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/3c/pcmoren_wu_org.png'), @('emoji\shenshou_thumb.gif', 'http://img.t.sinajs.cn/t35/style/images/common/face/ext/normal/7a/shenshou_thumb.gif'), @('emoji\horse2_thumb.gif', 'http://img.t.sinajs.cn/t35/style/images/common/face/ext/normal/60/horse2_thumb.gif'), @('emoji\fuyun_thumb.gif', 'http://img.t.sinajs.cn/t35/style/images/common/face/ext/normal/bc/fuyun_thumb.gif'))
foreach ($a in $entAssets) {
  $p = Join-Path $entImg2 $a[0]
  if (-not (Test-Path $p)) {
    try { Invoke-WebRequest -Uri $a[1] -UseBasicParsing -TimeoutSec 30 -OutFile $p; Write-Host "  downloaded $($a[0])" } catch { Write-Host "  skip $($a[0])" }
  }
}
# 后台 chunk/CSS 引用改写
Patch-File (Join-Path $ent 'js\chunk-3043787a.5db4a214.js') 'https://cdn.e-shigong.com/lz_enterprise_login_img.png' '/img/lz_enterprise_login_img.png'
Patch-File (Join-Path $ent 'css\chunk-3043787a.fac6b2a3.css') 'url(https://cdn.e-shigong.com/lz_enterprise_login_bg.jpg)' 'url(/img/lz_enterprise_login_bg.jpg)'
foreach ($pair in @(@('https://cdn.e-shigong.com/images/visit1.jpg', '/img/visit1.jpg'), @('https://cdn.e-shigong.com/images/visit2.jpg', '/img/visit2.jpg'), @('https://cdn.e-shigong.com/static/image/new_project1.png', '/img/new_project1.png'), @('https://cdn.e-shigong.com/static/image/new_project2.png', '/img/new_project2.png'))) {
  Patch-File (Join-Path $ent 'js\chunk-10be3465.9dc2b6eb.js') $pair[0] $pair[1]
}
Patch-File (Join-Path $ent 'js\chunk-21663b50.9a5bc516.js') 'http://cdn.e-shigong.com/budget_desc.png' '/img/budget_desc.png'
foreach ($pair in @(@('http://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/50/pcmoren_huaixiao_org.png', '/img/emoji/pcmoren_huaixiao_org.png'), @('http://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/40/pcmoren_tian_org.png', '/img/emoji/pcmoren_tian_org.png'), @('http://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/3c/pcmoren_wu_org.png', '/img/emoji/pcmoren_wu_org.png'), @('http://img.t.sinajs.cn/t35/style/images/common/face/ext/normal/7a/shenshou_thumb.gif', '/img/emoji/shenshou_thumb.gif'), @('http://img.t.sinajs.cn/t35/style/images/common/face/ext/normal/60/horse2_thumb.gif', '/img/emoji/horse2_thumb.gif'), @('http://img.t.sinajs.cn/t35/style/images/common/face/ext/normal/bc/fuyun_thumb.gif', '/img/emoji/fuyun_thumb.gif'))) {
  Patch-File (Join-Path $ent 'js\chunk-23576df0.d52f5ced.js') $pair[0] $pair[1]
}
# 前台：机器人头像/占位图/示例图/echarts 本地化
$lzAssets = @(@('img\system_robot.png', 'https://cdn.e-shigong.com/system_robot.png'), @('static\no_big_material_holder2.png', 'https://cdn.e-shigong.com//static/no_big_material_holder2.png'), @('img\common-image-1610934838-20210118095358x55332.png', 'http://cdn.e-shigong.com/common-image-1610934838-20210118095358x55332.png'), @('js\echarts.min.js', 'https://cdn.bootcss.com/echarts/4.6.0/echarts.min.js'))
foreach ($a in $lzAssets) {
  $p = Join-Path $lz $a[0]
  if (-not (Test-Path $p)) {
    try { Invoke-WebRequest -Uri $a[1] -UseBasicParsing -TimeoutSec 60 -OutFile $p; Write-Host "  downloaded $($a[0])" } catch { Write-Host "  skip $($a[0])" }
  }
}
foreach ($f in (Get-ChildItem (Join-Path $lz 'js') -Filter '*.js')) {
  Patch-File $f.FullName 'https://cdn.e-shigong.com/system_robot.png' 'img/system_robot.png'
  Patch-File $f.FullName 'https://cdn.e-shigong.com//static/no_big_material_holder2.png' 'static/no_big_material_holder2.png'
  Patch-File $f.FullName 'http://cdn.e-shigong.com/common-image-1610934838-20210118095358x55332.png' 'img/common-image-1610934838-20210118095358x55332.png'
  Patch-File $f.FullName 'https://cdn.bootcss.com/echarts/4.6.0/echarts.min.js' 'js/echarts.min.js'
}
# 禁用 Sentry（错误上报外网域名，本地无意义且产生外网请求）
foreach ($f in @('index.17c5d53c.js', 'index.d04fe364.js', 'index.e2cb131d.js', 'subwin.63035440.js', 'subwin.b086e666.js', 'subwin.cf9f6607.js')) {
  $p = Join-Path $lz 'js'
  $path = Join-Path $p $f
  if (Test-Path $path) {
    $c = Read-Text $path
    $m = [regex]::Match($c, 'dsn:"[^"]+"')
    if ($m.Success -and $m.Value -ne 'dsn:""') { Write-Text $path ($c.Replace($m.Value, 'dsn:""')); Write-Host "  sentry disabled: $f" }
  }
}
$appP = Join-Path $ent 'js\app.ebd1cb38.js'
if (Test-Path $appP) {
  $c = Read-Text $appP
  $m = [regex]::Match($c, 'dsn:"[^"]+"')
  if ($m.Success -and $m.Value -ne 'dsn:""') { Write-Text $appP ($c.Replace($m.Value, 'dsn:""')); Write-Host '  sentry disabled: app.ebd1cb38.js' }
}

# static 页面（协议/政策/监控/地图）改为本地 /__static/ 路径（覆盖单/双斜杠两种写法）
$lzall = Get-ChildItem (Join-Path $lz 'js') -Filter '*.js'
foreach ($f in $lzall) {
  Patch-File $f.FullName 'https://lzapi.e-shigong.com//static/' '/__static/'
  Patch-File $f.FullName 'https://lzapi.e-shigong.com/static/' '/__static/'
  # 拼接写法: "".concat("https://lzapi.e-shigong.com","/static/live/index.html?code=")
  Patch-File $f.FullName '"https://lzapi.e-shigong.com"' '"/__static"'
  Patch-File $f.FullName '"/static/live/' '"/live/'
  Patch-File $f.FullName '"/static/bmap_marker.html' '"/bmap_marker.html'
}
# pdf.js viewer：关闭 file 参数跨域校验（本地预览远端 PDF 文件）
Patch-File (Join-Path $lz 'web\viewer.js') 'if (origin !== viewerOrigin && protocol !== "blob:") {' 'if (false && origin !== viewerOrigin && protocol !== "blob:") {'
# 企业介绍预览页（/preview-profile）：直接访问时 sessionStorage 无 companyDetail 草稿 → 回退调用 API 拉取真实数据
Patch-File (Join-Path $ent 'js\chunk-0bea87e8.bcefaf39.js') 'created:function(){this.companyInfo=JSON.parse(sessionStorage.getItem("companyDetail"))}' 'created:function(){var a=this;try{a.companyInfo=JSON.parse(sessionStorage.getItem("companyDetail"))}catch(e){a.companyInfo=null}a.companyInfo||a.getCompanyInfo()}'
# 后台预算模板页：PDF 预览 file 参数改为本地 /__file 代理（CDN 无 CORS 预检头，跨域 Range 会被浏览器拦截）
Patch-File (Join-Path $ent 'js\chunk-21663b50.9a5bc516.js') '"/web/viewer.html?file="+t.descUrl+"#page=1"' '"/web/viewer.html?file="+encodeURIComponent("/__file?url="+encodeURIComponent(t.descUrl))+"#page=1"'

# 自定义覆盖层（本地预览页与库文件）复制回 vendor（vendor 重新同步后会丢失，这里补回）
$overlay = Join-Path $root 'overlay'
if (Test-Path $overlay) {
  Copy-Item -Path (Join-Path $overlay '*') -Destination $lz -Recurse -Force
  Write-Host '  overlay copied (office-viewer.html + lib)'
}

Write-Host '== residual check =='
foreach ($f in $lzjs) {
  $c = Read-Text $f.FullName
  if ($c.Contains('lzapi.e-shigong.com')) { Write-Host "  RESIDUAL lzapi in liangzhai/js/$($f.Name)" }
}
foreach ($f in $entjs) {
  $c = Read-Text $f.FullName
  if ($c.Contains('lzapi.e-shigong.com')) { Write-Host "  RESIDUAL lzapi in enterprise/js/$($f.Name)" }
}
Write-Host '== done =='
