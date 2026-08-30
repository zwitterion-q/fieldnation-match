"""Shared fixtures. These run against the LIVE stack rather than mocks -- the
bugs this suite exists to catch were all integration bugs, and none of them
would have been caught by a unit test with a stubbed broker."""
import os, subprocess, time, json
import pytest, requests

# Everything goes through the gateway. Direct host ports are deliberately not
# used: services that can scale publish PORT RANGES, so which host port a
# container lands on is not stable across a restart. The gateway resolves by
# service name and is the same path the browser uses.
GW      = os.getenv("GATEWAY", "http://localhost:55173")
IDENTITY= f"{GW}/id"
WO      = f"{GW}/wo"
PAY     = f"{GW}/pay"
MATCH   = f"{GW}/api"
RMQ     = os.getenv("RMQ",      "http://localhost:45672")
PASSWORD= "Passw0rd!"


def psql(db, sql):
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", f"db-{db}", "psql", "-U", "fn", "-d", db, "-tAc", sql],
        capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(__file__)))
    return out.stdout.strip()


def login(email, password=PASSWORD):
    r = requests.post(f"{IDENTITY}/auth/login", json={"email": email, "password": password}, timeout=10)
    r.raise_for_status()
    return r.json()["access_token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def tech_email(technician_id):
    return psql("identity",
        f"SELECT email FROM users WHERE subject_type='technician' AND subject_id={technician_id}")


def wait_for(fn, timeout=25, interval=0.5, what="condition"):
    """Event-driven systems are eventually consistent by construction; polling
    for a settled state is the correct way to assert on them."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {what} (last={last})")


@pytest.fixture(scope="session")
def hirer_token():
    return login("hirer@northwind.retail.group.test")


@pytest.fixture(scope="session")
def admin_token():
    return login("admin@fieldnation.test")


@pytest.fixture(scope="session")
def finance_token():
    return login("finance@fieldnation.test")


@pytest.fixture
def clean_state():
    """Reset transactional state between tests, leaving work orders and accounts."""
    root = os.path.dirname(os.path.dirname(__file__))
    subprocess.run(["make", "demo"], cwd=root, capture_output=True, timeout=180)
    time.sleep(1)
    yield


@pytest.fixture
def open_work_order():
    items = requests.get(f"{MATCH}/work-orders?limit=1", timeout=10).json()["items"]
    assert items, "no open work orders — run 'make ingest'"
    wo = items[0]["work_order_id"]
    matches = requests.get(f"{MATCH}/work-orders/{wo}/matches?limit=3", timeout=30).json()["matches"]
    assert len(matches) >= 2, "need at least two candidate technicians"
    return wo, [m["technician_id"] for m in matches]
