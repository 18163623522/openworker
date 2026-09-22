"""The one-time setup for the full Windows sandbox (design doc, section 7, step 3).

`openworker machine sandbox setup` on Windows runs ONE elevated PowerShell script (one UAC
prompt) that:
1. creates the hidden local account `OpenWorkerSandbox` with a random password nobody sees;
2. hides it from the sign-in screen and denies it remote and network logon (it may only be
   logged on by `CreateProcessWithLogonW`, which is an interactive logon, so that one stays);
3. writes one Windows Firewall rule that blocks every OUTBOUND connection for that account,
   so the internet is reachable only through our allow-list proxy (which is loopback, and
   Windows Firewall does not filter loopback: spike finding C. Other local ports stay open
   until the WFP filters are built);
4. stores the password in `C:\\ProgramData\\OpenWorker\\sandbox\\account.cred`, readable by
   the user who ran setup, Administrators and SYSTEM, and by nobody else (the sandbox
   account cannot read it). DPAPI would be one layer more, and does not work for a
   key-based SSH logon (spike finding E); it can be added later;
5. makes `C:\\ProgramData\\OpenWorker\\sandbox\\sandboxes`, where each sandbox gets its
   private folder (the user's own temp folder is inside the profile the account cannot see);
6. records what it changed in `setup.json`, so `remove` can undo exactly that.

The provider reads `account()` at start: with it, full mode; without it, the same-user mode.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

ACCOUNT = "OpenWorkerSandbox"
ROOT = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "OpenWorker" / "sandbox"
SANDBOXES = ROOT / "sandboxes"
CRED_FILE = ROOT / "account.cred"
STATE_FILE = ROOT / "setup.json"
FIREWALL_RULE = "OpenWorker sandbox: block outbound"
SETUP_VERSION = 1

# The elevated script. `$UserSid` is the account that may read the password (the person
# running setup); `$Root` and `$Account` come from the constants above.
SETUP_SCRIPT = r'''
param([string]$UserSid, [string]$Account, [string]$Root, [string]$Rule, [int]$Version)
$ErrorActionPreference = "Stop"
$changed = @()
New-Item -Force -ItemType Directory $Root | Out-Null

# 1. The account, with a password that exists only in this process and in the credential file.
$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes) + "aA1!"
$secure = ConvertTo-SecureString $password -AsPlainText -Force
if (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue) {
  Set-LocalUser -Name $Account -Password $secure -PasswordNeverExpires $true -UserMayChangePassword $false
} else {
  New-LocalUser -Name $Account -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires `
    -Description "OpenWorker sandbox account (agents' commands)" | Out-Null
  $changed += "account"
}
if (-not (Get-LocalGroupMember -Group Users -Member $Account -ErrorAction SilentlyContinue)) { Add-LocalGroupMember -Group Users -Member $Account }
$sid = (Get-LocalUser -Name $Account).SID.Value

# 2. Hidden from the sign-in screen; no remote desktop, no network (share) logon.
$key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
New-Item -Force $key | Out-Null
New-ItemProperty -Force -Path $key -Name $Account -Value 0 -PropertyType DWord | Out-Null
$changed += "userlist"
$inf = Join-Path $env:TEMP "ow-rights.inf"; $inf2 = Join-Path $env:TEMP "ow-rights2.inf"; $sdb = Join-Path $env:TEMP "ow-rights.sdb"
secedit /export /cfg $inf /areas USER_RIGHTS | Out-Null
$lines = Get-Content $inf
foreach ($right in @("SeDenyRemoteInteractiveLogonRight", "SeDenyNetworkLogonRight", "SeDenyServiceLogonRight")) {
  if ($lines -match "^$right") { $lines = $lines | ForEach-Object { if ($_ -match "^$right" -and $_ -notmatch [regex]::Escape($sid)) { "$_,*$sid" } else { $_ } } }
  else { $lines = $lines -replace "^\[Privilege Rights\]", "[Privilege Rights]`r`n$right = *$sid" }
}
$lines | Set-Content $inf2 -Encoding Unicode
secedit /configure /db $sdb /cfg $inf2 /areas USER_RIGHTS | Out-Null
Remove-Item -Force $inf, $inf2, $sdb -ErrorAction SilentlyContinue
$changed += "logon-rights"

# 3. No outbound network for the account. (Loopback is not filtered by Windows Firewall.)
Remove-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $Rule -Direction Outbound -Action Block -Profile Any -Enabled True `
  -LocalUser "D:(A;;CC;;;$sid)" -Description "OpenWorker: the sandbox account reaches the network only through the allow-list proxy on this machine." | Out-Null
$changed += "firewall"

# 4. The password, readable by the person who ran setup and by administrators only.
$cred = Join-Path $Root "account.cred"
Set-Content -Path $cred -Value "$Account`n$password" -Encoding ASCII -NoNewline
icacls $cred /inheritance:r /grant "*S-1-5-18:F" /grant "*S-1-5-32-544:F" /grant "*${UserSid}:R" | Out-Null
$password = $null; $secure = $null
$changed += "credential"

# 5. Where sandboxes keep their private folders: the person makes them, the account gets each one.
$boxes = Join-Path $Root "sandboxes"
New-Item -Force -ItemType Directory $boxes | Out-Null
icacls $boxes /inheritance:r /grant "*S-1-5-18:(OI)(CI)F" /grant "*S-1-5-32-544:(OI)(CI)F" /grant "*${UserSid}:(OI)(CI)M" /grant "*${sid}:RX" | Out-Null
$changed += "sandboxes-folder"

# 6. The record.
@{ version = $Version; account = $Account; sid = $sid; user_sid = $UserSid; firewall_rule = $Rule; changed = $changed } |
  ConvertTo-Json | Set-Content -Path (Join-Path $Root "setup.json") -Encoding ASCII
icacls (Join-Path $Root "setup.json") /grant "*S-1-1-0:R" | Out-Null
Write-Output "ok $sid"
'''

REMOVE_SCRIPT = r'''
param([string]$Account, [string]$Root, [string]$Rule)
$ErrorActionPreference = "Continue"
Remove-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue
$key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
Remove-ItemProperty -Path $key -Name $Account -ErrorAction SilentlyContinue
if (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $Account }
$profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like "*\$Account" }
if ($profile) { $profile | Remove-CimInstance }
Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
Write-Output "removed"
'''


def state() -> Optional[dict[str, Any]]:
    """What setup recorded, or None when setup has not run (or was removed)."""
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def account() -> Optional[tuple[str, str, str]]:
    """(name, sid, password) when the full mode can be used by THIS user: setup has run and
    the credential file is readable. The password never leaves the process."""
    recorded = state()
    if not recorded:
        return None
    try:
        text = CRED_FILE.read_text(encoding="ascii")
    except OSError:
        return None
    name, _, password = text.partition("\n")
    if name != recorded.get("account") or not password:
        return None
    return name, str(recorded.get("sid") or ""), password


def _powershell(script: str, arguments: list[str], *, elevate: bool) -> subprocess.CompletedProcess:
    """Run a script file with PowerShell; `elevate` asks for administrator rights (the UAC
    prompt) and waits. Output comes back through a file, because an elevated process has
    no pipes to us."""
    folder = tempfile.mkdtemp(prefix="ow-setup-")
    path = os.path.join(folder, "setup.ps1")
    out = os.path.join(folder, "out.txt")
    Path(path).write_text(script, encoding="utf-8-sig")
    inner = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path, *arguments]
    try:
        if not elevate:
            return subprocess.run(["powershell.exe", *inner], capture_output=True, text=True, timeout=600)
        quoted = " ".join(f"'{a}'" for a in inner)
        starter = (
            f"$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden "
            f"-ArgumentList @({quoted}, '*>', '{out}'); exit $p.ExitCode"
        )
        done = subprocess.run(["powershell.exe", "-NoProfile", "-Command", starter], capture_output=True, text=True, timeout=900)
        said = Path(out).read_text(encoding="utf-8", errors="replace") if os.path.exists(out) else ""
        return subprocess.CompletedProcess(done.args, done.returncode, said, done.stderr)
    finally:
        import shutil

        shutil.rmtree(folder, ignore_errors=True)


def is_elevated() -> bool:
    import ctypes

    try:
        return bool(ctypes.WinDLL("shell32").IsUserAnAdmin())
    except OSError:
        return False


def run_setup() -> tuple[bool, str]:
    """Create the account and everything around it. Returns (ok, what the script said)."""
    from .. import winsec

    arguments = ["-UserSid", winsec.current_user_sid(), "-Account", ACCOUNT, "-Root", str(ROOT), "-Rule", FIREWALL_RULE, "-Version", str(SETUP_VERSION)]
    done = _powershell(SETUP_SCRIPT, arguments, elevate=not is_elevated())
    said = (done.stdout or "").strip() + (("\n" + done.stderr.strip()) if done.stderr and done.stderr.strip() else "")
    return done.returncode == 0 and "ok " in said, said


def run_remove() -> tuple[bool, str]:
    done = _powershell(REMOVE_SCRIPT, ["-Account", ACCOUNT, "-Root", str(ROOT), "-Rule", FIREWALL_RULE], elevate=not is_elevated())
    said = (done.stdout or "").strip()
    return done.returncode == 0 and "removed" in said, said


def checks() -> list[tuple[str, bool, str]]:
    """(what, ok, detail) rows for `sandbox status` on Windows."""
    if sys.platform != "win32":
        return []
    recorded = state()
    rows = [("the sandbox account exists (setup has run)", bool(recorded), "" if recorded else "run `openworker machine sandbox setup`")]
    usable = account() is not None
    rows.append(("this user can start sandboxes as that account", usable, "" if usable else f"{CRED_FILE} is not readable by this user; run setup as this user"))
    return rows
