Write-Host '=== Diagnóstico Node Local ==='
Write-Host '[1] Version Node'
try { node -v } catch { Write-Host 'Node no instalado' }

Write-Host '[2] Rutas Node'
where node 2>$null | ForEach-Object { $_ }

Write-Host '[3] Mini servidor puerto 3100'
$mini = @'
const http=require('http');
http.createServer((q,r)=>{r.end('ok3100');})
 .listen(3100,'127.0.0.1',()=>console.log('LISTEN3100 PID',process.pid));
'@
Set-Content -Path .\mini3100.js -Value $mini -Encoding UTF8
node mini3100.js | Out-Host
Start-Sleep -Seconds 1

Write-Host '[4] Get-NetTCPConnection 3100'
Get-NetTCPConnection -LocalPort 3100 -State Listen 2>$null | Format-Table -AutoSize

Write-Host '[5] Prueba Invoke-RestMethod'
try { Invoke-RestMethod http://127.0.0.1:3100/ | Out-Host } catch { Write-Host 'Fallo solicitud: ' $_.Exception.Message }

Write-Host '[6] Firewall regla temporal'
try { New-NetFirewallRule -DisplayName 'NodeDev3100' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3100 -ErrorAction Stop | Out-Null } catch { Write-Host 'Regla ya existe o error: ' $_.Exception.Message }

Write-Host '[7] Repetir conexión tras regla'
try { Invoke-RestMethod http://127.0.0.1:3100/ | Out-Host } catch { Write-Host 'Fallo nuevamente: ' $_.Exception.Message }

Write-Host '[8] Probar puerto alto 55077'
$mini2 = @'
const http=require('http');
http.createServer((q,r)=>{r.end('ok55077');})
 .listen(55077,'127.0.0.1',()=>console.log('LISTEN55077 PID',process.pid));
'@
Set-Content -Path .\mini55077.js -Value $mini2 -Encoding UTF8
node mini55077.js | Out-Host
Start-Sleep -Seconds 1
Get-NetTCPConnection -LocalPort 55077 -State Listen 2>$null | Format-Table -AutoSize
try { Invoke-RestMethod http://127.0.0.1:55077/ | Out-Host } catch { Write-Host 'Fallo solicitud: ' $_.Exception.Message }

Write-Host '[9] Mostrar winsock providers (primeras 15 líneas)'
cmd /c netsh winsock show catalog > winsock_catalog.txt
Get-Content winsock_catalog.txt -TotalCount 15

Write-Host '=== Fin Diagnóstico ==='
