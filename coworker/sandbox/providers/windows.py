"""`windows`: the tool runner on Windows, confined by a write-restricted token.

Same runner, same protocol. The wall, in this first mode (`partial`), is Windows' own
restricted-token rule: the daemon runs as the current user but its token carries a
made-up session SID as a RESTRICTING SID with `WRITE_RESTRICTED`, so any write must be
allowed for that SID as well as for the user. The session's writable folders and the
sandbox's private folder get one inheritable Modify entry for the SID; nothing else on the
disk has one. The entries are removed when the sandbox closes. Every process the daemon
starts inherits the token; no program can take it off.

What this mode does NOT do (and says so in `describe()`): reads are the user's reads, so a
key under the profile can be read; the network is the user's network, the allow-list proxy
is only offered through the proxy variables. Folders that grant Everyone a write (the drive
root's "create folder", `C:\\Users\\Public`, `C:\\Windows\\Temp`) stay writable, as in every
write-restricted sandbox. The full mode (a hidden sandbox account, firewall and loopback
filters) needs `openworker machine sandbox setup` and comes next (design doc, section 7).

Learned on the VM (2026-09-22): the restricting list must hold the LOGON SID or no process
starts at all (0xC0000142); the token's default DACL must name the session SID or the
process cannot start children (error 5); a console is fine once both hold.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Optional, Sequence

from .. import credentials as creds
from .. import netproxy, network_profiles
from ..bundle import build_runner_zipapp
from ..launch import runner_command, runner_dir, serve_arguments, spawn_kwargs, wait_for_runner
from ..transport import PipeTransport, Transport
from .seatbelt import _CACHE_VARIABLES, clean_environment

PARTIAL_REASON = (
    "Windows write-restricted token: writes limited to the session's folders; reads and the network are NOT limited"
    " (run `openworker machine sandbox setup` for the full sandbox)"
)
_EVERYONE_WRITABLE = ("the drive root (new folders only)", r"C:\Users\Public", r"C:\Windows\Temp")


class WindowsUnavailable(RuntimeError):
    """The Windows sandbox cannot be used here. The message says why."""


def preflight() -> None:
    if sys.platform != "win32":
        raise WindowsUnavailable("The Windows sandbox exists only on Windows.")
    from .. import winsec

    try:
        winsec.current_user_sid()
        winsec.logon_sid()
    except OSError as exc:
        raise WindowsUnavailable(f"cannot read this process's token: {exc}") from None


class WindowsProvider:
    name = "windows"

    def __init__(
        self,
        *,
        roots: Sequence[dict[str, Any]],
        cwd: str | Path,
        profile: str = network_profiles.DEFAULT_PROFILE,
        network: bool = True,
        runner_path: Optional[Path] = None,
        relay_silence_seconds: Optional[float] = None,
        credentials: Sequence[creds.Grant] = (),
    ) -> None:
        self.roots = _clean_roots(roots)
        self.grants = list(credentials)
        self.copied: Optional[creds.CopiedCredentials] = None
        self.cwd = os.path.realpath(str(cwd))
        self.profile = network_profiles.check(profile)
        self.network = network
        self._runner = Path(runner_path) if runner_path is not None else build_runner_zipapp()
        self._relay_silence = relay_silence_seconds
        self.sandbox = f"sb-{uuid.uuid4().hex[:12]}"
        self.mode = "partial"
        self._dir, self.socket_path = runner_dir()
        self._daemon: Any = None
        self._proxy: Optional[netproxy.AllowListProxy] = None
        self._token: Any = None
        self._desktop: Any = None
        self._granted: list[str] = []  # folders that carry an entry for the session SID right now
        from .. import winsec

        self.session_sid = winsec.session_sid()

    def describe(self) -> dict[str, Any]:
        network = f"advisory: the '{self.profile}' profile through the proxy variables only" if self.network else "the user's own"
        return {
            "provider": self.name,
            "sandbox": self.sandbox,
            "enforcement": self.mode,
            "reason": f"{PARTIAL_REASON}. Network: {network}. Still writable by anyone: {', '.join(_EVERYONE_WRITABLE)}",
            "credentials": self.copied.describe() if self.copied is not None else [],
        }

    # -- start ------------------------------------------------------------------------
    def create(self) -> None:
        try:
            self._create()
        except BaseException:
            self.destroy()  # nothing of a failed sandbox stays behind (entries, folder, token)
            raise

    def _environment(self) -> dict[str, str]:
        env = clean_environment()
        temp = os.path.join(self._dir, "tmp")
        os.makedirs(temp, exist_ok=True)
        env["TEMP"] = env["TMP"] = temp
        for name, folder in _CACHE_VARIABLES.items():
            env[name] = os.path.join(self._dir, "cache", folder)
        if self._proxy is not None:
            env.update(netproxy.environment(self._proxy))
        return env

    def _create(self) -> None:
        preflight()
        from .. import winsec

        if self.network:
            self._proxy = netproxy.shared(self.profile)
        for folder in [r["path"] for r in self.roots if r["writable"]] + [self._dir]:
            winsec.grant_write(folder, self.session_sid)
            self._granted.append(folder)
        self._token = winsec.RestrictedToken(self.session_sid)
        self._desktop = winsec.Desktop(self.session_sid)
        serve = serve_arguments(self.socket_path, self._dir, also_sids=[self.session_sid])
        argv = [*runner_command(self._runner), "serve", *serve, "--cwd", self.cwd, "--exit-with-parent"]
        log = os.path.join(self._dir, "daemon.log")
        self._daemon = winsec.spawn(argv, token=self._token, desktop=self._desktop, cwd=self.cwd, env=self._environment(), stderr_path=log)
        try:
            wait_for_runner(self.socket_path, self._daemon)
        except RuntimeError as exc:
            said = Path(log).read_text(errors="replace").strip() if os.path.exists(log) else ""
            raise WindowsUnavailable(f"the sandboxed tool runner did not start: {exc} {said[-400:]}".strip()) from None

    def open_runner(self) -> Transport:
        argv = [*runner_command(self._runner), "attach", "--socket", self.socket_path]
        if self._relay_silence is not None:
            argv += ["--silence-seconds", str(self._relay_silence)]
        return PipeTransport(
            subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, **spawn_kwargs())
        )

    def verify(self, client: Any) -> None:
        """Every folder is reachable inside, and the wall is really up: a write into the
        user's profile, which no session is given as a whole, must fail."""
        from ..runner.protocol import RunnerError

        for root in self.roots:
            client.call("fs.list", {"path": root["path"], "limit": 1}, timeout=15)
        home = os.path.realpath(os.path.expanduser("~"))
        if any(home == r["path"] or home.startswith(r["path"] + os.sep) for r in self.roots if r["writable"]):
            return  # the user granted the home folder itself; nothing to prove
        probe = os.path.join(home, f"owr-verify-{uuid.uuid4().hex[:8]}.txt")
        try:
            client.call("fs.write", {"path": probe, "text": "probe\n"}, timeout=15)
        except RunnerError:
            return
        try:
            os.remove(probe)
        except OSError:
            pass
        raise WindowsUnavailable("the sandbox did not take effect: a file could be written into the home folder from inside")

    # -- changes ------------------------------------------------------------------------
    def regrant(self, roots: Sequence[dict[str, Any]]) -> None:
        """The session's folders changed. The token is per sandbox, not per folder, so the
        entries move and the daemon stays: a new folder is usable at once, a removed one
        is closed at once."""
        from .. import winsec

        self.roots = _clean_roots(roots)
        wanted = [r["path"] for r in self.roots if r["writable"]] + [self._dir]
        for folder in list(self._granted):
            if folder not in wanted:
                winsec.revoke(folder, self.session_sid)
                self._granted.remove(folder)
        for folder in wanted:
            if folder not in self._granted:
                winsec.grant_write(folder, self.session_sid)
                self._granted.append(folder)

    restarts_on_regrant = False

    def restart_daemon(self) -> None:
        """Tests only: what a sandbox restart looks like from the client's side."""
        self._stop_daemon()
        self._create()

    # -- stop ---------------------------------------------------------------------------
    def _stop_daemon(self) -> None:
        daemon, self._daemon = self._daemon, None
        if daemon is None:
            return
        if daemon.poll() is None:
            daemon.terminate()
            try:
                daemon.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        daemon.close()

    def destroy(self) -> None:
        from .. import winsec

        self._stop_daemon()
        for folder in list(self._granted):
            try:
                winsec.revoke(folder, self.session_sid)
            except OSError:
                pass  # a folder that is gone has no entry to remove
            self._granted.remove(folder)
        for thing in (self._token, self._desktop):
            if thing is not None:
                thing.close()
        self._token = self._desktop = None
        shutil.rmtree(self._dir, ignore_errors=True)


def _clean_roots(roots: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"path": os.path.realpath(r["path"]), "writable": bool(r.get("writable"))} for r in roots]
