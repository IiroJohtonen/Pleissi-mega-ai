# Asettaa Kotilon käynnistymään itsestään, kun kirjaudut Windowsiin. Aja kerran tuotantokopion kansiosta:
#   powershell -ExecutionPolicy Bypass -File deploy\autostart.ps1
# Poisto:  Unregister-ScheduledTask -TaskName Kotilo -Confirm:$false
$ErrorActionPreference = "Stop"
$start = Join-Path $PSScriptRoot "start.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Tehtävää ei katkaista aikarajan takia, ja se käynnistyy myös akkuvirralla.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Kotilo" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Kotilo käynnistyy jatkossa kirjautuessasi. Käynnistä se nyt: Start-ScheduledTask -TaskName Kotilo"
