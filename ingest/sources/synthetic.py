"""Field Nation-shaped work orders.

Two deliberate design choices:

1. Bodies are written as messy HTML with inline styles, entities and stray
   markup, because the cleaning layer should be doing real work rather than
   passing through already-clean text.
2. A controlled slice of the output is near-duplicate: the same job reworded,
   as it would appear if a buyer posted to two channels. Exact hashing cannot
   catch those; the vector dedup layer can, which makes the layer visible in
   the demo instead of theoretical.
"""
from __future__ import annotations
import random, hashlib
from . import RawJob

random.seed(4242)

METROS = [
    ("Minneapolis","MN",44.98,-93.27),("Saint Paul","MN",44.95,-93.09),
    ("Chicago","IL",41.88,-87.63),("Dallas","TX",32.78,-96.80),
    ("Houston","TX",29.76,-95.37),("Atlanta","GA",33.75,-84.39),
    ("Phoenix","AZ",33.45,-112.07),("Denver","CO",39.74,-104.99),
    ("Seattle","WA",47.61,-122.33),("Portland","OR",45.52,-122.68),
    ("Columbus","OH",39.96,-83.00),("Charlotte","NC",35.23,-80.84),
    ("Nashville","TN",36.16,-86.78),("Indianapolis","IN",39.77,-86.16),
    ("Kansas City","MO",39.10,-94.58),("Milwaukee","WI",43.04,-87.91),
    ("Detroit","MI",42.33,-83.05),("Philadelphia","PA",39.95,-75.17),
    ("Tampa","FL",27.95,-82.46),("Orlando","FL",28.54,-81.38),
    ("Las Vegas","NV",36.17,-115.14),("Salt Lake City","UT",40.76,-111.89),
    ("San Antonio","TX",29.42,-98.49),("Sacramento","CA",38.58,-121.49),
    ("St. Louis","MO",38.63,-90.20),("Raleigh","NC",35.78,-78.64),
    ("Omaha","NE",41.26,-95.93),("Boise","ID",43.62,-116.20),
    ("Richmond","VA",37.54,-77.44),("Albuquerque","NM",35.08,-106.65),
]

BUYERS = ["Northwind Retail Group","Cascade Restaurant Partners","Meridian Health Systems",
          "Blue Harbor Bank","Summit Telecom Services","Ironwood Manufacturing",
          "Trellis Logistics","Lakeside School District","Cardinal Convenience",
          "Vertex Hospitality","Beacon Grocery Co","Halston Pharmacy Group"]

