"""OpenWorker running INSIDE an OpenShell sandbox (`openshell sandbox create -- openworker run …`).

Not a mode: OpenShell is the wall, and OpenWorker's own sandbox is off, as it is on any
computer that has not turned one on. OpenShell says it is there with `OPENSHELL_SANDBOX=1`,
and three things follow from that, all here:

- the agent is told what a blocked request looks like and what to do about it;
- OpenShell's own skills folder is readable, so the agent can follow OpenShell's policy
  skill as OpenShell prescribes (it exists only when the user turned proposals on);
- the web tools leave names to OpenShell's network layer (web/guard.py): what a name
  resolves to inside the sandbox is not its real address.

Sites are added from outside the sandbox with OpenShell's own commands. OpenWorker does not
grant them, so `request_network_access` and the allowed-sites card are not part of this.
"""

from __future__ import annotations

import os
from pathlib import Path

# Where OpenShell writes its agent-facing skills. The policy skill appears when the
# sandbox's `agent_policy_proposals_enabled` setting is on, and can appear mid-session.
SKILLS_DIR = Path("/etc/openshell/skills")
POLICY_SKILL = "openshell-policy-advisor"
_POLICY_SKILL_FILE = Path("policy-advisor") / "SKILL.md"


def inside_openshell() -> bool:
    return os.environ.get("OPENSHELL_SANDBOX", "").strip() == "1"


def policy_skill_present() -> bool:
    try:
        return (SKILLS_DIR / _POLICY_SKILL_FILE).is_file()
    except OSError:
        return False


def context() -> str:
    """The lines the agent reads each turn. Empty outside OpenShell."""
    if not inside_openshell():
        return ""
    lines = [
        "This session runs inside an OpenShell sandbox. Every network request, from your "
        "commands and your web tools alike, is held to its policy, which allows only what "
        "it lists. A request the policy does not allow fails in one of these ways: the "
        "connection is refused at once (`curl: (7) Failed to connect ... Couldn't connect "
        "to server`), a proxy answers 403 (`CONNECT tunnel failed, response 403`), or the "
        "reply says `policy_denied`. That means the sandbox blocked it. Do not retry it "
        "unchanged, and do not look for another route to the same place."
    ]
    if policy_skill_present():
        lines.append(
            f"If the task needs a blocked request, load the skill `{POLICY_SKILL}` and follow "
            "it: it explains how to ask for the access, which a person outside the sandbox "
            "approves."
        )
    else:
        lines.append(
            "If the task needs a blocked request, tell the user which host and port were "
            "blocked. They can allow it from outside the sandbox with "
            "`openshell policy update --add-endpoint HOST:PORT`."
        )
    return " ".join(lines)
