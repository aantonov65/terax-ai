export type ProductResearchDraft = {
  archetypes: string;
  hotwords: string;
  mechanisms: string;
};

export type ProductConfigValidation = {
  ok: boolean;
  missing: string[];
  fields: Array<{
    key: string;
    label: string;
    present: boolean;
  }>;
};

export type ResearchValidation = {
  ok: boolean;
  missing: string[];
  sections: {
    archetypes: string[];
    hotwordA: string[];
    hotwordB: string[];
    mechanisms: string[];
  };
};

export type ProductReadinessStatus = "draft" | "starter_only" | "needs_evidence" | "production_ready";

export type ProductReadiness = {
  status: ProductReadinessStatus;
  approved: boolean;
  gaps: string[];
  starterResearch: boolean;
};

export const REQUIRED_PRODUCT_CONFIG_FIELDS = [
  {
    key: "product_code",
    label: "Product code",
    present: (config: Record<string, unknown>) =>
      typeof config.product_code === "string" && /^[A-Z][A-Z0-9-]*$/.test(config.product_code.trim()),
  },
  {
    key: "product_name",
    label: "Product name",
    present: (config: Record<string, unknown>) => Boolean(stringValue(config.product_name)),
  },
  {
    key: "target_demographic",
    label: "Target demographic",
    present: (config: Record<string, unknown>) => hasTargetDemographic(config),
  },
  {
    key: "mechanisms",
    label: "Mechanism truth",
    present: (config: Record<string, unknown>) => hasMechanism(config),
  },
  {
    key: "pricing_rules.single_bag_price_usd",
    label: "Pricing rules",
    present: (config: Record<string, unknown>) => hasPricingRules(config),
  },
  {
    key: "offer_architecture.guarantee_framing",
    label: "Offer architecture",
    present: (config: Record<string, unknown>) => hasOfferArchitecture(config),
  },
] as const;

const DEFAULT_PRICE = 49;
const DEFAULT_GUARANTEE = "60-day";

export function completeProductConfig(
  config: Record<string, unknown>,
  productFolder: string,
): Record<string, unknown> {
  const next = { ...config };
  const productName = productNameFromConfig(next, productFolder);
  const price = priceFromConfig(next) ?? DEFAULT_PRICE;
  const guarantee = stringValue(next.guarantee) || DEFAULT_GUARANTEE;

  if (!isRecord(next.pricing_rules)) {
    next.pricing_rules = {
      single_bag_price_usd: price,
      canonical_phrasings: [
        `${productName} is available for $${formatPrice(price)} today.`,
        `A bottle is $${formatPrice(price)} with a ${guarantee} guarantee.`,
      ],
      pricing_rules_positive: [
        `Use $${formatPrice(price)} as the only concrete price unless the product config is updated.`,
        "Do not invent competitor prices, discounts, subscriptions, or bundle math.",
      ],
    };
  }

  if (!isRecord(next.offer_architecture)) {
    next.offer_architecture = {
      what_you_get: [
        productName,
        "A simple at-home routine built around the product's core mechanism.",
        `A ${guarantee} guarantee so the viewer does not feel locked in.`,
      ],
      price_anchor_stack: [
        `$${formatPrice(price)} is framed against the repeated spend, time, and frustration of failed alternatives.`,
        "The value comes from reducing the daily problem loop, not from a hard-sell discount.",
      ],
      guarantee_framing: guarantee,
    };
  }

  if (!isRecord(next.target_demographic)) {
    const target = stringValue(next.target_customer) || stringValue(next.target) || "People actively looking for a better solution.";
    next.target_demographic = { description: target };
  }

  if (!isRecord(next.mechanisms)) {
    const mechanism = stringValue(next.mechanism) || stringValue(next.core_mechanism) || mechanismFromDetails(next, productName);
    next.mechanisms = { M1: mechanism };
  }

  if (!isRecord(next.prompt_context)) {
    next.prompt_context = {
      forbidden_phrases: [],
      note: "Starter prompt context generated from product details. Replace with product-specific compliance rules when available.",
    };
  }

  return next;
}

