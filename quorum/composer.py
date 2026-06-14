"""Compose the three-valued verdict from the Gauntlet-Agent layer and the
deterministic checks layer."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

from quorum.checks import CheckRecord

FinalStatus = Literal["pass", "fail", "indeterminate"]
GauntletStatus = Literal["pass", "fail", "investigate", "errored"]
RunErrorStage = Literal[
    "setup",
    "gauntlet",
    "capture",
    "checks",
    "compose",
    "qa-agent-misconfigured",
    "unknown",
]
TRACE_PRIMITIVES = {
    "tool-called",
    "tool-not-called",
    "tool-count",
    "tool-before",
    "tool-arg-match",
    "tool-match-before-tool-match",
    "skill-called",
    "skill-not-called",
    "skill-before-tool",
    "skill-before-tool-match",
}


@dataclass(frozen=True)
class GauntletLayer:
    status: GauntletStatus
    summary: str = ""
    reasoning: str = ""
    run_id: str | None = None


@dataclass(frozen=True)
class RunError:
    stage: RunErrorStage
    message: str


@dataclass(frozen=True)
class FinalVerdict:
    schema: int = 1
    final: FinalStatus = "indeterminate"
    final_reason: str = ""
    gauntlet: GauntletLayer | None = None
    checks: list[CheckRecord] = field(default_factory=list)
    error: RunError | None = None
    economics: dict | None = None

    def to_dict(self) -> dict:
        d = {
            "schema": self.schema,
            "final": self.final,
            "final_reason": self.final_reason,
            "gauntlet": asdict(self.gauntlet) if self.gauntlet else None,
            "checks": [
                {
                    "check": c.check,
                    "args": c.args,
                    "negated": c.negated,
                    "passed": c.passed,
                    "detail": c.detail,
                    "phase": c.phase,
                }
                for c in self.checks
            ],
            "error": asdict(self.error) if self.error else None,
            "economics": self.economics,
        }
        return d


def _any_trace_check(checks: list[CheckRecord]) -> bool:
    return any(c.check in TRACE_PRIMITIVES for c in checks)


def compose(
    *,
    gauntlet: GauntletLayer | None,
    checks: list[CheckRecord],
    capture_empty: bool,
    error: RunError | None,
) -> FinalVerdict:
    # Crash path
    if error is not None:
        return FinalVerdict(
            final="indeterminate",
            final_reason=f"quorum error ({error.stage}): {error.message}",
            gauntlet=gauntlet,
            checks=checks,
            error=error,
        )
    # Pre-check failure
    failed_pre = [c for c in checks if c.phase == "pre" and not c.passed]
    if failed_pre:
        names = ", ".join(c.check for c in failed_pre)
        return FinalVerdict(
            final="indeterminate",
            final_reason=f"pre-check(s) failed: {names}",
            gauntlet=gauntlet,
            checks=checks,
            error=None,
        )
    # Gauntlet investigate/errored
    if gauntlet is None:
        return FinalVerdict(
            final="indeterminate",
            final_reason="no Gauntlet-Agent verdict",
            gauntlet=None,
            checks=checks,
            error=None,
        )
    if gauntlet.status in ("investigate", "errored"):
        return FinalVerdict(
            final="indeterminate",
            final_reason=f"Gauntlet-Agent did not complete (status: {gauntlet.status})",
            gauntlet=gauntlet,
            checks=checks,
            error=None,
        )
    # Empty trace with trace checks
    if capture_empty and _any_trace_check(checks):
        return FinalVerdict(
            final="indeterminate",
            final_reason="tool-call capture was empty; trace checks meaningless",
            gauntlet=gauntlet,
            checks=checks,
            error=None,
        )
    # Post-check evaluation
    failed_post = [c for c in checks if c.phase == "post" and not c.passed]
    if gauntlet.status == "pass" and not failed_post:
        n = sum(1 for c in checks if c.phase == "post")
        reason = (
            f"Gauntlet-Agent passed; {n} post-check(s) passed"
            if n
            else "Gauntlet-Agent passed; no deterministic checks"
        )
        return FinalVerdict(
            final="pass",
            final_reason=reason,
            gauntlet=gauntlet,
            checks=checks,
            error=None,
        )
    reason_bits: list[str] = []
    if gauntlet.status != "pass":
        reason_bits.append(f"Gauntlet-Agent reported {gauntlet.status}")
    if failed_post:
        reason_bits.append(f"{len(failed_post)} post-check(s) failed")
    return FinalVerdict(
        final="fail",
        final_reason="; ".join(reason_bits) or "fail",
        gauntlet=gauntlet,
        checks=checks,
        error=None,
    )
