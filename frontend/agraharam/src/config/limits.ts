/** List and string size limits enforced by validateConfig (§4.2). */
export const LIMITS = {
  people: 8,
  climate: 8,
  air: 12,
  bed_comfort: 4,
  rooms: 12,
  lightsPerRoom: 20,
  curtainsPerRoom: 6,
  vacuums: 6,
  appliances: 10,
  media: 6,
  cameras: 8,
  perimeter: 16,
  calendars: 4,
  nameChars: 60,
  titleChars: 40,
} as const;