export function validateProductConfig(config: Record<string, unknown>): ProductConfigValidation {
  const fields = REQUIRED_PRODUCT_CONFIG_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    present: field.present(config),
  }));
  return {
    ok: fields.every((field) => field.present),
    missing: fields.filter((field) => !field.present).map((field) => field.key),
    fields,
  };
}

export function generateStarterResearch(
  config: Record<string, unknown>,
  productFolder = "product",
): ProductResearchDraft {
  const completed = completeProductConfig(config, productFolder);
  const productName = productNameFromConfig(completed, productFolder);
  const brand = stringValue(completed.brand) || productName;
  const problem = problemFromConfig(completed, productName);
  const target = targetFromConfig(completed);
  const mechanism = mechanismFromDetails(completed, productName);
  const guarantee = stringValue(completed.guarantee) || DEFAULT_GUARANTEE;
  const price = priceFromConfig(completed) ?? DEFAULT_PRICE;

  return {
    archetypes: starterArchetypes({ productName, brand, problem, target, mechanism }),
    hotwords: starterHotwords({ productName, problem, mechanism, guarantee, price }),
    mechanisms: starterMechanisms({ productName, brand, problem, target, mechanism }),
  };
}

export function completeResearchDraft(
  research: Partial<ProductResearchDraft> | undefined,
  config: Record<string, unknown>,
  productFolder = "product",
): ProductResearchDraft {
  const generated = generateStarterResearch(config, productFolder);
  return {
    archetypes: nonEmpty(research?.archetypes) || generated.archetypes,
    hotwords: nonEmpty(research?.hotwords) || generated.hotwords,
    mechanisms: nonEmpty(research?.mechanisms) || generated.mechanisms,
  };
}

export function validateResearchDraft(research: ProductResearchDraft): ResearchValidation {
  const sections = {
    archetypes: sectionCodes(research.archetypes, "ARC"),
    hotwordA: sectionCodes(research.hotwords, "A"),
    hotwordB: sectionCodes(research.hotwords, "B"),
    mechanisms: sectionCodes(research.mechanisms, "M"),
  };
  const missing = [];
  if (!sections.archetypes.length) missing.push("archetypes.md needs at least one ARC# section");
  if (!sections.hotwordA.length) missing.push("hotwords.md needs at least one A# section");
  if (!sections.hotwordB.length) missing.push("hotwords.md needs at least one B# section");
  if (!sections.mechanisms.length) missing.push("mechanisms.md needs at least one M# section");
  return { ok: missing.length === 0, missing, sections };
}

export function hasStarterResearch(research: ProductResearchDraft): boolean {
  return [research.archetypes, research.hotwords, research.mechanisms].some((text) =>
    /Starter (Archetypes|Hotwords|Mechanisms)|Auto-generated from product details/i.test(text),
  );
}

export function assessProductReadiness(
  config: Record<string, unknown>,
  research: ProductResearchDraft,
  approved = false,
): ProductReadiness {
  const gaps: string[] = [];
  const validation = validateResearchDraft(research);
  gaps.push(...validation.missing);
  if (!stringValue(config.product_name)) gaps.push("product_name is required");
  if (!hasPricingRules(config)) gaps.push("pricing_rules.single_bag_price_usd is required");
  if (!hasOfferArchitecture(config)) gaps.push("offer_architecture.guarantee_framing is required");
  if (!hasTargetDemographic(config)) gaps.push("target_demographic is required");
  if (!hasMechanism(config)) gaps.push("at least one mechanisms.M# entry is required");

  const starterResearch = hasStarterResearch(research);
  if (starterResearch) gaps.push("starter research must be replaced or explicitly approved");
  const status: ProductReadinessStatus = starterResearch
    ? "starter_only"
    : gaps.length
      ? "needs_evidence"
      : approved
        ? "production_ready"
        : "needs_evidence";
  return { status, approved: status === "production_ready", gaps, starterResearch };
}

