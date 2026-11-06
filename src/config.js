// Every tunable value lives here. Changing a prompt version invalidates cached stage output on purpose.
export const config = {
  versions: {
    research: "research-v1",
    extract: "extract-v2",
    score: "score-v1",
    draft: "draft-v1",
    fallback: "fallback-v1",
    ground: "ground-v1",
  },

  // Company-level research themes. One search per theme, cached per company.
  themes: [
    { key: "funding_growth", label: "Funding and growth", topic: "news", ttlDays: 14,
      query: (c) => `${c} funding round investment revenue growth` },
    { key: "expansion", label: "Expansion and new markets", topic: "news", ttlDays: 14,
      query: (c) => `${c} expansion new office new country market launch` },
    { key: "ap_hiring", label: "Finance and AP hiring", topic: "general", ttlDays: 7,
      query: (c) => `${c} hiring accounts payable finance operations jobs` },
    { key: "erp_transformation", label: "ERP and finance transformation", topic: "news", ttlDays: 21,
      query: (c) => `${c} ERP migration finance transformation system implementation` },
    { key: "exec_statements", label: "Executive statements", topic: "news", ttlDays: 14,
      query: (c) => `${c} CFO CEO says finance efficiency automation interview` },
  ],
  personTheme: {
    key: "person_activity", label: "Recipient public activity", topic: "news", ttlDays: 14,
    query: (name, company) => `${name} ${company} interview talk says announced`,
  },
  maxSourcesPerTheme: 6,
  snippetChars: 1200,

  // Freshness by signal type: current up to currentDays, older but relevant up to staleDays.
  freshness: {
    ap_hiring: { currentDays: 60, staleDays: 90 },
    exec_statement: { currentDays: 90, staleDays: 183 },
    expansion: { currentDays: 180, staleDays: 365 },
    erp_transformation: { currentDays: 180, staleDays: 365 },
    funding: { currentDays: 270, staleDays: 548 },
    growth: { currentDays: 180, staleDays: 365 },
    other: { currentDays: 90, staleDays: 180 },
  },

  ranking: {
    weights: { O: 0.35, P: 0.25, S: 0.2, R: 0.2 },
    recency: { current: 5, older_but_relevant: 3, stale: 1, undated: 1 },
    tonePenalty: 0.5,
    strongAt: 4.0,
    moderateAt: 3.0,
    minOfferFit: 3,
    maxSignalsScored: 12,
  },

  // Sensitivity policy: category to level. Blocked signals never reach a draft.
  sensitivityPolicy: {
    none: "none",
    health: "blocked",
    bereavement: "blocked",
    family: "blocked",
    personal_legal: "blocked",
    layoffs: "tone_review_required",
    restructuring: "tone_review_required",
    executive_departure: "tone_review_required",
    company_lawsuit: "tone_review_required",
    breach: "tone_review_required",
  },
  // Third safeguard: phrases you always want handled a certain way. Example: { phrase: "acquisition talks", level: "tone_review_required" }
  policyPhrases: [],

  draft: {
    emailWordCap: 110,
    subjectMaxChars: 80,
    toneInstructions:
      "Keep the tone neutral and respectful. Do not describe the event as good or bad news, do not congratulate, and do not speculate about causes.",
  },

  verification: { ttlDays: 30 },
  runStaleSeconds: 120,
};

export const SIGNAL_TYPES = ["funding", "expansion", "ap_hiring", "erp_transformation", "exec_statement", "growth", "other"];
export const SENSITIVITY_CATEGORIES = Object.keys(config.sensitivityPolicy);
