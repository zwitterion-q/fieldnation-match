"""The enrichment pass: unstructured work-order text in, structured features out.

Mirrors the CareerOne design deliberately -- the description is the only field
left unstructured; everything else becomes a typed feature that will be resolved
to a canonical taxonomy id.

Two interchangeable implementations behind one interface:
  * LLMExtractor   -- schema-constrained JSON via the OpenAI API (if a key exists)
  * RuleExtractor  -- deterministic alias/keyword matching, always available

Same output contract either way, so the pipeline never branches and the demo
runs with no API key at all.
"""
from __future__ import annotations
import os, json, re
from dataclasses import dataclass, field, asdict


@dataclass
class ExtractedFeatures:
    title: str
    body: str
    skills: list[str] = field(default_factory=list)
    experiences: list[str] = field(default_factory=list)
    experience_level: str | None = None
    industry: str | None = None
    experience_types: list[str] = field(default_factory=list)
    certifications: list[str] = field(default_factory=list)
    extractor: str = "rule"

    def as_pairs(self) -> list[tuple[str, str]]:
        """Flatten to (attribute_type, raw_phrase) for taxonomy resolution."""
        pairs = [("skill", s) for s in self.skills]
        pairs += [("experience", e) for e in self.experiences]
        pairs += [("experience_type", t) for t in self.experience_types]
        pairs += [("certification", c) for c in self.certifications]
        if self.experience_level:
            pairs.append(("experience_level", self.experience_level))
        if self.industry:
            pairs.append(("industry", self.industry))
        return pairs

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=1)


LEVEL_HINTS = [
    (r"\b(lead|master|foreman|supervisor|crew lead)\b", "lead"),
    (r"\b(senior|sr\.?|5\+ years|expert|advanced)\b",   "senior"),
    (r"\b(junior|entry|apprentice|trainee|helper|0-2 years)\b", "entry"),
    (r"\b(intermediate|mid.level|journeyman|2-5 years)\b", "intermediate"),
]
TYPE_HINTS = [
    (r"\b(de-?install|removal|decommission|teardown)\b", "de-installation"),
    (r"\b(preventive|scheduled maintenance|pm visit|routine service)\b", "preventive maintenance"),
    (r"\b(survey|site walk|audit|assessment)\b",        "site survey and audit"),
    (r"\b(stage|staging|imaging|provision|depot)\b",    "staging and configuration"),
    (r"\b(roll ?out|deployment|refresh project|mass deploy)\b", "rollout and deployment"),
    (r"\b(upgrade|migrat|swap out|replace)\b",          "upgrade and migration"),
    (r"\b(repair|break.?fix|troubleshoot|diagnos|fault|service call)\b", "break-fix repair"),
    (r"\b(install|mount|terminate|commission)\b",       "new installation"),
]


class RuleExtractor:
    """Deterministic. Uses the alias table as its vocabulary, so extraction
    quality improves whenever the taxonomy is extended -- no retraining."""
    name = "rule"

    def __init__(self, alias_index: dict[str, list[tuple[int, str, str]]]):
        # alias phrase -> [(attribute_id, attribute_type, canonical_name)]
        self.alias_index = alias_index
        self._alias_re = sorted(alias_index.keys(), key=len, reverse=True)

    def extract(self, title: str, body_clean: str) -> ExtractedFeatures:
        blob = f"{title}. {body_clean}".lower()
        found: dict[str, list[str]] = {}
        for phrase in self._alias_re:
            if len(phrase) < 3:
                continue
            if re.search(rf"(?<![a-z]){re.escape(phrase)}(?![a-z])", blob):
                for _aid, atype, canon in self.alias_index[phrase]:
                    found.setdefault(atype, [])
                    if canon not in found[atype]:
                        found[atype].append(canon)

        level = next((lab for pat, lab in LEVEL_HINTS if re.search(pat, blob)), None)
        if not level and found.get("experience_level"):
            level = found["experience_level"][0]

        types = [lab for pat, lab in TYPE_HINTS if re.search(pat, blob)]
        types = (found.get("experience_type", []) + types)[:3]

        industry = (found.get("industry") or [None])[0]

        return ExtractedFeatures(
            title=title.strip(),
            body=body_clean[:4000],
            skills=found.get("skill", [])[:10],
            experiences=found.get("experience", [])[:5],
            experience_level=level,
            industry=industry,
            experience_types=list(dict.fromkeys(types))[:3],
            certifications=found.get("certification", [])[:4],
            extractor="rule",
        )


SCHEMA_PROMPT = """You convert a field-service work order into structured JSON.
Return ONLY JSON matching exactly this shape:
{"skills":[str],"experiences":[str],"experience_level":str|null,
 "industry":str|null,"experience_types":[str],"certifications":[str]}
Rules: short canonical noun phrases; no sentences; omit anything not clearly
present; experience_level must be one of entry, intermediate, senior, lead."""


class LLMExtractor:
    """Schema-constrained extraction. Falls back to the rule extractor on any
    error, so a rate limit or outage degrades quality rather than breaking the
    pipeline."""
    name = "llm"

    def __init__(self, fallback: RuleExtractor, model: str = "gpt-4o-mini"):
        from openai import OpenAI
        self.client, self.model, self.fallback = OpenAI(), model, fallback

    def extract(self, title: str, body_clean: str) -> ExtractedFeatures:
        try:
            r = self.client.chat.completions.create(
                model=self.model, temperature=0,
                response_format={"type": "json_object"},
                messages=[{"role": "system", "content": SCHEMA_PROMPT},
                          {"role": "user",
                           "content": f"TITLE: {title}\n\nBODY:\n{body_clean[:3500]}"}],
            )
            d = json.loads(r.choices[0].message.content)
            return ExtractedFeatures(
                title=title.strip(), body=body_clean[:4000],
                skills=d.get("skills", [])[:10],
                experiences=d.get("experiences", [])[:5],
                experience_level=d.get("experience_level"),
                industry=d.get("industry"),
                experience_types=d.get("experience_types", [])[:3],
                certifications=d.get("certifications", [])[:4],
                extractor="llm",
            )
        except Exception as e:
            print(f"  [llm] falling back to rules: {e}")
            return self.fallback.extract(title, body_clean)


def build_extractor(alias_index) -> RuleExtractor | LLMExtractor:
    rules = RuleExtractor(alias_index)
    if os.getenv("OPENAI_API_KEY"):
        try:
            return LLMExtractor(rules)
        except Exception as e:
            print(f"  [llm] unavailable ({e}); using rule extractor")
    return rules
