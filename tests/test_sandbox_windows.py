"""The Windows sandbox provider (design doc `sandbox-windows-design.md`, section 7).

Live tests, Windows only. The same-user mode needs nothing; the full mode needs setup to
have run on the machine (`openworker machine sandbox setup`) and skips otherwise. Setup
itself is only exercised with OPENWORKER_TEST_WINDOWS_SETUP=1, because it changes the
machine (an account, a firewall rule, a folder under ProgramData).
"""

from __future__ import annotations

import os
import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="the Windows sandbox exists only on Windows")

from coworker.sandbox.bundle import build_runner_zipapp  # noqa: E402
from coworker.sandbox.workspace import RunnerWorkspace  # noqa: E402


def _has_setup() -> bool:
    if sys.platform != "win32":
        return False
    from coworker.sandbox.providers import windows_setup

    return windows_setup.account() is not None


full = pytest.mark.skipif(not _has_setup(), reason="needs `openworker machine sandbox setup` on this machine")


def _open(tmp_path, *, mode, extra_roots=()):
    from coworker.sandbox.providers.windows import WindowsProvider

    project = tmp_path / "project"
    project.mkdir(exist_ok=True)
    (project / "a.txt").write_text("hello\n")
    zipapp = build_runner_zipapp(tmp_path / "dist")
    roots = [{"path": str(project), "writable": True}, *extra_roots]
    provider = WindowsProvider(roots=roots, cwd=project, runner_path=zipapp, network=False, force_mode=mode)
    ws = RunnerWorkspace(provider, cwd=project)
    ws.executor.default_timeout = 60
    return ws, provider, project


@pytest.fixture
def sandbox(tmp_path):
    ws, provider, project = _open(tmp_path, mode="partial")
    yield ws, provider, project
    ws.close()


# -- same-user mode ------------------------------------------------------------------------


def test_writes_are_limited_to_the_sessions_folders(sandbox, tmp_path):
    ws, provider, project = sandbox
    assert ws.describe()["mode"] == "partial"
    inside = ws.executor.run("Set-Content -Path new.txt -Value made; Get-Content new.txt")
    assert inside["exit_code"] == 0 and "made" in inside["output"]
    beside = ws.executor.run(f"Set-Content -Path '{tmp_path / 'beside.txt'}' -Value x")  # the parent, never granted
    assert beside["exit_code"] != 0 and not (tmp_path / "beside.txt").exists()
    home = ws.executor.run("Set-Content -Path (Join-Path $env:USERPROFILE 'owr-probe.txt') -Value x")
    assert home["exit_code"] != 0 and not os.path.exists(os.path.expanduser("~/owr-probe.txt"))
    # Reads are the user's reads in this mode, and the statement says so.
    assert ws.executor.run(f"(Get-ChildItem '{tmp_path}').Count")["exit_code"] == 0
    assert "reads and the network are NOT limited" in ws.describe()["reason"]


def test_the_entries_come_and_go_with_the_sandbox(sandbox, tmp_path):
    from coworker.sandbox import winsec

    ws, provider, project = sandbox
    assert winsec.entries_for(str(project), provider.session_sid)
    assert not winsec.entries_for(str(tmp_path), provider.session_sid)
    ws.close()
    assert not winsec.entries_for(str(project), provider.session_sid)
    assert not os.path.exists(provider._dir)


def test_a_new_folder_is_usable_without_a_restart(sandbox, tmp_path):
    ws, provider, project = sandbox
    extra = tmp_path / "extra"
    extra.mkdir()
    before = ws.client.instance_id
    assert ws.executor.run(f"Set-Content -Path '{extra / 'x.txt'}' -Value x")["exit_code"] != 0
    provider.regrant([{"path": str(project), "writable": True}, {"path": str(extra), "writable": True}])
    assert ws.executor.run(f"Set-Content -Path '{extra / 'x.txt'}' -Value x")["exit_code"] == 0
    assert ws.client.instance_id == before  # the same daemon, the same shells
    provider.regrant([{"path": str(project), "writable": True}])
    assert ws.executor.run(f"Set-Content -Path '{extra / 'y.txt'}' -Value x")["exit_code"] != 0


def test_a_session_workspace_goes_through_the_registry(tmp_path, monkeypatch):
    from coworker.sandbox.registry import SandboxRegistry
    from coworker.sandbox.workspace import open_workspace

    monkeypatch.setenv("OPENWORKER_SANDBOX_PROVIDER", "windows")
    ws = open_workspace(cwd=tmp_path, session_id="s-win", agent="cowork")
    try:
        assert ws.describe()["provider"] == "windows" and ws.describe()["enforcement"] == "partial"
        assert ws.executor.run("echo via-sandbox")["output"].strip() == "via-sandbox"
        rows = SandboxRegistry().list()
        assert [r["session_id"] for r in rows] == ["s-win"] and rows[0]["enforcement"] == "partial"
    finally:
        ws.close()
    assert SandboxRegistry().list() == []