# (title, skill blurb, work-type phrasing, industry phrasing, level, pay band, hours)
TEMPLATES = [
 ("POS Terminal Installation — {n} Lanes",
  "Install and configure {n} point of sale terminals, including cash drawer, receipt printer and payment pinpad. Cat6 drops already run.",
  "new installation", "retail store", "intermediate", (45,75), (4,8)),
 ("Self-Checkout Kiosk Deployment",
  "Deploy self checkout units, mount scanners, terminate network cabling and validate scan-and-go configuration with store systems.",
  "rollout and deployment", "supermarket", "intermediate", (50,85), (6,10)),
 ("Structured Cabling — Cat6A Runs",
  "Pull and terminate Cat6A cabling, punch down to patch panel, label and Fluke certify all runs. Ceiling and conduit work required.",
  "new installation", "commercial office", "intermediate", (48,80), (6,12)),
 ("Fiber Optic Splicing and Termination",
  "Fusion splice single-mode fiber, terminate at the demarc, and OTDR test the completed span. Certification required.",
  "new installation", "telecommunications carrier", "senior", (65,110), (5,9)),
 ("Network Switch Refresh — Branch Site",
  "Swap legacy switches for new units, migrate VLAN configuration, verify uplinks and confirm connectivity with the NOC before departure.",
  "upgrade and migration", "banking branch", "senior", (60,95), (4,7)),
 ("WiFi Site Survey and Heat Map",
  "Conduct a predictive and on-site wireless survey, capture AP placement recommendations and deliver a heat map report.",
  "site survey and audit", "warehouse", "senior", (55,90), (3,6)),
 ("CCTV Camera Installation — {n} Cameras",
  "Mount {n} IP cameras, run low voltage cabling to the NVR, configure recording schedules and confirm remote viewing.",
  "new installation", "retail store", "intermediate", (45,78), (5,9)),
 ("Access Control Reader Replacement",
  "Replace failed badge readers at entry doors, verify door controller wiring and test credentials against the access system.",
  "break-fix repair", "corporate office", "intermediate", (48,80), (2,5)),
 ("Digital Menu Board Installation",
  "Mount digital signage displays, run power and HDMI, configure media player and confirm content playback with the signage platform.",
  "new installation", "quick service restaurant", "entry", (40,65), (3,6)),
 ("Conference Room AV Refresh",
  "Install display, ceiling microphone array and video bar. Terminate cabling, configure the room system and complete a call test.",
  "upgrade and migration", "corporate office", "senior", (58,95), (5,9)),
 ("Server Rack and Stack — Data Room",
  "Rack and stack new server hardware, dress cabling, label ports and verify power redundancy on both feeds.",
  "new installation", "data centre", "senior", (60,100), (6,10)),
 ("Desktop Break-Fix — Hardware Swap",
  "Diagnose failed workstations, swap hardware, reimage where needed and confirm the user is operational before closing.",
  "break-fix repair", "healthcare clinic", "entry", (35,58), (2,4)),
 ("Printer and MFP Preventive Maintenance",
  "Complete scheduled maintenance on multifunction printers: clean feed paths, replace consumables and run diagnostics.",
  "preventive maintenance", "school campus", "entry", (35,55), (2,4)),
 ("ATM Servicing and Diagnostics",
  "Respond to ATM fault, diagnose the cash dispenser and card reader, clear jams and verify a full transaction cycle.",
  "break-fix repair", "credit union", "intermediate", (55,88), (2,5)),
 ("Ordering Kiosk Installation",
  "Install self-service ordering kiosks, mount payment devices, connect to the store network and validate menu synchronisation.",
  "new installation", "fast food restaurant", "intermediate", (45,75), (4,7)),
 ("EV Charger Installation — Level 2",
  "Install Level 2 EVSE units, run conduit and circuits from the panel, and commission the chargers on the network platform.",
  "new installation", "retail parking", "senior", (65,105), (6,10)),
 ("HVAC Rooftop Unit Service Call",
  "Diagnose an RTU fault, check refrigerant pressures, replace failed components and confirm the unit is holding setpoint.",
  "break-fix repair", "supermarket", "senior", (60,98), (3,6)),
 ("VoIP Phone System Cutover",
  "Deploy VoIP handsets, configure SIP registration, port extensions and confirm inbound and outbound call paths.",
  "upgrade and migration", "medical practice", "intermediate", (50,82), (4,8)),
 ("Drive-Thru Headset and Board Repair",
  "Troubleshoot the drive-thru headset base station and order confirmation board, replace faulty components and verify audio.",
  "break-fix repair", "quick service restaurant", "intermediate", (45,72), (2,5)),
 ("Cash Recycler Installation",
  "Install a cash recycling unit at the teller line, level and anchor the safe, and complete a supervised balance test.",
  "new installation", "bank branch", "senior", (58,92), (4,8)),
 ("Warehouse Scanner Deployment",
  "Stage and deploy handheld barcode scanners, join them to the wireless network and confirm scanning against the WMS.",
  "rollout and deployment", "distribution centre", "entry", (38,62), (4,7)),
 ("Store Network Site Survey",
  "Complete a pre-installation site walk, document existing cabling and rack space, photograph the demarc and file the survey.",
  "site survey and audit", "retail store", "entry", (35,60), (2,4)),
 ("Equipment De-Installation and Removal",
  "De-install legacy equipment, coil and remove abandoned cabling, palletise for return shipping and leave the site clean.",
  "de-installation", "retail store", "entry", (35,58), (3,6)),
 ("Depot Staging and Configuration",
  "Stage and image devices at the depot, apply the standard build, label by site and prepare pallets for regional dispatch.",
  "staging and configuration", "logistics", "intermediate", (40,68), (6,10)),
 ("Commercial Refrigeration Repair",
  "Diagnose a walk-in cooler running warm, check the compressor and condenser, replace parts and verify temperature recovery.",
  "break-fix repair", "grocery store", "senior", (62,100), (3,7)),
]

