# LFS Briefing Template

Every LFS V3 per-script prompt at `batches/{BATCH}/prompts/{TASK_ID}.md` follows this structure. Fixed headers. Fixed order. Fills slots instead of composing prose.

Every file starts with strict frontmatter:

```yaml
---
task_id: PRODUCT_LFS_ARC1_A1B1_M1_May5
concept: concept_code_or_lane_name
strategist: strategist_name
product: PRODUCT
format: lfs
---
```

`ww preflight` hard-fails missing keys, mismatched task/product/format, duplicate concepts, duplicate hooks, duplicate dated logs, placeholders like `[insert pain]`, unfinished markers like TODO/TK, and non-canonical prices.

This template is the **technique layer** of the three-layer LFS system:

| Layer | File | Scope |
|---|---|---|
| **Philosophy** | `components/lfs-prompt-engine.md` | How LFS works. Universal. |
| **Technique** | This template (filled per script) | How THIS script executes the philosophy. |
| **Research** | `products/{PRODUCT}/research/` + `config.json` | Archetype voice, mechanisms, canonical pricing. |

The briefing is the only piece that varies per script. Keeping it structured means the model sees the same slots in the same order every time, and the writer commits to the hardest parts (opener, bridge, log, P.S.) in writing instead of describing them.

---

## Two Kinds of Slots

**VERBATIM slots** — the writer writes the actual copy. The model transcribes these lines into the script unchanged. These lock the hard parts of the script so the model can't hallucinate around them.

**DIRECTIVE slots** — the writer specifies parameters and constraints. The model interprets these and writes the surrounding prose around them.