function starterArchetypes(input: {
  productName: string;
  brand: string;
  problem: string;
  target: string;
  mechanism: string;
}): string {
  const { productName, brand, problem, target, mechanism } = input;
  return `# ${productName} Starter Archetypes\n\n> Auto-generated from product details so LFS can run. Replace with researched voice-of-customer archetypes when deeper research is available.\n\n## ARC1: The Frustrated Solver\n\nCore Description: ${target} who has already tried to fix ${problem} and feels stuck in a repetitive loop. They are not casually curious; they are tired of losing time, confidence, and emotional bandwidth to a problem that keeps coming back.\n\nAwareness Points:\n- A-1 (Physical/Visible): The problem is visible or felt often enough that it interrupts normal routines and creates a constant reminder that ${problem} is still unresolved.\n- A-2 (Life Stage/Timing): They feel like this should have been solved by now and are frustrated that ordinary fixes have not created lasting relief.\n- A-3 (Social/Access): The problem changes how they show up in public, at work, in relationships, or in private moments where they want to feel normal.\n- B-1 (Mechanism): They suspect there is a hidden reason the usual fixes do not last. Starter mechanism: ${mechanism}.\n- B-2 (Identity): They want to become the person who no longer has to plan their day around ${problem}.\n- B-3 (System): They feel let down by generic advice, overpromising products, and solutions that only address the surface.\n\nDeep Wound: They are scared the problem says something permanent about their body, discipline, age, attractiveness, or control.\nIdentity Threat: \"I should not still be dealing with this.\"\nFuture Terror: Nothing changes, every solution keeps failing, and the problem quietly becomes part of their identity.\n\nLanguage Patterns: tired of this, tried everything, nothing lasts, why does this keep happening, I just want to feel normal, I hate planning around it, I need something that actually makes sense\nMetaphors: stuck in a loop, fighting the same fire, covering the symptom not the source, patching a leak\nShame Statements: \"I feel like I am the only one still dealing with this.\" \"I do not want people noticing this before they notice me.\"\nAnger Statements: \"I am tired of wasting money on things that only help for a minute.\"\n\nFailed Solutions:\n- Generic routines: Help briefly, then the same problem returns.\n- Surface fixes: Make the problem look better temporarily but do not change the underlying loop.\n- Advice from others: Feels dismissive because it treats ${problem} like a simple discipline issue.\n\n---\n\n## ARC2: The Quiet Researcher\n\nCore Description: ${target} who has moved past basic awareness and is now looking for a believable explanation. They want a reason, not hype. They respond to calm mechanism language and proof that ${brand} understands why previous solutions disappointed them.\n\nAwareness Points:\n- A-1 (Physical/Visible): ${problem} is familiar enough that they can describe the pattern clearly.\n- A-2 (Life Stage/Timing): They are comparing solutions and trying to understand what makes ${productName} different.\n- A-3 (Social/Access): They may not talk about the problem openly, but it still affects decisions, confidence, and routines.\n- B-1 (Mechanism): They are open to the explanation that ${mechanism}.\n- B-2 (Identity): They want to feel informed, in control, and not tricked by another overhyped promise.\n- B-3 (System): They distrust vague wellness claims, hard sells, and brands that skip the actual mechanism.\n\nDeep Wound: They fear being fooled again.\nIdentity Threat: \"I should know better than to buy another thing that does not work.\"\nFuture Terror: They keep researching forever but never find a solution they trust enough to try.\n\nLanguage Patterns: what actually causes this, why did nothing work, I need the reason, what makes this different, I do not want another gimmick\nMetaphors: missing piece, root of the loop, signal under the noise, finally connected the dots\n\nFailed Solutions:\n- Trend-based products: Too much promise, not enough mechanism.\n- Advice content: Explains the problem but gives no usable next step.\n`;
}

