"""Proof that the strangler migration is safe.

A toggle that flips traffic is not evidence. What makes a migration defensible
is a suite that proves the two implementations agree, that routing is stable,
and that rollback actually works. That is what this file is.
"""
import requests, pytest
from conftest import GW, WO, MATCH, auth, login

STR = f"{WO}/strangler"


def set_mode(admin, **cfg):
    r = requests.post(f"{STR}/config", headers=auth(admin), json=cfg, timeout=15)
    assert r.status_code in (200, 201), r.text
    return r.json()


def served_by(wo_id):
    r = requests.get(f"{STR}/work-orders/{wo_id}", timeout=20)
    return r.headers.get("x-served-by"), r


@pytest.fixture
def sample_ids():
    items = requests.get(f"{MATCH}/work-orders?limit=25", timeout=20).json()["items"]
    return [i["work_order_id"] for i in items]


@pytest.fixture(autouse=True)
def restore_shadow(admin_token):
    yield
    set_mode(admin_token, mode="shadow")


def test_both_implementations_return_identical_data(admin_token, sample_ids):
    """The equivalence proof. Every field a caller depends on must match."""
    set_mode(admin_token, mode="legacy")
    legacy = {i: requests.get(f"{STR}/work-orders/{i}", timeout=20).json() for i in sample_ids}

    set_mode(admin_token, mode="new")
    new = {i: requests.get(f"{STR}/work-orders/{i}", timeout=20).json() for i in sample_ids}

    fields = ["work_order_id", "title", "company", "city", "state", "status", "source_type"]
    for i in sample_ids:
        for f in fields:
            assert str(legacy[i].get(f)) == str(new[i].get(f)), \
                f"work order {i} field {f}: legacy={legacy[i].get(f)} new={new[i].get(f)}"

        # Resolved taxonomy ids must match exactly -- this is the payload the
        # matching engine and both frontends actually depend on.
        la = sorted(a["id"] for a in legacy[i].get("attributes", []))
        na = sorted(a["id"] for a in new[i].get("attributes", []))
        assert la == na, f"work order {i} attributes diverge: {la} vs {na}"


def test_shadow_mode_serves_legacy_and_reports_zero_divergence(admin_token, sample_ids):
    """Shadow is the stage that earns the right to shift traffic."""
    set_mode(admin_token, mode="shadow")
    before = requests.get(f"{STR}/status", timeout=15).json()["stats"]["shadow_compared"]

    for i in sample_ids:
        who, r = served_by(i)
        assert who == "legacy-api", "shadow must never serve the new implementation"
        assert r.headers.get("x-shadow") == "on"

    import time; time.sleep(2)
    st = requests.get(f"{STR}/status", timeout=15).json()
    compared = st["stats"]["shadow_compared"] - before
    assert compared >= len(sample_ids), f"expected {len(sample_ids)} comparisons, got {compared}"
    assert st["stats"]["shadow_diverged"] == 0, st["stats"]["divergences"][:3]


def test_routing_is_deterministic_per_entity(admin_token, sample_ids):
    """A work order must not flip implementations between refreshes -- a user
    seeing two different answers is worse than a user seeing the old one."""
    set_mode(admin_token, mode="canary", canary_percent=50)
    for i in sample_ids[:8]:
        decisions = {served_by(i)[0] for _ in range(4)}
        assert len(decisions) == 1, f"work order {i} flipped between implementations: {decisions}"


def test_canary_percentage_is_honoured(admin_token, sample_ids):
    set_mode(admin_token, mode="canary", canary_percent=0)
    assert all(served_by(i)[0] == "legacy-api" for i in sample_ids)

    set_mode(admin_token, mode="canary", canary_percent=100)
    assert all(served_by(i)[0] == "work-orders" for i in sample_ids)


def test_rollback_is_immediate_and_needs_no_deploy(admin_token, sample_ids):
    """The property that makes a migration safe to attempt at all."""
    set_mode(admin_token, mode="new")
    assert served_by(sample_ids[0])[0] == "work-orders"

    set_mode(admin_token, mode="legacy")
    assert served_by(sample_ids[0])[0] == "legacy-api", "rollback must be instant"


def test_only_an_admin_can_move_the_migration(hirer_token):
    r = requests.post(f"{STR}/config", headers=auth(hirer_token),
                      json={"mode": "new"}, timeout=15)
    assert r.status_code == 403, "shifting production traffic must be privileged"
