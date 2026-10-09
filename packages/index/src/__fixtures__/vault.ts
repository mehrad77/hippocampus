/** Extra notes for index tests, on top of core's fixture vault. Fictional, from the example campaign. */
export const extra = {
  "characters/joao-silva.md": `---\ntype: character\ntitle: João Silva\naliases: [the landlord]\ntags: [housing]\nfacts:\n  phone: { value: "+351 900 000 001", status: canon, by: home-finder }\n  iban: { value: "secret://joao-silva/iban", status: canon, by: home-finder }\nrelations:\n  - { rel: owns, target: "[[alfama-flat]]" }\n---\n`,
  "locations/alfama-flat.md": `---\ntype: location\ntitle: Alfama flat\nrelations:\n  - { rel: located_in, target: "[[lisbon]]" }\n---\n`,
  "locations/lisbon.md": `---\ntype: location\ntitle: Lisbon\naliases: [Lisboa]\n---\n`,
  "characters/ilkay-yilmaz.md": `---\ntype: character\ntitle: İlkay Yılmaz\ntags: [university]\n---\nClassmate from the exchange programme.\n`,
  "inbox/campus-agent/2026-09-27T110000-enrol.md": `---\nagent: campus-agent\nkind: fact\nat: 2026-09-27T11:00:00Z\n---\nEnrolment at Harbor University opens 2026-10-01.\n`,
  "inbox/residency-agent/2026-09-27T120000-pass.md": `---\nagent: residency-agent\nkind: fact\nat: 2026-09-27T12:00:00Z\nsecret: true\n---\nPassport number U12345678.\n`,
};
