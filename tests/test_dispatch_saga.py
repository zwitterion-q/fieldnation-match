"""End-to-end dispatch saga against the live stack."""
import time, requests, pytest
from conftest import (WO, PAY, MATCH, auth, login, tech_email, wait_for, psql)


def escrow_total():
    v = psql("payments", """SELECT COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount
             ELSE -e.amount END),0) FROM accounts a JOIN ledger_entries e ON e.account_id=a.id
             WHERE a.code='escrow'""")
    return int(v or 0)


def holds_for(wo):
    v = psql("payments", f"SELECT count(*) FROM holds WHERE work_order_id={wo}")
    return int(v or 0)


def test_dispatch_places_hold(clean_state, hirer_token, open_work_order):
    wo, techs = open_work_order
    assert escrow_total() == 0

    r = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                      json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15)
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "dispatched"

    # The hold arrives asynchronously -- payments learns by consuming an event.
    wait_for(lambda: escrow_total() > 0, what="escrow hold")
    assert holds_for(wo) == 1


def test_reject_releases_hold_and_reopens_work_order(clean_state, hirer_token, open_work_order):
    wo, techs = open_work_order
    a = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                      json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15).json()
    wait_for(lambda: escrow_total() > 0, what="hold placed")

    tt = login(tech_email(techs[0]))
    r = requests.post(f"{WO}/assignments/{a['id']}/reject", headers=auth(tt),
                      json={"reason": "already booked"}, timeout=15)
    assert r.status_code == 200
    assert r.json()["status"] == "rejected"

    wait_for(lambda: escrow_total() == 0, what="hold released")
    assert psql("workorders", f"SELECT status FROM work_orders WHERE work_order_id={wo}") == "open"


def test_full_lifecycle_to_capture(clean_state, hirer_token, open_work_order):
    wo, techs = open_work_order
    a = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                      json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15).json()
    tt = login(tech_email(techs[0]))
    requests.post(f"{WO}/assignments/{a['id']}/accept", headers=auth(tt), timeout=15)
    wait_for(lambda: escrow_total() > 0, what="hold confirmed")

    requests.post(f"{WO}/assignments/{a['id']}/submit", headers=auth(tt),
                  json={"hours_worked": 4, "note": "done"}, timeout=15)
    r = requests.post(f"{WO}/assignments/{a['id']}/approve", headers=auth(hirer_token), timeout=15)
    assert r.json()["status"] == "completed"

    wait_for(lambda: escrow_total() == 0, what="escrow captured")

    payable = int(psql("payments", f"""SELECT COALESCE(SUM(CASE WHEN e.direction='credit'
        THEN e.amount ELSE -e.amount END),0) FROM accounts a JOIN ledger_entries e
        ON e.account_id=a.id WHERE a.code='technician_payable' AND a.owner_id={techs[0]}""") or 0)
    revenue = int(psql("payments", """SELECT COALESCE(SUM(CASE WHEN e.direction='credit'
        THEN e.amount ELSE -e.amount END),0) FROM accounts a JOIN ledger_entries e
        ON e.account_id=a.id WHERE a.code='platform_revenue'""") or 0)

    assert payable > 0 and revenue > 0
    # 15% platform fee, integer arithmetic, nothing lost to rounding
    assert abs(revenue / (payable + revenue) - 0.15) < 0.001


def test_ledger_always_balances(clean_state, hirer_token, admin_token, open_work_order):
    wo, techs = open_work_order
    a = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                      json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15).json()
    tt = login(tech_email(techs[0]))
    requests.post(f"{WO}/assignments/{a['id']}/accept", headers=auth(tt), timeout=15)
    requests.post(f"{WO}/assignments/{a['id']}/submit", headers=auth(tt), json={}, timeout=15)
    requests.post(f"{WO}/assignments/{a['id']}/approve", headers=auth(hirer_token), timeout=15)
    time.sleep(4)

    tb = requests.get(f"{PAY}/ledger/trial-balance", headers=auth(admin_token), timeout=15).json()
    assert tb["balanced"] is True, tb
    assert tb["debits"] == tb["credits"]
