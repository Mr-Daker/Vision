/**
 * Synthetic demonstration geography.
 *
 * Lives under `fixtures/` deliberately. V001 Appendix G rule 7 says scope is
 * data rather than code, and `tools/check-scope-literals.mjs` enforces that by
 * exempting fixture paths — which is also why a Maharashtra list may name
 * Sangli here and must not name it in rendering logic.
 *
 * The places are real and the coordinates are approximate city centres, so
 * navigation feels believable. Everything attached to them in `demo-issues.ts`
 * is fabricated. No street address is specified, because a precise address
 * would invite reading a fabricated record as a real incident.
 *
 * `issueCount` per city is fixed rather than random. That is what makes the
 * hotspots deliberate — Chennai, Bengaluru, Mumbai and Hyderabad carry the
 * load a real reporting system would show — and what makes the country total
 * land on an exact, reproducible 428.
 *
 * `weights` biases which categories a city produces: coastal cities drain
 * badly, dense metros wear their roads out, smaller towns report schools and
 * water. A uniform random draw would have produced the same histogram
 * everywhere, which is the one thing real reporting data never looks like.
 */

import type { IssueCategory } from "../intelligence.types.ts";

export type DemoCity = {
  readonly name: string;
  readonly district: string;
  readonly lat: number;
  readonly lon: number;
  readonly issueCount: number;
  /** Relative pull per category. Omitted categories are still possible, rarely. */
  readonly weights: Partial<Record<IssueCategory, number>>;
  /** Localities are area names, never street addresses. */
  readonly localities: readonly string[];
};

export type DemoState = {
  readonly name: string;
  readonly code: string;
  readonly cities: readonly DemoCity[];
};

const METRO_ROADS: Partial<Record<IssueCategory, number>> = {
  road_damage: 9,
  pothole: 7,
  drainage: 5,
  water_supply: 4,
  street_light: 4,
  waste: 4,
  traffic_signal: 3,
  sanitation: 2,
  public_transport: 2,
  school: 1,
  bridge: 1,
  public_health_facility: 1,
};

const TOWN_MIX: Partial<Record<IssueCategory, number>> = {
  school: 7,
  water_supply: 7,
  road_damage: 5,
  public_health_facility: 4,
  street_light: 4,
  sanitation: 3,
  drainage: 3,
  bridge: 2,
  waste: 2,
  pothole: 2,
};

export const DEMO_COUNTRY = { name: "India", code: "IN" } as const;

