// worker/src/domains/resume/types/resume.js

/**
 * JSON Resume Schema (https://jsonresume.org/schema/)
 * Extended with 'customSections' for modularity.
 */
export const resumeSchema = {
  basics: {
    name: "",
    label: "",
    image: "",
    email: "",
    phone: "",
    url: "",
    summary: "",
    location: {
      address: "",
      postalCode: "",
      city: "",
      countryCode: "",
      region: "",
    },
    profiles: [],
  },
  work: [],
  volunteer: [],
  education: [],
  awards: [],
  certificates: [],
  publications: [],
  skills: [],
  languages: [],
  interests: [],
  references: [],
  projects: [],
  customSections: [],
};

/**
 * Helper to get a blank instance of the schema
 */
export function getEmptyResume() {
  return JSON.parse(JSON.stringify(resumeSchema));
}

