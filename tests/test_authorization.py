"""RBAC and separation of duty, enforced by the services rather than the UI."""
import requests
from conftest import WO, PAY, auth, login, tech_email


def test_technician_cannot_approve_their_own_work(clean_state, hirer_token, open_work_order):
    """Separation of duty: the party doing the work does not release the money."""
    wo, techs = open_work_order
    a = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                      json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15).json()
    tt = login(tech_email(techs[0]))
    requests.post(f"{WO}/assignments/{a['id']}/accept", headers=auth(tt), timeout=15)
    requests.post(f"{WO}/assignments/{a['id']}/submit", headers=auth(tt), json={}, timeout=15)

    r = requests.post(f"{WO}/assignments/{a['id']}/approve", headers=auth(tt), timeout=15)
    assert r.status_code == 403
    assert "workorder:approve" in r.json()["message"]


def test_hirer_cannot_release_funds(clean_state, hirer_token):
    """A hirer approves work but cannot pay anyone."""
    r = requests.post(f"{PAY}/payouts", headers=auth(hirer_token),
                      json={"technician_id": 1}, timeout=15)
    assert r.status_code == 403
    assert "payment:release" in r.json()["message"]


def test_technician_cannot_pay_themselves(clean_state, open_work_order):
    wo, techs = open_work_order
    tt = login(tech_email(techs[0]))
    r = requests.post(f"{PAY}/payouts", headers=auth(tt),
                      json={"technician_id": techs[0]}, timeout=15)
    assert r.status_code == 403


def test_technician_cannot_act_on_another_technicians_offer(clean_state, hirer_token,
                                                            open_work_order):
    wo, techs = open_work_order
    a = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                      json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15).json()
    other = login(tech_email(techs[1]))
    r = requests.post(f"{WO}/assignments/{a['id']}/accept", headers=auth(other), timeout=15)
    assert r.status_code == 403
    assert "another technician" in r.json()["message"]


def test_illegal_state_transition_returns_409_not_500(clean_state, hirer_token, open_work_order):
    """A well-formed request against stale state is a conflict, not a crash --
    the distinction tells a client whether retrying is pointless."""
    wo, techs = open_work_order
    a = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                      json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15).json()
    tt = login(tech_email(techs[0]))
    requests.post(f"{WO}/assignments/{a['id']}/accept", headers=auth(tt), timeout=15)
    r = requests.post(f"{WO}/assignments/{a['id']}/accept", headers=auth(tt), timeout=15)
    assert r.status_code == 409
    assert "illegal transition" in r.json()["message"]


def test_missing_token_is_401_not_403(clean_state):
    """Authentication and authorisation fail differently."""
    r = requests.get(f"{WO}/assignments/mine", timeout=15)
    assert r.status_code == 401