export const DEMO_STATES: readonly DemoState[] = [
  {
    name: "Tamil Nadu",
    code: "TN",
    cities: [
      {
        name: "Chennai",
        district: "Chennai",
        lat: 13.0827,
        lon: 80.2707,
        issueCount: 31,
        // Coastal, low-lying and monsoon-flooded: drainage sits unusually high.
        weights: {
          road_damage: 8,
          pothole: 4,
          drainage: 8,
          water_supply: 5,
          street_light: 5,
          waste: 4,
          sanitation: 3,
          school: 2,
          traffic_signal: 2,
          public_transport: 2,
          bridge: 1,
          public_health_facility: 1,
        },
        localities: ["Adyar", "Mylapore", "Velachery", "Anna Nagar", "Tambaram", "Perungudi"],
      },
      {
        name: "Coimbatore",
        district: "Coimbatore",
        lat: 11.0168,
        lon: 76.9558,
        issueCount: 16,
        weights: METRO_ROADS,
        localities: ["Peelamedu", "Saibaba Colony", "Singanallur", "Ganapathy"],
      },
      {
        name: "Madurai",
        district: "Madurai",
        lat: 9.9252,
        lon: 78.1198,
        issueCount: 14,
        weights: { ...TOWN_MIX, drainage: 5, road_damage: 6 },
        localities: ["Anna Nagar", "Thirunagar", "Villapuram", "Goripalayam"],
      },
      {
        name: "Tiruchirappalli",
        district: "Tiruchirappalli",
        lat: 10.7905,
        lon: 78.7047,
        issueCount: 12,
        weights: TOWN_MIX,
        localities: ["Srirangam", "Thillai Nagar", "Woraiyur"],
      },
      {
        name: "Salem",
        district: "Salem",
        lat: 11.6643,
        lon: 78.146,
        issueCount: 10,
        weights: TOWN_MIX,
        localities: ["Hasthampatti", "Ammapet", "Fairlands"],
      },
      {
        name: "Vellore",
        district: "Vellore",
        lat: 12.9165,
        lon: 79.1325,
        issueCount: 9,
        weights: TOWN_MIX,
        localities: ["Katpadi", "Sathuvachari", "Gandhi Nagar"],
      },
    ],
  },
  {
    name: "Karnataka",
    code: "KA",
    cities: [
      {
        name: "Bengaluru",
        district: "Bengaluru Urban",
        lat: 12.9716,
        lon: 77.5946,
        issueCount: 28,
        // Road wear, water supply and signals dominate a fast-growing metro.
        weights: {
          road_damage: 9,
          pothole: 8,
          water_supply: 7,
          traffic_signal: 5,
          drainage: 4,
          street_light: 4,
          waste: 3,
          public_transport: 3,
          sanitation: 2,
          school: 1,
          bridge: 1,
        },
        localities: [
          "Koramangala",
          "Whitefield",
          "Jayanagar",
          "Hebbal",
          "Indiranagar",
          "Yelahanka",
        ],
      },
      {
        name: "Mysuru",
        district: "Mysuru",
        lat: 12.2958,
        lon: 76.6394,
        issueCount: 13,
        weights: TOWN_MIX,
        localities: ["Vijayanagar", "Kuvempunagar", "Gokulam"],
      },
      {
        name: "Hubballi",
        district: "Dharwad",
        lat: 15.3647,
        lon: 75.124,
        issueCount: 12,
        weights: TOWN_MIX,
        localities: ["Vidyanagar", "Gokul Road", "Keshwapur"],
      },
      {
        name: "Mangaluru",
        district: "Dakshina Kannada",
        lat: 12.9141,
        lon: 74.856,
        issueCount: 11,
        weights: { ...TOWN_MIX, drainage: 6 },
        localities: ["Kadri", "Bejai", "Surathkal"],
      },
      {
        name: "Belagavi",
        district: "Belagavi",
        lat: 15.8497,
        lon: 74.4977,
        issueCount: 10,
        weights: TOWN_MIX,
        localities: ["Tilakwadi", "Camp", "Shahapur"],
      },
    ],
  },
  {
    name: "Maharashtra",
    code: "MH",
    cities: [
      {
        name: "Mumbai",
        district: "Mumbai Suburban",
        lat: 19.076,
        lon: 72.8777,
        issueCount: 24,
        weights: {
          drainage: 9,
          road_damage: 8,
          waste: 6,
          pothole: 5,
          water_supply: 4,
          street_light: 3,
          public_transport: 3,
          sanitation: 3,
          traffic_signal: 2,
          bridge: 2,
          school: 1,
        },
        localities: ["Andheri", "Dadar", "Kurla", "Borivali", "Chembur"],
      },
      {
        name: "Pune",
        district: "Pune",
        lat: 18.5204,
        lon: 73.8567,
        issueCount: 16,
        weights: METRO_ROADS,
        localities: ["Kothrud", "Hadapsar", "Aundh", "Viman Nagar"],
      },
      {
        name: "Nagpur",
        district: "Nagpur",
        lat: 21.1458,
        lon: 79.0882,
        issueCount: 11,
        weights: METRO_ROADS,
        localities: ["Dharampeth", "Sadar", "Manish Nagar"],
      },
      {
        name: "Nashik",
        district: "Nashik",
        lat: 19.9975,
        lon: 73.7898,
        issueCount: 9,
        weights: TOWN_MIX,
        localities: ["Panchavati", "Gangapur Road", "Satpur"],
      },
      {
        name: "Sangli",
        district: "Sangli",
        lat: 16.8524,
        lon: 74.5815,
        issueCount: 8,
        // The district the rest of the product is scoped to, present here so
        // the national view contains the pilot rather than ignoring it.
        weights: { ...TOWN_MIX, school: 9, water_supply: 8 },
        localities: ["Vishrambag", "Miraj", "Kupwad"],
      },
    ],
  },
  {
    name: "Telangana",
    code: "TG",
    cities: [
      {
        name: "Hyderabad",
        district: "Hyderabad",
        lat: 17.385,
        lon: 78.4867,
        issueCount: 26,
        weights: {
          road_damage: 9,
          water_supply: 7,
          street_light: 6,
          pothole: 5,
          drainage: 4,
          waste: 3,
          traffic_signal: 3,
          sanitation: 2,
          public_transport: 2,
          school: 1,
          bridge: 1,
        },
        localities: ["Gachibowli", "Secunderabad", "Kukatpally", "Begumpet", "LB Nagar"],
      },
      {
        name: "Warangal",
        district: "Warangal",
        lat: 17.9689,
        lon: 79.5941,
        issueCount: 10,
        weights: TOWN_MIX,
        localities: ["Hanamkonda", "Kazipet", "Subedari"],
      },
      {
        name: "Nizamabad",
        district: "Nizamabad",
        lat: 18.6725,
        lon: 78.0941,
        issueCount: 8,
        weights: TOWN_MIX,
        localities: ["Khaleelwadi", "Vinayak Nagar"],
      },
      {
        name: "Karimnagar",
        district: "Karimnagar",
        lat: 18.4386,
        lon: 79.1288,
        issueCount: 7,
        weights: TOWN_MIX,
        localities: ["Mankammathota", "Kothirampur"],
      },
    ],
  },
  {
    name: "Kerala",
    code: "KL",
    cities: [
      {
        name: "Thiruvananthapuram",
        district: "Thiruvananthapuram",
        lat: 8.5241,
        lon: 76.9366,
        issueCount: 11,
        weights: { ...METRO_ROADS, drainage: 7, waste: 5 },
        localities: ["Kowdiar", "Pattom", "Kazhakkoottam"],
      },
      {
        name: "Kochi",
        district: "Ernakulam",
        lat: 9.9312,
        lon: 76.2673,
        issueCount: 9,
        weights: { ...METRO_ROADS, drainage: 8 },
        localities: ["Kakkanad", "Fort Kochi", "Edappally"],
      },
      {
        name: "Kozhikode",
        district: "Kozhikode",
        lat: 11.2588,
        lon: 75.7804,
        issueCount: 6,
        weights: TOWN_MIX,
        localities: ["Vellayil", "Nadakkavu"],
      },
      {
        name: "Thrissur",
        district: "Thrissur",
        lat: 10.5276,
        lon: 76.2144,
        issueCount: 4,
        weights: TOWN_MIX,
        localities: ["Ollur", "Ayyanthole"],
      },
    ],
  },
  {
    name: "Delhi",
    code: "DL",
    cities: [
      {
        name: "New Delhi",
        district: "New Delhi",
        lat: 28.6139,
        lon: 77.209,
        issueCount: 16,
        weights: { ...METRO_ROADS, waste: 6, water_supply: 6 },
        localities: ["Karol Bagh", "Lajpat Nagar", "Saket"],
      },
      {
        name: "Dwarka",
        district: "South West Delhi",
        lat: 28.5921,
        lon: 77.046,
        issueCount: 7,
        weights: METRO_ROADS,
        localities: ["Sector 12", "Sector 21"],
      },
      {
        name: "Rohini",
        district: "North West Delhi",
        lat: 28.7495,
        lon: 77.0565,
        issueCount: 5,
        weights: METRO_ROADS,
        localities: ["Sector 7", "Sector 18"],
      },
    ],
  },
  {
    name: "Gujarat",
    code: "GJ",
    cities: [
      {
        name: "Ahmedabad",
        district: "Ahmedabad",
        lat: 23.0225,
        lon: 72.5714,
        issueCount: 11,
        weights: METRO_ROADS,
        localities: ["Navrangpura", "Maninagar", "Bopal"],
      },
      {
        name: "Surat",
        district: "Surat",
        lat: 21.1702,
        lon: 72.8311,
        issueCount: 7,
        weights: { ...METRO_ROADS, drainage: 7 },
        localities: ["Adajan", "Katargam"],
      },
      {
        name: "Vadodara",
        district: "Vadodara",
        lat: 22.3072,
        lon: 73.1812,
        issueCount: 5,
        weights: TOWN_MIX,
        localities: ["Alkapuri", "Gotri"],
      },
      {
        name: "Rajkot",
        district: "Rajkot",
        lat: 22.3039,
        lon: 70.8022,
        issueCount: 3,
        weights: TOWN_MIX,
        localities: ["Kalawad Road"],
      },
    ],
  },
  {
    name: "West Bengal",
    code: "WB",
    cities: [
      {
        name: "Kolkata",
        district: "Kolkata",
        lat: 22.5726,
        lon: 88.3639,
        issueCount: 12,
        weights: { ...METRO_ROADS, drainage: 8, waste: 5 },
        localities: ["Salt Lake", "Behala", "Tollygunge"],
      },
      {
        name: "Howrah",
        district: "Howrah",
        lat: 22.5958,
        lon: 88.2636,
        issueCount: 6,
        weights: TOWN_MIX,
        localities: ["Shibpur", "Bally"],
      },
      {
        name: "Siliguri",
        district: "Darjeeling",
        lat: 26.7271,
        lon: 88.3953,
        issueCount: 4,
        weights: TOWN_MIX,
        localities: ["Pradhan Nagar"],
      },
      {
        name: "Durgapur",
        district: "Paschim Bardhaman",
        lat: 23.5204,
        lon: 87.3119,
        issueCount: 2,
        weights: TOWN_MIX,
        localities: ["City Centre"],
      },
    ],
  },
  {
    name: "Rajasthan",
    code: "RJ",
    cities: [
      {
        name: "Jaipur",
        district: "Jaipur",
        lat: 26.9124,
        lon: 75.7873,
        issueCount: 8,
        weights: { ...METRO_ROADS, water_supply: 8 },
        localities: ["Malviya Nagar", "Vaishali Nagar"],
      },
      {
        name: "Jodhpur",
        district: "Jodhpur",
        lat: 26.2389,
        lon: 73.0243,
        issueCount: 5,
        weights: { ...TOWN_MIX, water_supply: 9 },
        localities: ["Ratanada", "Shastri Nagar"],
      },
      {
        name: "Udaipur",
        district: "Udaipur",
        lat: 24.5854,
        lon: 73.7125,
        issueCount: 3,
        weights: TOWN_MIX,
        localities: ["Hiran Magri"],
      },
      {
        name: "Kota",
        district: "Kota",
        lat: 25.2138,
        lon: 75.8648,
        issueCount: 2,
        weights: TOWN_MIX,
        localities: ["Talwandi"],
      },
    ],
  },
  {
    name: "Odisha",
    code: "OD",
    cities: [
      {
        name: "Bhubaneswar",
        district: "Khordha",
        lat: 20.2961,
        lon: 85.8245,
        issueCount: 7,
        weights: METRO_ROADS,
        localities: ["Patia", "Saheed Nagar"],
      },
      {
        name: "Cuttack",
        district: "Cuttack",
        lat: 20.4625,
        lon: 85.883,
        issueCount: 4,
        weights: { ...TOWN_MIX, drainage: 6 },
        localities: ["Buxi Bazaar"],
      },
      {
        name: "Rourkela",
        district: "Sundargarh",
        lat: 22.2604,
        lon: 84.8536,
        issueCount: 3,
        weights: TOWN_MIX,
        localities: ["Civil Township"],
      },
      {
        name: "Puri",
        district: "Puri",
        lat: 19.8135,
        lon: 85.8312,
        issueCount: 3,
        weights: { ...TOWN_MIX, sanitation: 6 },
        localities: ["Chakratirtha"],
      },
    ],
  },
];

/** The dataset size, derived rather than asserted. Change a city to change it. */
export const DEMO_ISSUE_TOTAL = DEMO_STATES.reduce(
  (total, state) => total + state.cities.reduce((sum, city) => sum + city.issueCount, 0),
  0,
);
