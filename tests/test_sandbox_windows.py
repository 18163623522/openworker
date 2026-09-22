"""The Windows sandbox provider (design doc `sandbox-windows-design.md`, section 7).

Live tests: they run only on Windows, as the current user, with no setup. What they prove
is the write-restricted mode: a write outside the session's folders fails, one inside
works, the entries the provider adds are gone when it closes.
"""

from __future__ import annotations

import os
import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="the Windows sandbox exists only on Windows")

from coworker.sandbox.bundle import build_runner_zipapp  # noqa: E402
from coworker.sandbox.workspace import RunnerWorkspace  # noqa: E402


@pytest.fixture
def sandbox(tmp_path):
    from coworker.sandbox.providers.windows import WindowsProvider

    project = tmp_path / "project"
    project.mkdir()
    (project / "a.txt").write_text("hello\n")
    zipapp = build_runner_zipapp(tmp_path / "dist")
    provider = WindowsProvider(roots=[{"path": str(project), "writable": True}], cwd=project, runner_path=zipapp, network=False)
    ws = RunnerWorkspace(provider, cwd=project)
    ws.executor.default_timeout = 60
    yield ws, provider, project
    ws.close()


def test_writes_are_limited_to_the_sessions_folders(sandbox, tmp_path):
    ws, provider, project = sandbox
    assert ws.describe()["enforcement"] == "partial"
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
