"""Regression tests for bugs that actually happened.

Each of these failed once in this system. A test that never failed is a guess;
these are the ones that earn their runtime.
"""
import concurrent.futures as cf
import time, requests, pytest
from conftest import WO, PAY, IDENTITY, auth, login, tech_email, wait_for, psql


def holds_for(wo):
    return int(psql("payments", f"SELECT count(*) FROM holds WHERE work_order_id={wo}") or 0)


def escrow_total():
    return int(psql("payments", """SELECT COALESCE(SUM(CASE WHEN e.direction='credit'
        THEN e.amount ELSE -e.amount END),0) FROM accounts a JOIN ledger_entries e
        ON e.account_id=a.id WHERE a.code='escrow'""") or 0)


def test_concurrent_reject_and_redispatch_creates_exactly_one_live_hold(
        clean_state, hirer_token, open_work_order):
    """REGRESSION — the $1,183-for-a-$591-job bug.

    One queue per event type means RabbitMQ delivers them concurrently, so a
    rejection and a re-dispatch can be handled at the same instant. Both
    handlers used to check "is there an existing hold?", both saw none, and both
    created one.

    The fix was a modelling change, not a lock: holds are keyed on assignment_id
    with a unique constraint. This test fires the events with no delay to make
    the race as likely as possible.
    """
    wo, techs = open_work_order
    a1 = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                       json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15).json()
    t1 = login(tech_email(techs[0]))

    # No sleep anywhere: reject and re-dispatch back to back.
    requests.post(f"{WO}/assignments/{a1['id']}/reject", headers=auth(t1),
                  json={"reason": "race"}, timeout=15)
    a2 = requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                       json={"work_order_id": wo, "technician_id": techs[1]}, timeout=15).json()

    wait_for(lambda: holds_for(wo) >= 2, what="both holds recorded")
    time.sleep(6)   # let every consumer settle

    states = psql("payments",
        f"SELECT assignment_id||':'||state FROM holds WHERE work_order_id={wo} ORDER BY id")
    rows = [r for r in states.split("\n") if r]

    # One hold per assignment -- never two for the same one.
    assert len(rows) == 2, rows
    assert len({r.split(":")[0] for r in rows}) == 2, f"duplicate hold per assignment: {rows}"

    # Exactly one live reservation: the rejected one released, the new one open.
    live = [r for r in rows if r.split(":")[1] in ("placed", "confirmed")]
    assert len(live) == 1, f"expected one live hold, got {rows}"


def test_unique_constraint_blocks_duplicate_hold_at_the_database(clean_state):
    """The guarantee is in the schema, not in application logic."""
    idx = psql("payments", """SELECT indexdef FROM pg_indexes
                              WHERE tablename='holds' AND indexdef LIKE '%UNIQUE%'
                              AND indexdef LIKE '%assignment_id%'""")
    assert "assignment_id" in idx, "the unique index that makes the race impossible is missing"


def test_parallel_dispatches_do_not_double_book_a_work_order(clean_state, hirer_token,
                                                             open_work_order):
    """Two dispatchers hitting the same open work order at the same moment.

    The service takes a row lock (SELECT ... FOR UPDATE) so they serialise:
    exactly one succeeds, the other is told the work order is no longer open.
    """
    wo, techs = open_work_order

    def dispatch(tech):
        return requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                             json={"work_order_id": wo, "technician_id": tech}, timeout=20)

    with cf.ThreadPoolExecutor(max_workers=2) as ex:
        r1, r2 = [f.result() for f in [ex.submit(dispatch, techs[0]), ex.submit(dispatch, techs[1])]]

    codes = sorted([r1.status_code, r2.status_code])
    assert codes == [201, 400], f"expected one success and one rejection, got {codes}"


def test_idempotent_consumers_have_a_dedup_table(clean_state):
    """At-least-once delivery makes duplicates routine, so every consuming
    service must keep an idempotency ledger."""
    for db in ("workorders", "payments"):
        n = psql(db, "SELECT count(*) FROM information_schema.tables "
                     "WHERE table_name='processed_messages'")
        assert n == "1", f"{db} has no processed_messages table"


def test_outbox_drains_completely(clean_state, hirer_token, open_work_order):
    """Every outbox row must end up published. A row stuck unpublished is an
    event that silently never happened."""
    wo, techs = open_work_order
    requests.post(f"{WO}/assignments", headers=auth(hirer_token),
                  json={"work_order_id": wo, "technician_id": techs[0]}, timeout=15)
    wait_for(lambda: psql("workorders",
             "SELECT count(*) FROM outbox WHERE published_at IS NULL") == "0",
             what="outbox drained")