def test_the_provider_is_known_to_selection_and_settings(monkeypatch, tmp_path):
    from coworker.sandbox import selection, settings

    monkeypatch.setenv("OPENWORKER_SANDBOX_PROVIDER", "windows")
    assert selection.select().provider == "windows"
    monkeypatch.delenv("OPENWORKER_SANDBOX_PROVIDER")
    names = {p["name"]: p for p in settings.snapshot()["providers"]}
    assert names["windows"]["usable"] and "seatbelt" not in names


# -- setup and the full mode ---------------------------------------------------------------


@pytest.mark.skipif(os.environ.get("OPENWORKER_TEST_WINDOWS_SETUP") != "1", reason="changes the machine; OPENWORKER_TEST_WINDOWS_SETUP=1 to run")
def test_setup_creates_the_hidden_account_and_status_reports_it():
    import subprocess

    from coworker.sandbox import setup_cmd
    from coworker.sandbox.providers import windows_setup

    said: list[str] = []
    assert setup_cmd.setup(ask=lambda q: True, print_fn=said.append) == 0, "\n".join(said)
    name, sid, password = windows_setup.account()
    assert name == windows_setup.ACCOUNT and sid.startswith("S-1-5-21-") and len(password) > 40
    users = subprocess.run(["powershell", "-NoProfile", "-Command", f"(Get-LocalUser {name}).Enabled"], capture_output=True, text=True).stdout
    assert "True" in users
    rule = subprocess.run(["powershell", "-NoProfile", "-Command", f"(Get-NetFirewallRule -DisplayName '{windows_setup.FIREWALL_RULE}').Enabled"], capture_output=True, text=True).stdout
    assert "True" in rule
    assert any("setup has run" in line for line in said)


@full
def test_full_mode_hides_the_profile_and_gives_the_sessions_folders(tmp_path):
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "ref.txt").write_text("read me\n")
    ws, provider, project = _open(tmp_path, mode="full", extra_roots=[{"path": str(reference), "writable": False}])
    try:
        assert ws.describe()["mode"] == "full"
        who = ws.executor.run("$env:USERNAME")["output"].strip()
        assert who.lower() == "openworkersandbox"
        assert "made" in ws.executor.run("Set-Content -Path new.txt -Value made; Get-Content new.txt")["output"]
        assert "read me" in ws.executor.run(f"Get-Content '{reference / 'ref.txt'}'")["output"]
        assert ws.executor.run(f"Set-Content -Path '{reference / 'no.txt'}' -Value x")["exit_code"] != 0
        assert ws.executor.run("Get-ChildItem $env:USERPROFILE\\..\\Administrator")["exit_code"] != 0  # another account's profile
        listing = ws.executor.run(f"Get-ChildItem '{os.path.expanduser('~')}'")
        assert listing["exit_code"] != 0  # the person's profile: denied
        assert ws.executor.run(f"Set-Content -Path '{tmp_path / 'beside.txt'}' -Value x")["exit_code"] != 0
    finally:
        ws.close()
    from coworker.sandbox import winsec

    assert not winsec.entries_for(str(project), provider.session_sid)
    assert not winsec.entries_for(str(reference), provider.session_sid)
    assert not os.path.exists(provider._dir)


@full
def test_full_mode_blocks_the_network_except_the_proxy(tmp_path):
    from coworker.sandbox.providers.windows import WindowsProvider

    project = tmp_path / "project"
    project.mkdir()
    zipapp = build_runner_zipapp(tmp_path / "dist")
    provider = WindowsProvider(roots=[{"path": str(project), "writable": True}], cwd=project, runner_path=zipapp, network=True, force_mode="full")
    ws = RunnerWorkspace(provider, cwd=project)
    ws.executor.default_timeout = 90
    # curl.exe (shipped with Windows) follows the proxy variables; PowerShell 5's
    # Invoke-WebRequest does not, it uses the system proxy, so it simply sees no network.
    # Windows' own TLS (schannel) checks certificate revocation over plain HTTP, which the
    # firewall blocks: curl needs --ssl-revoke-best-effort; OpenSSL clients (git, Python,
    # Node) do not check that way and are unaffected.
    try:
        direct = ws.executor.run("curl.exe -sS --noproxy '*' -m 8 -o NUL -w '%{http_code}' https://example.com; 'exit ' + $LASTEXITCODE")
        assert "200" not in direct["output"] and "exit 0" not in direct["output"], direct["output"]
        via = ws.executor.run("curl.exe -sS --ssl-revoke-best-effort -m 30 -o NUL -w '%{http_code}' https://api.github.com")
        assert "200" in via["output"], via["output"]
        refused = ws.executor.run("curl.exe -sS --ssl-revoke-best-effort -m 30 -o NUL -w '%{http_code}' https://example.com")
        assert "403" in refused["output"], refused["output"]
    finally:
        ws.close()