CERT_HINTS = {"senior": ["OSHA 30", "BICSI certified", "CompTIA Network+"],
              "intermediate": ["OSHA 10", "CompTIA A+"],
              "entry": ["OSHA 10"]}

HTML_WRAPS = [
 '<div class="wo-body"><p>{b}</p>{extra}</div>',
 '<p style="margin:0 0 8px 0">{b}</p>{extra}',
 '<div><span class="lbl">Scope of work:</span><br/>{b}<br/>{extra}</div>',
 '<article><h3>Scope</h3><p>{b}</p>{extra}</article>',
]
EXTRAS = [
 '<ul><li>Check in&nbsp;with site manager on arrival</li><li>Photos required at close</li></ul>',
 '<p><strong>Tools:</strong> technician must supply own hand tools &amp; ladder</p>',
 '<ul><li>Background check required</li><li>Boots &amp; hi-vis mandatory</li></ul>',
 '<p><em>Parts shipped to site in advance.</em> Confirm receipt before dispatch.</p>',
 '<br/><p>Sign-off sheet must be uploaded before the work order is closed.</p>',
]

REWORD = [
 ("Install and configure", "Set up and commission"), ("Deploy", "Roll out"),
 ("Complete", "Carry out"), ("Diagnose", "Troubleshoot"),
 ("Replace", "Swap out"), ("required", "needed"),
 ("verify", "confirm"), ("Mount", "Fit"),
]


def _make(idx: int, tpl, metro, dup_of: str | None = None,
          company: str | None = None) -> RawJob:
    title_t, blurb, wtype, industry, level, pay, hrs = tpl
    n = random.choice([2, 3, 4, 6, 8, 12])
    title = title_t.format(n=n)
    body  = blurb.format(n=n)

    if dup_of:                      # reworded near-duplicate of an earlier order
        for a, b in REWORD:
            body = body.replace(a, b)
        title = title.replace("—", "-")

    city, state, lat, lon = metro
    certs = random.sample(CERT_HINTS[level], k=min(2, len(CERT_HINTS[level])))
    tail = (f"<p>Work type: {wtype}. Site: {industry}. "
            f"Level: {level} technician. Certifications: {', '.join(certs)}.</p>")
    html = random.choice(HTML_WRAPS).format(b=body, extra=random.choice(EXTRAS)) + tail

    rate = round(random.uniform(*pay), 2)
    ext  = dup_of or hashlib.md5(f"{title}{city}{idx}".encode()).hexdigest()[:12]
    return RawJob(
        external_id=f"fn-{ext}-{idx}", source="fieldnation_synthetic",
        source_type="synthetic", title=title, body_raw=html,
        company=company or random.choice(BUYERS), city=city, state=state, country="US",
        pay_type=random.choice(["hourly", "hourly", "fixed", "device"]),
        pay_rate=rate, duration_hours=round(random.uniform(*hrs), 1),
        tags=[wtype, industry, level],
    )


def fetch_synthetic(count: int = 160, duplicate_ratio: float = 0.08) -> list[RawJob]:
    jobs, seeds = [], []
    n_dupes = int(count * duplicate_ratio)
    for i in range(count - n_dupes):
        tpl, metro = random.choice(TEMPLATES), random.choice(METROS)
        job = _make(i, tpl, metro)
        jobs.append(job); seeds.append((i, tpl, metro, job.company))
    # Near-duplicates: the same buyer's same site work, reworded, as it would
    # look arriving from a second channel. Same company + city, new external id.
    for k in range(n_dupes):
        i, tpl, metro, company = random.choice(seeds)
        jobs.append(_make(10_000 + k, tpl, metro, dup_of=f"dup{k}", company=company))
    random.shuffle(jobs)
    return jobs
