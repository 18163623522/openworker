"""OpenWorker running inside an OpenShell sandbox (`OPENSHELL_SANDBOX=1`): the agent is
told what a blocked request looks like, OpenShell's own skills are readable, and the web
tools leave the name lookup to OpenShell's proxy. Outside OpenShell nothing changes."""

from __future__ import annotations

import socket
from pathlib import Path

import pytest

from coworker.agent import build_engine
from coworker.agents.cowork import cowork_agent
from coworker.sandbox import inside
from coworker.web import guard

PROXY_ENV = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")


class _StubProvider:
    def complete(self, **_kw):  # pragma: no cover - never called at build time
        from coworker.providers import AssistantTurn

        return AssistantTurn()

    def capabilities(self, _model):  # pragma: no cover
        from coworker.providers.base import ModelCapabilities

        return ModelCapabilities()


@pytest.fixture
def outside(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENSHELL_SANDBOX", raising=False)
    for name in PROXY_ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def in_openshell(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Inside a sandbox whose proposals are off: no skills folder yet."""
    for name in PROXY_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENSHELL_SANDBOX", "1")
    monkeypatch.setenv("HTTPS_PROXY", "http://10.200.0.1:3128")
    skills = tmp_path / "etc-openshell-skills"
    monkeypatch.setattr(inside, "SKILLS_DIR", skills)
    return skills


def _turn_on_proposals(skills: Path) -> None:
    """What OpenShell writes when `agent_policy_proposals_enabled` is set."""
    (skills / "policy-advisor").mkdir(parents=True)
    (skills / "policy-advisor" / "SKILL.md").write_text(
        "---\nname: openshell-policy-advisor\n"
        "description: Use when an OpenShell sandbox returns policy_denied.\n---\n\n"
        "Read `/etc/openshell/skills/policy_advisor.md`.\n",
        encoding="utf-8",
    )
    (skills / "policy_advisor.md").write_text("# OpenShell Policy Advisor\n", encoding="utf-8")


def _engine(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    return build_engine(agent=cowork_agent(), workspace=ws, provider=_StubProvider())


# -- what the agent is told -------------------------------------------------------------


def test_outside_openshell_nothing_is_said_or_added(outside, tmp_path: Path) -> None:
    assert inside.context() == ""
    engine = _engine(tmp_path)
    assert "OpenShell" not in engine.context_provider()
    assert [r.label for r in engine.roots if r.label == "openshell-skills"] == []


def test_inside_the_agent_is_told_what_a_blocked_request_looks_like(in_openshell: Path, tmp_path: Path) -> None:
    text = _engine(tmp_path).context_provider()
    assert "runs inside an OpenShell sandbox" in text
    assert "CONNECT tunnel failed, response 403" in text and "policy_denied" in text
    # Proposals are off, so there is no skill to load: the person changes the policy.
    assert "openshell policy update --add-endpoint HOST:PORT" in text
    assert "openshell-policy-advisor" not in text


def test_with_proposals_on_the_agent_is_pointed_at_openshells_skill(in_openshell: Path, tmp_path: Path) -> None:
    _turn_on_proposals(in_openshell)
    engine = _engine(tmp_path)
    text = engine.context_provider()
    assert "load the skill `openshell-policy-advisor`" in text
    assert "openshell policy update" not in text
    # The skill is on the menu under OpenShell's own name and description…
    assert "Use when an OpenShell sandbox returns policy_denied." in text
    assert engine.skill_loader.get("openshell-policy-advisor") is not None
    # …and its folder is one the agent may read, never write.
    (root,) = [r for r in engine.roots if r.label == "openshell-skills"]
    assert root.path == in_openshell.resolve() and root.writable is False


def test_proposals_turned_on_mid_session_are_picked_up_on_the_next_turn(in_openshell: Path, tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    assert "openshell policy update" in engine.context_provider()
    _turn_on_proposals(in_openshell)
    text = engine.context_provider()
    assert "load the skill `openshell-policy-advisor`" in text
    assert "Use when an OpenShell sandbox returns policy_denied." in text


# -- web tools --------------------------------------------------------------------------


def _no_lookup(*_a, **_k):
    raise AssertionError("the name must not be looked up here")


def test_inside_a_name_goes_to_the_proxy_without_a_lookup(in_openshell, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", _no_lookup)
    assert guard._vet("https://example.org/page") == (None, None)

    class Client:
        def __init__(self) -> None:
            self.asked: list[str] = []

        def get(self, url, **kwargs):
            self.asked.append(url)
            assert not kwargs  # no pinned address, no Host override: the name as written
            return type("R", (), {"status_code": 200, "extensions": {}})()

    client = Client()
    resp = guard.get_checked(client, "https://example.org/page")
    assert client.asked == ["https://example.org/page"]
    assert resp.extensions["logical_url"] == "https://example.org/page"


def test_inside_a_literal_internal_address_is_still_refused(in_openshell, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", _no_lookup)
    for url in ("http://169.254.169.254/latest/meta-data/", "https://127.0.0.1:8443/", "https://10.0.0.5/"):
        reason, pin = guard._vet(url)
        assert reason and "refusing to fetch" in reason and pin is None


def test_inside_without_a_proxy_for_the_scheme_the_name_is_still_vetted(in_openshell, monkeypatch: pytest.MonkeyPatch) -> None:
    # Only HTTPS_PROXY is set: a plain http request would connect directly, so it is checked.
    looked_up: list[str] = []

    def lookup(host, *_a, **_k):
        looked_up.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]

    monkeypatch.setattr(socket, "getaddrinfo", lookup)
    reason, _pin = guard._vet("http://rebind.example.org/")
    assert looked_up == ["rebind.example.org"] and reason and "refusing to fetch" in reason


def test_outside_a_name_is_looked_up_and_pinned_as_before(outside, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")  # a proxy alone changes nothing
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
    assert guard._vet("https://example.org/") == (None, "93.184.216.34")
