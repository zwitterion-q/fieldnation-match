"""HTML stripping and text normalisation. Runs before anything is hashed,
embedded or extracted -- markup noise otherwise leaks into both the dedup
hash and the vector, and two identical jobs wrapped in different templates
would look like different jobs."""
from __future__ import annotations
import re, hashlib, html as htmllib
from bs4 import BeautifulSoup

_WS       = re.compile(r"\s+")
_BULLET   = re.compile(r"^[\s•\-\*•]+", re.M)
_URL      = re.compile(r"https?://\S+")
_MULTINL  = re.compile(r"\n{3,}")


def strip_html(raw: str | None) -> str:
    if not raw or len(raw) < 20:
        return (raw or "").strip()
    soup = BeautifulSoup(raw, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    # Block elements become line breaks so list items do not run together.
    for tag in soup.find_all(["br", "p", "li", "div", "h1", "h2", "h3", "tr"]):
        tag.append("\n")
    text = soup.get_text(" ")
    text = htmllib.unescape(text)
    text = _URL.sub(" ", text)
    text = _BULLET.sub("", text)
    text = _WS.sub(" ", text).strip()
    return _MULTINL.sub("\n\n", text)


def normalise_text(s: str | None) -> str:
    """Aggressive form used only for hashing -- casing and punctuation removed
    so trivial edits do not defeat exact-duplicate detection."""
    if not s:
        return ""
    s = strip_html(s).lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return _WS.sub(" ", s).strip()


def content_hash(title: str, body: str) -> str:
    return hashlib.sha256(
        f"{normalise_text(title)}||{normalise_text(body)}".encode()
    ).hexdigest()
