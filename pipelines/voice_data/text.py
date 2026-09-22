"""What a citizen actually writes, per sector and issue type.

Two rules shape this file.

**No placeholder text.** "water problem 1" teaches a language model nothing and
makes deduplication trivially easy in a way real reports never are. Every
template below is a sentence a person might plausibly send, with the hedging,
detail and irritation real reports carry.

**Native-language text is a documented subset, not a fabrication.** English
templates cover every issue type. Hindi, Tamil, Bengali and Marathi templates
exist for the most common types only, written as ordinary short sentences. A
report drawn in a language with no template for its type keeps the native
language label, carries the English text in `normalized_description`, and sets
`raw_description_language_matched = False` so the gap is visible in the data
rather than hidden by a bad machine translation. §11 of the brief explicitly
prefers this over fabricating poor translations.
"""

from __future__ import annotations

#: issue_type -> list of subtypes. Subtypes give the dedup task something
#: finer-grained than sector to work with.
ISSUE_TYPES: dict[str, dict[str, tuple[str, ...]]] = {
    "water": {
        "no_piped_supply": ("never_connected", "connection_pending", "scheme_incomplete"),
        "irregular_supply": ("low_pressure", "alternate_day_only", "short_duration"),
        "contaminated_water": ("muddy", "smell_or_taste", "illness_reported"),
        "broken_infrastructure": ("pipeline_leak", "handpump_broken", "tank_damaged"),
    },
    "roads": {
        "damaged_surface": ("potholes", "broken_stretch", "surface_washed_away"),
        "no_connectivity": ("village_unconnected", "seasonal_access_only"),
        "waterlogging": ("no_drainage", "monsoon_flooding"),
        "unsafe_structure": ("bridge_damaged", "culvert_collapsed", "no_street_lighting"),
    },
    "education": {
        "building_condition": ("roof_leaking", "classroom_unsafe", "no_boundary_wall"),
        "basic_facilities": ("no_drinking_water", "toilet_unusable", "no_electricity"),
        "staffing": ("teacher_shortage", "single_teacher_school"),
        "access": ("no_school_nearby", "transport_unavailable"),
    },
    "health": {
        "facility_access": ("no_phc_nearby", "facility_too_far", "closed_frequently"),
        "staff_availability": ("doctor_absent", "no_night_staff", "no_female_staff"),
        "supplies": ("medicines_unavailable", "equipment_broken", "no_ambulance"),
        "facility_condition": ("building_damaged", "no_water_at_facility", "unhygienic"),
    },
}

#: English templates keyed by (sector, issue_type). `{place}` is filled with a
#: synthetic locality name — never a real village — at generation time.
ENGLISH: dict[tuple[str, str], tuple[str, ...]] = {
    ("water", "no_piped_supply"): (
        "There is still no piped water connection in our part of {place}. We have been waiting since the survey was done.",
        "Our street in {place} was left out when the water pipeline was laid. Every household here depends on a single borewell.",
        "The tap connection work in {place} was marked done but no pipe has reached our houses.",
    ),
    ("water", "irregular_supply"): (
        "Water comes only for about twenty minutes every second day in {place}, and the pressure is too low to fill a drum.",
        "We get water once in three days now. Last month it was daily. Nobody has told us why it changed.",
        "Supply to {place} stops by six in the morning. Anyone who works early gets nothing.",
    ),
    ("water", "contaminated_water"): (
        "The water coming to {place} has been muddy for two weeks and smells bad. We are boiling it but children have still fallen ill.",
        "There is a strange taste in the tap water here. Three families on our lane have had stomach illness this month.",
        "Dirty water is mixing into the supply line in {place}, probably from the drain running beside it.",
    ),
    ("water", "broken_infrastructure"): (
        "The pipeline near the {place} junction has been leaking for over a month and the road there stays flooded.",
        "The handpump at {place} has been broken since before the summer. It was the only source for the nearby houses.",
        "The overhead tank serving {place} is cracked and water leaks down the side all day.",
    ),
    ("roads", "damaged_surface"): (
        "The road through {place} is full of potholes and two-wheelers fall almost every week during rain.",
        "A long stretch of the {place} road has broken up completely. Autos refuse to come here after dark.",
        "The surface near {place} was repaired last year but has already washed away.",
    ),
    ("roads", "no_connectivity"): (
        "There is no proper road to {place}. During the monsoon we cannot bring a vehicle in at all.",
        "Our hamlet near {place} is still not connected by an all-weather road. Patients have to be carried to the main road.",
        "The approach road to {place} exists on paper but on the ground it is a mud track.",
    ),
    ("roads", "waterlogging"): (
        "Water stands on the {place} road for days after any rain because there is no drain on either side.",
        "The drain along {place} is blocked and the overflow now runs across the road.",
        "Every monsoon the stretch at {place} floods knee-deep and the school children cannot cross.",
    ),
    ("roads", "unsafe_structure"): (
        "The small bridge near {place} has a large crack and the railing is gone. It is dangerous at night.",
        "The culvert at {place} collapsed after the last heavy rain and has not been repaired.",
        "There are no working street lights on the {place} stretch and it is completely dark by seven.",
    ),
    ("education", "building_condition"): (
        "The school roof at {place} has been leaking for months and part of the ceiling plaster fell last week.",
        "Two classrooms in the {place} school are unsafe. The children are being made to sit in the corridor.",
        "The school at {place} has no boundary wall, so cattle come into the ground during class hours.",
    ),
    ("education", "basic_facilities"): (
        "There is no drinking water at the {place} school. Children carry bottles from home and run out by noon.",
        "The toilets at the {place} school have been unusable for a long time. Older girls have stopped coming regularly.",
        "The school in {place} has no electricity connection, so the fans and the computer room are useless.",
    ),
    ("education", "staffing"): (
        "The {place} primary school has one teacher for all five classes.",
        "Two teacher posts at the {place} school have been vacant since last year and nobody has been posted.",
        "Our school at {place} has no mathematics teacher for the upper classes.",
    ),
    ("education", "access"): (
        "There is no upper primary school near {place}. Children have to travel seven kilometres each way.",
        "The bus that took children from {place} to the school stopped running and no replacement was arranged.",
    ),
    ("health", "facility_access"): (
        "There is no primary health centre near {place}. The nearest one is over an hour away by shared vehicle.",
        "The health centre serving {place} is shut more often than it is open. People go to a private clinic instead.",
        "For any delivery case from {place} we have to reach the district hospital, which is very far at night.",
    ),
    ("health", "staff_availability"): (
        "The doctor at the {place} health centre comes only two days a week, and everyone knows which days.",
        "There is no staff at the {place} centre after evening. An emergency at night has nowhere to go.",
        "There is no female health worker at the {place} centre, so many women here avoid going at all.",
    ),
    ("health", "supplies"): (
        "The health centre at {place} has had no basic medicines for weeks. We are told to buy everything outside.",
        "The equipment at the {place} centre is broken and tests are not being done there any more.",
        "No ambulance is available for {place}. The last emergency was taken in a private vehicle.",
    ),
    ("health", "facility_condition"): (
        "The health centre building at {place} is damaged and one room is not being used at all.",
        "There is no running water at the {place} health centre, which makes even basic dressing difficult.",
        "The {place} centre is not kept clean and the waiting area floods when it rains.",
    ),
}

