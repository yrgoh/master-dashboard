$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$env:USERPROFILE\Desktop\Master Dashboard.lnk")
$s.TargetPath = "C:\Users\gohyi\master-dashboard\launch.bat"
$s.WorkingDirectory = "C:\Users\gohyi\master-dashboard"
$s.WindowStyle = 7
$s.Save()
Write-Host "Shortcut created on Desktop"
