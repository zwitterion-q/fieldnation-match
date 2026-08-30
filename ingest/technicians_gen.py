"""Mock Field Nation technicians.

Profiles are assembled FROM the same taxonomy the work orders resolve against,
so both sides of the marketplace are described in one vocabulary. That is what
makes a single shared embedding space meaningful: a technician vector and a
work-order vector are comparable because they were built from the same features
with the same weights.
"""
from __future__ import annotations
import random
from dataclasses import dataclass, field

random.seed(99)

FIRST = ["Marcus","Dana","Luis","Priya","Tom","Alicia","Jamal","Nguyen","Katie","Rafael",
         "Simone","Dale","Yusuf","Erin","Brett","Camila","Otis","Nadia","Hank","Rosa",
         "Ivan","Trisha","Cole","Meera","Doug","Shanice","Pete","Lina","Walt","Farah"]
LAST  = ["Ortega","Whitfield","Barnes","Nakamura","Delgado","Okafor","Sundberg","Reyes",
         "Kowalski","Mbeki","Lindqvist","Ferraro","Achebe","Novak","Cardenas","Hoang",
         "Brennan","Silva","Dawson","Petrov","Quinn","Osei","Vargas","Lindberg"]

CLUSTERS = {
  "network": ["Structured Cabling","Fiber Optic Splicing","Network Configuration",
              "WiFi Site Survey","Cable Termination & Testing","Server & Rack Installation"],
  "retail_pos": ["POS Installation","Self-Checkout Systems","Kiosk Installation",
                 "Cash Handling Equipment","Scales & Calibration","Digital Signage"],
  "security_av": ["CCTV & Surveillance","Access Control Systems","Audio Visual Installation",
                  "Digital Signage","Low Voltage Systems","Mounting & Rigging"],
  "electrical": ["Electrical Work","EV Charger Installation","Low Voltage Systems",
                 "Mounting & Rigging","Structured Cabling"],
  "mechanical": ["HVAC Service","Commercial Appliance Repair","Diagnostics & Troubleshooting",
                 "Scales & Calibration"],
  "it_breakfix": ["Desktop Break-Fix","Printer & MFP Service","ATM Servicing",
                  "Diagnostics & Troubleshooting","Telecom & VoIP","Drive-Thru Systems"],
}
EXPERIENCES = ["Multi-Site Retail Rollouts","Enterprise Networking","Data Centre Operations",
               "Commercial Construction Sites","Healthcare Facilities","Restaurant & QSR Environments",
               "Warehouse & Logistics","Dispatch-Based Field Service","Customer-Facing Site Work",
               "After-Hours & Overnight Work"]
INDUSTRIES = ["Retail","Restaurant & Hospitality","Healthcare","Banking & Financial Services",
              "Telecommunications","Manufacturing & Industrial","Logistics & Warehousing",
              "Education","Government & Public Sector","Energy & Utilities"]
WORKTYPES  = ["New Installation","Rollout & Deployment","Break-Fix Repair",
              "Preventive Maintenance","Site Survey & Audit","De-Installation & Decommission",
              "Staging & Configuration","Upgrade & Migration"]
CERTS      = ["CompTIA A+","CompTIA Network+","BICSI Certified","OSHA 10","OSHA 30",
              "Low Voltage License","EPA 608","Fiber Optic Certification","Cisco CCNA",
              "Electrical License"]
LEVELS     = [("Entry Level",(0.5,2.5)),("Intermediate",(2.5,6)),
              ("Senior",(6,14)),("Lead / Master",(12,25))]

from sources.synthetic import METROS


@dataclass
class Technician:
    external_id: str
    full_name: str
    headline: str
    bio: str
    city: str; state: str
    latitude: float; longitude: float
    travel_radius_mi: int
    hourly_rate: float
    rating: float
    jobs_completed: int
    years_experience: float
    level: str
    skills: list = field(default_factory=list)
    experiences: list = field(default_factory=list)
    industries: list = field(default_factory=list)
    work_types: list = field(default_factory=list)
    certifications: list = field(default_factory=list)

    def features(self) -> list[tuple[str, str]]:
        """Same feature contract as a work order -- this is what makes the two
        centroids live in one comparable space."""
        f = [("title", self.headline)]
        f += [("skill", s) for s in self.skills]
        f += [("experience", e) for e in self.experiences]
        f += [("industry", i) for i in self.industries]
        f += [("experience_type", w) for w in self.work_types]
        f += [("experience_level", self.level)]
        f += [("certification", c) for c in self.certifications]
        f += [("body", self.bio[:600])]
        return f


def generate(count: int = 60) -> list[Technician]:
    out = []
    for i in range(count):
        cluster = random.choice(list(CLUSTERS))
        pool    = CLUSTERS[cluster]
        skills  = random.sample(pool, k=min(len(pool), random.randint(3, 5)))
        # A minority carry a skill from outside their cluster -- real technicians
        # are not tidy, and it keeps the vector space from separating too neatly.
        if random.random() < 0.3:
            other = random.choice([c for c in CLUSTERS if c != cluster])
            skills.append(random.choice(CLUSTERS[other]))

        level, yr_band = random.choice(LEVELS)
        years = round(random.uniform(*yr_band), 1)
        city, state, lat, lon = random.choice(METROS)
        name = f"{random.choice(FIRST)} {random.choice(LAST)}"
        wtypes = random.sample(WORKTYPES, k=random.randint(2, 4))
        inds   = random.sample(INDUSTRIES, k=random.randint(1, 3))
        exps   = random.sample(EXPERIENCES, k=random.randint(2, 4))
        certs  = random.sample(CERTS, k=random.randint(0, 3))

        headline = f"{level.split(' /')[0]} Field Technician — {skills[0]}"
        bio = (f"{name} is a {level.lower()} field service technician based in {city}, {state}, "
               f"with {years} years on site. Core work: {', '.join(skills[:3])}. "
               f"Regularly takes {', '.join(w.lower() for w in wtypes[:2])} work across "
               f"{', '.join(inds).lower()} sites. "
               + (f"Holds {', '.join(certs)}. " if certs else "")
               + f"Travels up to {random.choice([25,40,50,75,100])} miles from base.")

        out.append(Technician(
            external_id=f"tech-{i:04d}", full_name=name, headline=headline, bio=bio,
            city=city, state=state, latitude=lat, longitude=lon,
            travel_radius_mi=random.choice([25, 40, 50, 75, 100]),
            hourly_rate=round(random.uniform(32, 105), 2),
            rating=round(random.uniform(3.4, 5.0), 2),
            jobs_completed=random.randint(3, 480),
            years_experience=years, level=level,
            skills=skills, experiences=exps, industries=inds,
            work_types=wtypes, certifications=certs,
        ))
    return out