#: Native-language templates. Deliberately partial — see the module docstring.
#: Keyed by (language, sector, issue_type).
NATIVE: dict[tuple[str, str, str], tuple[str, ...]] = {
    ("Hindi", "water", "irregular_supply"): (
        "{place} में पानी दो दिन में एक बार आता है और दबाव इतना कम है कि बर्तन भी नहीं भरता।",
        "यहाँ नल का पानी सुबह जल्दी बंद हो जाता है, काम पर जाने वालों को कुछ नहीं मिलता।",
    ),
    ("Hindi", "water", "no_piped_supply"): (
        "{place} के हमारे हिस्से में अब तक नल का कनेक्शन नहीं आया है। सर्वे हुए बहुत समय हो गया।",
    ),
    ("Hindi", "roads", "damaged_surface"): (
        "{place} की सड़क पूरी तरह टूट चुकी है, बारिश में हर हफ्ते कोई न कोई गिरता है।",
    ),
    ("Hindi", "education", "building_condition"): (
        "{place} के स्कूल की छत महीनों से टपक रही है, पिछले हफ्ते छत का प्लास्टर गिर गया।",
    ),
    ("Hindi", "health", "staff_availability"): (
        "{place} के स्वास्थ्य केंद्र पर डॉक्टर हफ्ते में सिर्फ दो दिन आते हैं।",
    ),
    ("Marathi", "water", "irregular_supply"): (
        "{place} मध्ये पाणी दोन दिवसांतून एकदाच येते आणि दाब खूप कमी असतो.",
    ),
    ("Marathi", "roads", "waterlogging"): (
        "पाऊस पडल्यावर {place} च्या रस्त्यावर कित्येक दिवस पाणी साचून राहते, गटार नाही.",
    ),
    ("Tamil", "water", "irregular_supply"): (
        "{place} பகுதியில் இரண்டு நாட்களுக்கு ஒரு முறை மட்டுமே தண்ணீர் வருகிறது, அழுத்தமும் மிகக் குறைவு.",
    ),
    ("Tamil", "roads", "damaged_surface"): (
        "{place} சாலை முழுவதும் பள்ளங்கள். மழைக் காலத்தில் இருசக்கர வாகனங்கள் அடிக்கடி விழுகின்றன.",
    ),
    ("Bengali", "water", "contaminated_water"): (
        "{place} এলাকায় কলের জল দু'সপ্তাহ ধরে ঘোলা আসছে এবং দুর্গন্ধ রয়েছে।",
    ),
    ("Bengali", "education", "basic_facilities"): (
        "{place} স্কুলে খাবার জলের কোনও ব্যবস্থা নেই, বাচ্চারা বাড়ি থেকে বোতল নিয়ে যায়।",
    ),
}

#: Synthetic locality names. Constructed from neutral, common Indian place-name
#: morphemes so they read naturally without naming a real village — §14 of the
#: brief requires that a planted hardship scenario never implies anything about
#: a real inhabited place.
LOCALITY_PREFIXES = (
    "Nava", "Rampur", "Sundar", "Krishna", "Mahal", "Devi", "Bagh", "Chandan",
    "Neem", "Anand", "Gokul", "Hari", "Jamun", "Kadam", "Lalgan", "Motipur",
    "Palash", "Ratan", "Shanti", "Tulsi", "Amba", "Bela", "Ganga", "Indra",
)
LOCALITY_SUFFIXES = (
    "pur", "gaon", "wadi", "halli", "palli", "nagar", "kheda", "basti",
    "para", "tola", "pada", "patti", "kunta", "ganj", "mohalla", "colony",
)