function starterHotwords(input: {
  productName: string;
  problem: string;
  mechanism: string;
  guarantee: string;
  price: number;
}): string {
  const { productName, problem, mechanism, guarantee, price } = input;
  return `# ${productName} Starter Hotwords\n\n> Auto-generated from product details. Replace with mined customer language when research is available.\n\n## A1: Current Problem Language\n\nPrimary identifiers:\n- Tired of dealing with ${problem}\n- I keep trying things and the problem keeps coming back\n- Nothing seems to last\n- I just want this to stop being part of my daily routine\n- I hate how much mental space this takes\n- It is embarrassing how often I think about it\n- I want to feel normal again\n\nSupporting phrases:\n- Why does this keep happening\n- I have tried the obvious fixes\n- It feels like a cycle\n- I am exhausted by the maintenance\n- I need something that actually addresses the reason\n\n---\n\n## A2: Timing and Frustration Language\n\nPrimary identifiers:\n- I thought this would be solved by now\n- It keeps getting harder to ignore\n- I am tired of wasting money\n- I do not want another temporary fix\n- I am ready to try something that makes sense\n\nSupporting phrases:\n- I kept putting it off\n- I finally started looking for a better answer\n- I do not want to keep guessing\n\n---\n\n## B1: Mechanism Suspicion Language\n\nPrimary identifiers:\n- Maybe the usual fixes only handle the surface\n- Maybe there is a deeper reason this keeps coming back\n- The old approach never changed the loop\n- I need to understand what is actually happening\n- ${mechanism}\n\nSupporting phrases:\n- That explains why nothing lasted\n- I never heard it explained that way\n- It finally makes sense\n- This is different from just covering it up\n\n---\n\n## B2: Desired Identity Language\n\nPrimary identifiers:\n- I want to feel in control again\n- I want to stop planning around ${problem}\n- I want to trust what I am using\n- I want a routine that feels simple\n- I want to feel like myself again\n\nSupporting phrases:\n- Less stress every day\n- More confidence leaving the house\n- Not constantly checking\n- Not feeling behind or broken\n\n---\n\n## B3: Trust and Offer Language\n\nPrimary identifiers:\n- I do not want another gimmick\n- I need a clear explanation before I try it\n- I want to know why it is different\n- $${formatPrice(price)} feels easier to try than another round of failed fixes\n- The ${guarantee} guarantee makes it feel less risky\n\nSupporting phrases:\n- No hard sell\n- Just explain it clearly\n- I want the real reason\n- I need the next step to feel safe\n`;
}

function starterMechanisms(input: {
  productName: string;
  brand: string;
  problem: string;
  target: string;
  mechanism: string;
}): string {
  const { productName, brand, problem, target, mechanism } = input;
  return `# ${productName} Starter Mechanisms\n\n> Auto-generated from product details. Replace with approved mechanism research before scaling spend.\n\n## M1: The Root Loop Break\n\n### Core Insight\nThe usual fixes disappoint because they mostly manage the visible problem. ${productName} is positioned around interrupting the loop that keeps ${problem} coming back.\n\n### The Problem\n\nWhat they believe: ${target} often believe they just need a stronger, stricter, or more expensive version of what they already tried.\n\nReal cause: ${mechanism}. When that underlying loop is ignored, the person keeps repeating short-term fixes and blaming themselves when the problem returns.\n\nThe Metaphor: It is like wiping water from the floor while the faucet is still running. You can make the surface look better for a moment, but the loop continues until the source is addressed.\n\n### Why Current Solutions Don't Work\n\nWhat they tried: Generic routines, surface fixes, advice content, trend products, and willpower-based approaches.\n\nWhy it fails: Those approaches can reduce the immediate frustration, but they do not explain or interrupt the repeating pattern. The person gets a temporary win, then the same problem comes back and feels even more discouraging.\n\n### The Solution - ${brand}\n\n${productName} gives the viewer a new explanation: the problem is not a personal failure; it is a loop that needs a different kind of intervention. The product should be presented as a simple next step built around this mechanism, not as a miracle cure.\n\n### Verbatim Copy for Ads\n\nMost people keep trying to fix ${problem} at the surface.\n\nSo they get a little relief... and then the same thing comes back.\n\nThat is because the loop underneath never changed.\n\n${mechanism}.\n\nThat is the part ${productName} is built around. Not another complicated routine. Not another vague promise. A different way to think about why the old fixes did not last.\n\n### Aha Statements\n\nShort: \"You were not failing. You were fixing the visible part while the loop underneath kept running.\"\n\nMedium: \"The old fixes focused on the surface. ${productName} is built around the mechanism that keeps the problem repeating.\"\n\nFull: \"When ${problem} keeps coming back, the problem is usually not effort. It is that the underlying loop never changed. ${productName} reframes the issue around that loop so the next step finally feels logical.\"\n`;
}

