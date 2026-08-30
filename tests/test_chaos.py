"""Failure injection. These kill real containers and assert the system recovers.

Marked slow because they restart services; run with `make test-chaos`.
"""
import subprocess, time, requests, pytest, os
from conftest import WO, PAY, auth, login, tech_email, wait_for, psql

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pytestmark = pytest.mark.chaos


def compose(*args, timeout=180):
    return subprocess.run(["docker", "compose", *args], cwd=ROOT,
                          capture_output=True, text=True, timeout=timeout)


def wait_healthy(url, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if requests.get(f"{url}/health", timeout=3).ok:
                return True
        except Exception:
            pass
        time.sleep(2)
    raise AssertionError(f"{url} never came back")


def escrow_total():
    return int(psql("payments", """SELECT COALESCE(SUM(CASE WHEN e.direction='credit'
        THEN e.amount ELSE -e.amount END),0) FROM accounts a JOIN ledger_entries e
        ON e.account_id=a.id WHERE a.code='escrow'""") or 0)


def test_dispatch_succeeds_while_payments_is_down(clean_state, hirer_token, open_work_order):
    """The core promise of event-driven decoupling.

    Payments being dead must not stop a hirer dispatching work. The event waits
    durably in the queue and is processed when payments returns -- which is also
    a proof that the queue is durable and the message persistent.
    """
    wo, techs = open_work_order
    compose("stop", "payments")
    try:
        r = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                          json={"work_order_id": wo, "technician_id": techs[0]}, timeout=20)
        assert r.status_code == 201, "dispatch must not depend on payments being up"
        time.sleep(3)
        assert escrow_total() == 0, "no hold expected while payments is down"
    finally:
        compose("start", "payments")
        wait_healthy(PAY)

    # The queued event is picked up on reconnect.
    wait_for(lambda: escrow_total() > 0, timeout=45, what="hold placed after recovery")


def test_no_message_loss_when_a_consumer_is_killed_mid_flight(clean_state, hirer_token,
                                                              open_work_order):
    """Manual acks mean an unacked message returns to the queue on crash."""
    wo, techs = open_work_order
    requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                  json={"work_order_id": wo, "technician_id": techs[0]}, timeout=20)

    cid = subprocess.run(["docker", "ps", "--filter", "name=fieldnation-match-payments",
                          "--format", "{{.ID}}"], capture_output=True, text=True).stdout.split()
    if cid:
        subprocess.run(["docker", "kill", cid[0]], capture_output=True)
    compose("up", "-d", "payments")
    wait_healthy(PAY)

    # Whatever was in flight is redelivered; the hold still lands exactly once.
    wait_for(lambda: escrow_total() > 0, timeout=60, what="hold survives a consumer kill")
    n = int(psql("payments", f"SELECT count(*) FROM holds WHERE work_order_id={wo}") or 0)
    assert n == 1, f"expected exactly one hold after redelivery, got {n}"


def test_broker_restart_preserves_durable_messages(clean_state, hirer_token, open_work_order):
    """Durable queues plus persistent messages must survive a broker restart."""
    wo, techs = open_work_order
    compose("stop", "payments")
    requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                  json={"work_order_id": wo, "technician_id": techs[0]}, timeout=20)
    time.sleep(3)

    before = subprocess.run(
        ["docker", "exec", "fieldnation-match-rabbitmq-1", "rabbitmqctl", "-q",
         "list_queues", "name", "messages"], capture_output=True, text=True).stdout
    depth_before = sum(int(l.split()[1]) for l in before.splitlines()
                       if l.startswith("q.payments.workorder.dispatched"))
    assert depth_before > 0, "expected a queued event before the restart"

    compose("restart", "rabbitmq", timeout=240)
    time.sleep(25)

    after = subprocess.run(
        ["docker", "exec", "fieldnation-match-rabbitmq-1", "rabbitmqctl", "-q",
         "list_queues", "name", "messages"], capture_output=True, text=True).stdout
    depth_after = sum(int(l.split()[1]) for l in after.splitlines()
                      if l.startswith("q.payments.workorder.dispatched"))
    assert depth_after >= depth_before, "durable messages were lost across a broker restart"

    compose("start", "payments")
    wait_healthy(PAY)
    wait_for(lambda: escrow_total() > 0, timeout=60, what="event processed after broker restart")
