Write-Host '=== Diagnóstico Localhost / Node ==='
Write-Host '[1] Version Node'
try { node -v } catch { Write-Host 'Node no disponible en PATH' }

Write-Host '[2] Procesos node activos'
try { tasklist /FI "IMAGENAME eq node.exe" } catch {}

Write-Host '[3] Puertos escuchando (filtro 3000,5005)'
(netstat -ano | findstr /R ":3000 .*LISTEN" ) 2>$null
(netstat -ano | findstr /R ":5005 .*LISTEN" ) 2>$null

Write-Host '[4] Prueba mini servidor 5005'
$script = @"
const http = require('http');
http.createServer((req,res)=>{res.end('mini-ok');}).listen(5005,'127.0.0.1',()=>{console.log('mini server en 127.0.0.1:5005');});
"@
$tmp = Join-Path $env:TEMP mini_test_server.js
$script | Out-File -Encoding ASCII $tmp
Start-Process -FilePath "node" -ArgumentList $tmp -WindowStyle Hidden
Start-Sleep -Seconds 1
Write-Host 'Test-NetConnection 127.0.0.1:5005'
try { Test-NetConnection -ComputerName 127.0.0.1 -Port 5005 } catch {}

Write-Host '[5] Test-NetConnection 127.0.0.1:3000'
try { Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 } catch {}

Write-Host '[6] Hosts file línea localhost'
$hosts = 'C:\Windows\System32\drivers\etc\hosts'
if(Test-Path $hosts){
  (Get-Content $hosts | Select-String -Pattern '127.0.0.1' -SimpleMatch) | ForEach-Object { $_.Line } 
} else { Write-Host 'Archivo hosts no encontrado' }

Write-Host '[7] Perfil firewall reglas node'
try { netsh advfirewall firewall show rule name=all | findstr /I node } catch {}

Write-Host '[8] Adaptadores activos IPv4 loopback'
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq '127.0.0.1' } | Format-Table -AutoSize

Write-Host '=== FIN Diagnóstico ==='