Verbatim slots come first in the template (they're the commitment layer). Directive slots follow.

---

## The Schema

```markdown
## ANGLE
[Script identity — one phrase. Example: "Your Wormwood Worked" / "Ozempic Face, Puffy Belly" / "The Dermatologist Who Shrugged"]

## OPENER PATTERN
[A / B / C — A=Staged Scene, B=Authority Insider, C=Counter-Frame. See lfs-prompt-engine.md Principle #1.]

## INTENSITY
[Very High / High / Medium / Low]

## PERSONA
[The narrator's identity in experiential specifics, not credentials. Who they are, where they live, the specific situation that gives them standing to tell this story.]

## VERBATIM HOOK (≤3 sentences — copied into script as opener)
[Write the first 1-3 sentences of the ad here. The model uses these literally as the opening. Must satisfy the chosen opener pattern + at least 2 dogwhistles.]

## VERBATIM BRIDGE PHRASE (pain → mechanism transition)
[Pick one from the canonical set and write it verbatim:
  "Here's what no doctor will tell you straight..."
  "Here's the part nobody put in your paperwork..."
  "Here's what I didn't know yet..."
  "Here's the part that made my stomach drop when I read it..."
  "Then I found the research that changed everything..."]

## VERBATIM DATED LOG (6-8 entries — copied into script as the transformation section)
[Write each entry as the narrator would type it. Specific observations tied to specific days or weeks. Include at least one entry where a named witness notices the change.]
- Day X: [observation]
- Day X: [observation]
- Week X: [observation]
- Week X: [observation with partner/family/friend noticing]
- Month X: [resolution]

## VERBATIM P.S.
[Day-count since last symptom, OR a peer-cascade update. Example: "It's been 214 days since my last flare-up." OR "My sister started three weeks ago. She texted me last night crying."]

## VERBATIM P.P.S.
[Two-futures frame. Example: "Six months from now one of two things will be true — either you [outcome A] or you [outcome B]. The only difference is the decision you make today."]

---

## DOGWHISTLES (plant ≥2 in first 150 words)
[Specify which types + exact content. See lfs-prompt-engine.md Principle #1 for the 6 types.]
- [Type]: [specific content]
- [Type]: [specific content]

## FAILED SOLUTIONS (dismantle individually)
[Each failed attempt with price, duration, outcome, and dismissive quote if a professional was involved. See 2a in engine.]
1. Product/approach: [name] — $[price] from [retailer], [duration] — outcome: [what happened]
   Dismissive quote: "[exact line]" (if applicable)
2. Product/approach: [name] — $[price] from [retailer], [duration] — outcome: [what happened]
3. Product/approach: [name] — $[price] from [retailer], [duration] — outcome: [what happened]

## MECHANISM LOCK
[Paste the full selected mechanism card here. This is the only mechanism allowed for this ad. Preserve the mechanism name and causal explanation nearly verbatim in the mechanism reveal. Angle, scene, wound, and format can change; mechanism cannot become a new theory.]

## PATTERN-INTERRUPT SCENE (mid-script — higher emotion than opener)
[A second staged scene with witness + timestamp + object. The emotional peak before the mechanism lands. 3-5 sentences describing what to stage — the model writes the prose.]

## INDUSTRY-SUPPRESSION BEAT (directive — model writes it)
[One-sentence frame: WHY this wasn't told sooner. Structural incentive, not conspiracy. The model expands into a short paragraph. Example frames:
  "There's no money in curing [condition] — only in treating it forever."
  "If men got this, there'd be 10 FDA-approved cures by now."
  "By the time you can see it on the scan, the damage is already severe."]

## PERMISSION BEAT (3-4 "if you" conditions stacked)
[Each condition is a specific reader behavior or feeling. Close with a permission-granting command. See 5a.4 in engine.]
- If you [specific reader condition]
- If you [specific reader condition]
- If you [specific reader condition]
- [Command: "Listen to me." / "You're not broken." / "Hear me out."]

## FORBIDDEN FOR THIS ANGLE
[Angle-specific compliance flags. Example: "no weight-loss claims" / "don't name pharma brands — use 'the shot' / 'the medication'" / "never suggest stopping the prescription"]

## CROSS-REFERENCES
- Product config: products/{PRODUCT}/config.json (canonical pricing, archetypes, mechanisms)
- Research: products/{PRODUCT}/research/probe-signals.md (verbatim archetype language)
```

---

## Field-Level Guidance (the three that fail most)

### VERBATIM HOOK — the commitment

This is the single most important slot. Most failed LFS happen because the writer DESCRIBED the hook instead of WRITING it. "Opening scene: the parking lot moment with the husband" is a description. The model invents its own version — usually analytical, usually stated. Writing the actual lines forces scenic specificity.

**Near-miss (stated wound):**
> "I spent $300 on parasite cleanses that did nothing. Here's why every one of them was doomed to fail."

**Winner (staged scene):**
> "I sat in my car outside the health food store last October and cried for twenty minutes. My husband had asked that morning if I was pregnant again because of how my belly looked in the new dress. I'd just spent another fifty dollars we didn't have on a fourth bottle I already knew wouldn't work."

The first version is what the model writes when the briefing describes the hook. The second is what the model transcribes when the briefing hands it the lines. Write the winner.

#### Primal Recognition gate — the first sentence MUST satisfy this

The full principle lives in `components/dr-opener-primal-recognition.md`. Read it once before writing your first VERBATIM HOOK; it has 5 niches × 3-grade contrastive pairs and the 6-question checklist.

**The rule for clause one:** the literal noun for the wound — the keyword the reader types into Google at 3am — has to appear in the first sentence. Not the second. Not implied. Not symbolized. The actual word.

**Why:** the reader is on their phone in bed at 11:47 PM. Half a second of cognition. Pattern-matching, not reading. The brain looks for the word for *me*. Scene-led openers get parsed too late and the thumb has already swiped.

**6-question checklist — every VERBATIM HOOK must answer YES to all of these:**

1. Is the literal wound noun in clause one? (mice, droppings, fifteen pounds, knees, panic attacks, can't get hard, hair, bald spots, joint pain — the actual word)
2. Is there a specific number, count, or named location? (three times this month, hole twelve, the parking lot, fifteen pounds, six in one weekend)
3. Would a friend at a kitchen table say it this way? (not essay-voice, not therapy-voice, not wisdom-voice)
4. If a stranger read only this sentence, would they know what the ad is selling against?
5. Does it avoid opening with a scene, a question, or a metaphor?
6. Is the sentence under 25 words?

Six yeses = ship. Any no = rewrite the VERBATIM HOOK before you put it in `prompts/{TASK_ID}.md`. The opener-check tool (`ww lfs-opener-check`) runs this rubric automatically at the end of generation, but catching it here saves a patch pass.

**Three near-miss / winner pairs to internalize:**

| Niche | NEAR-MISS (scene-led, will FAIL) | WINNER (wound-noun, PASSES) |
|---|---|---|
| Mice | "I bleached my counters at 11. Three new droppings at 6." | "I found mouse droppings on the counter for the third morning in a row and I bleached it twice last night." |
| Hair loss | "My granddaughter brushed my hair last Sunday and stopped halfway through." | "The drain in my shower fills with my hair every morning and I am sixty-two years old." |
| ED | "Something changed in my marriage three years ago and we both stopped saying it out loud." | "I can't get hard the way I could three years ago and my wife has stopped trying to start things." |

The near-miss is *better writing* — and the wrong choice for cold traffic. The winner names the wound, gives a number, sounds like a peer, and lets the scene unfold from sentence two onward.

**The override (rare):** Warm-traffic retargeting OR keyword-fatigue niches (postpartum weight, low T) can use a counter-frame opener that *deliberately* withholds the keyword. If you are not certain you are in an override case, write keyword-first. Default is wound-noun-in-clause-one.

### VERBATIM DATED LOG — the texture

Writing abstract entries ("Day 14: felt better") gets generic output. Writing concrete observations with sensory or social detail gets output that reads like a real diary.

**Near-miss (generic):**
> - Week 2: brain fog lifting
> - Week 4: energy returning
> - Week 8: feel like myself again

**Winner (concrete + witnessed):**
> - Day 9: something in the toilet I couldn't identify. My husband walked in. Said "Jesus." Flushed before I could photograph it.
> - Week 2: full workday without the 3pm crash. A coworker asked if I was drinking a new kind of coffee.
> - Week 5: wore a dress I'd given up on. It fit from morning to evening.
> - Week 8: walked past the pantry at 10pm and didn't even think about food.

Each entry carries a moment. At least one entry includes a named witness noticing.

### PERMISSION BEAT — the activation

Writing one "if you" condition produces a soft close. Stacking 3-4 produces the winner's drumbeat.

**Near-miss (single):**
> If you've tried parasite cleanses before, this is for you.

**Winner (stacked):**
> If you've spent hundreds on parasite cleanses that went nowhere. If your husband has stopped asking how the latest bottle is going. If you've almost thrown out the next bottle before even starting it. If you're reading this wondering whether you're chasing a problem that doesn't exist. Listen to me.

Each "if you" is a specific reader behavior. The final command lands the permission.

---

## Pre-Submission Check

Before committing a per-task prompt to `batches/{BATCH}/prompts/{TASK_ID}.md`, the writer answers:

1. Does the **VERBATIM HOOK** include a named witness, timestamp, location, or body-horror object? (At least 2 of 4.)
2. Does it include ≥2 dogwhistles from the engine's 6 types?
3. Does the **DATED LOG** have ≥6 entries, ≥1 of which includes a named witness noticing?
4. Does the **PERMISSION BEAT** stack ≥3 "if you" conditions?
5. Does the **FAILED SOLUTIONS** list include ≥2 quoted dismissive professional lines?
6. Is **Auvra-style pricing** (or whatever product's canonical price) absent from failed-solution slots? (Canonical pricing comes from config, not from briefings.)

If any answer is "no," fix the briefing before generation. The engine cannot recover from a briefing that doesn't commit to its verbatim copy.

---

## Integration with the Engine

The briefing is CRITICAL OVERRIDE context that gets prepended to the LFS prompt at generation time. The engine's Principle #1 (Hook) reads the VERBATIM HOOK slot and uses it literally. Principle 2a reads the quoted dismissive lines in FAILED SOLUTIONS. Principle 3a reads the VERBATIM BRIDGE PHRASE. Principle 5a reads the VERBATIM DATED LOG, PATTERN-INTERRUPT SCENE, INDUSTRY-SUPPRESSION BEAT, PERMISSION BEAT, P.S., and P.P.S.

Every slot in the template maps to a specific engine section. Filling the template correctly means the engine's behavior is locked into specific copy the writer already approved.

---

## A Worked Example

Stored at `components/lfs-briefing-examples/AUVRA_ARC2_wormwood_worked.md` — a fully-filled briefing for ARC2 V001, ready to copy into `prompts/{TASK_ID}.md` as a reference when writing new briefings.
