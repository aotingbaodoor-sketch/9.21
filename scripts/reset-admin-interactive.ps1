$adminEmail = Read-Host '请输入 CRM 管理员邮箱'
$securePassword = Read-Host '请输入新的 CRM 管理员密码（至少12位，输入不会显示）' -AsSecureString
$adminName = Read-Host '请输入管理员显示名称'
$env:ADMIN_EMAIL = $adminEmail
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
$env:ADMIN_NAME = $adminName
node --env-file-if-exists=.env build/scripts/reset-admin.js
Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
Read-Host '完成后按 Enter 关闭窗口'