function sectionCodes(markdown: string, prefix: string): string[] {
  const re = new RegExp(`^##\\s+(${prefix}\\d+)\\b`, "gim");
  return [...markdown.matchAll(re)].map((match) => match[1].toUpperCase());
}

function productNameFromConfig(config: Record<string, unknown>, productFolder: string): string {
  return (
    stringValue(config.product_name) ||
    stringValue(config.name) ||
    stringValue(config.brand) ||
    productFolder ||
    "Product"
  );
}

function problemFromConfig(config: Record<string, unknown>, productName: string): string {
  return (
    stringValue(config.problem) ||
    stringValue(config.condition) ||
    stringValue(config.target_condition) ||
    stringValue(config.pain_point) ||
    targetFromConfig(config) ||
    `the core problem ${productName} is meant to solve`
  );
}

function targetFromConfig(config: Record<string, unknown>): string {
  const demo = config.target_demographic;
  if (isRecord(demo)) {
    return (
      stringValue(demo.description) ||
      [stringValue(demo.gender), stringValue(demo.age_range)].filter(Boolean).join(" ") ||
      ""
    );
  }
  return stringValue(config.target_customer) || stringValue(config.target) || "people dealing with this problem";
}

function mechanismFromDetails(config: Record<string, unknown>, productName: string): string {
  const mechanisms = config.mechanisms;
  if (isRecord(mechanisms)) {
    const firstKey = Object.keys(mechanisms).find((key) => /^M\d+$/i.test(key));
    if (firstKey) {
      const value = mechanisms[firstKey];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (isRecord(value)) {
        return stringValue(value.description) || stringValue(value.core_insight) || stringValue(value.name) || `${productName} works through the selected product mechanism.`;
      }
    }
  }
  return (
    stringValue(config.mechanism) ||
    stringValue(config.core_mechanism) ||
    stringValue(config.unique_mechanism) ||
    `${productName} targets the underlying loop instead of only covering the surface symptom`
  );
}

function priceFromConfig(config: Record<string, unknown>): number | null {
  const pricing = config.pricing_rules;
  if (isRecord(pricing)) {
    const value = numericValue(pricing.single_bag_price_usd);
    if (value !== null) return value;
  }
  return numericValue(config.price);
}

function formatPrice(price: number): string {
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasPricingRules(config: Record<string, unknown>): boolean {
  const pricing = config.pricing_rules;
  return isRecord(pricing) && numericValue(pricing.single_bag_price_usd) !== null;
}

function hasOfferArchitecture(config: Record<string, unknown>): boolean {
  const offer = config.offer_architecture;
  return isRecord(offer) && Boolean(stringValue(offer.guarantee_framing));
}

function hasTargetDemographic(config: Record<string, unknown>): boolean {
  return isRecord(config.target_demographic);
}

function hasMechanism(config: Record<string, unknown>): boolean {
  const mechanisms = config.mechanisms;
  return isRecord(mechanisms) && Object.keys(mechanisms).some((key) => /^M\d+$/i.test(key));
}
