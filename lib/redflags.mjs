// Frozen safety node — the deterministic red-flag detector.
//
// This is intentionally hardcoded, keyword-driven logic, NOT a prompt the LLM
// can re-interpret. It is the "frozen rule the optimizer cannot relax":
// if any pattern matches, the downstream agent is FORCED to EMERGENCY and to
// an explicit escalation message, regardless of what the model outputs.
//
// Accuracy of these patterns is conservative by design: false-positive
// "go to the ER" is an acceptable safety trade-off; a missed emergency is not.

export const RED_FLAG_CATEGORIES = [
  {
    id: "acs-chest-pain",
    label: "Possible acute coronary syndrome",
    patterns: [
      /crush(?:ing)?\s+(?:chest|substernal)\s+pain/i,
      /chest\s+(?:pain|pressure|tightness|heaviness)/i,
      /pain\s+(?:radiating|spreading)\s+to\s+(?:the\s+)?(?:left\s+)?(?:arm|jaw|neck|shoulder)/i,
      /(?:left[- ]sided\s+)?chest\s+pain\s+(?:and|with)\s+(?:shortness|sob|dyspnea|breath)/i,
    ],
  },
  {
    id: "stroke-fast",
    label: "Stroke warning signs (F.A.S.T.)",
    patterns: [
      /face\s+(?:is\s+)?(?:droop|drooping|numb)/i,
      /(?:can'?t|cannot)\s+(?:move|lift|raise)\s+(?:my\s+)?(?:arm|face)/i,
      /(?:slurred|mumbled|garbled)\s+(?:speech|talking)/i,
      /one\s+(?:side\s+of\s+(?:the\s+)?(?:face|body)|arm|leg)\s+(?:is\s+)?(?:numb|weak|drooping)/i,
    ],
  },
  {
    id: "anaphylaxis",
    label: "Possible anaphylaxis",
    patterns: [
      /(?:throat\s+(?:is\s+)?(?:closing|swelling|tight)|can'?t\s+(?:swallow|breathe))/i,
      /(?:lips|tongue|face|eyes)\s+(?:are\s+)?(?:swelling|swollen|puffed)/i,
      /anaphylax/i,
      /(?:hives|urticaria)\s+(?:and|with)\s+(?:wheez|shortness|breath|dizzy|faint)/i,
    ],
  },
  {
    id: "severe-respiratory-distress",
    label: "Severe respiratory distress",
    patterns: [
      /can'?t\s+(?:breathe|catch\s+(?:my\s+)?breath)/i,
      /gasping\s+for\s+(?:air|breath)/i,
      /turning\s+(?:blue|pale|gray)/i,
      /(?:severe|really\s+bad)\s+(?:shortness|sob|dyspnea|difficulty\s+breathing)/i,
    ],
  },
  {
    id: "pulmonary-embolism",
    label: "Possible pulmonary embolism",
    patterns: [
      /sudden\s+(?:shortness|sob|dyspnea|chest\s+pain)\s+(?:and|with)\s+(?:coughing\s+up\s+blood|hemoptysis|calf\s+pain|leg\s+swell)/i,
      /coughing\s+up\s+blood/i,
    ],
  },
  {
    id: "suicidal-ideation",
    label: "Suicidal ideation / self-harm",
    patterns: [
      /(?:want|thinking)\s+to\s+(?:kill|hurt|end)\s+(?:myself|me)/i,
      /(?:suicid|kill\s+myself|end\s+(?:it\s+all|my\s+life|hurting\s+myself))/i,
      /(?:no\s+reason|don'?t\s+want)\s+to\s+(?:live|be\s+(?:alive|here))/i,
    ],
  },
  {
    id: "sepsis",
    label: "Possible sepsis",
    patterns: [
      /(?:shaking\s+chills?|rigors)\s+(?:and|with)\s+(?:confusion|rapid\s+(?:breathing|heart))/i,
    ],
  },
  {
    id: "meningitis",
    label: "Possible meningitis",
    patterns: [
      /stiff\s+neck\s+(?:and|with)\s+(?:fever|headache|light)/i,
      /worst\s+(?:headache|pain)\s+(?:of|in)\s+(?:my\s+)?life/i,
      /(?:thunderclap|worst[- ]ever)\s+headache/i,
    ],
  },
  {
    id: "thunderclap-headache",
    label: "Thunderclap headache (subarachnoid hemorrhage risk)",
    patterns: [
      /thunderclap\s+headache/i,
    ],
  },
  {
    id: "hypertensive-emergency",
    label: "Hypertensive emergency",
    patterns: [
      /(?:chest\s+pain|blurred\s+vision|severe\s+headache|numbness|confusion)\s+(?:and|with)\s+(?:high|elevated|really\s+high)\s+(?:blood\s+pressure|bp)/i,
    ],
  },
  {
    id: "gi-bleed",
    label: "Acute gastrointestinal bleeding",
    patterns: [
      /vomit(?:ing)?\s+blood/i,
      /(?:coughing|throwing)\s+up\s+blood/i,
      /(?:black|tarry)\s+(?:stool|poop)/i,
      /(?:large\s+amount|lots)\s+of\s+blood\s+(?:in|from)\s+(?:my\s+)?(?:stool|rectum)/i,
    ],
  },
  {
    id: "cauda-equina",
    label: "Cauda equina syndrome",
    patterns: [
      /(?:can'?t|cannot)\s+(?:urinate|pee|control\s+(?:my\s+)?(?:bladder|bowel))/i,
      /(?:numbness|loss\s+of\s+feeling)\s+(?:in|around)\s+(?:my\s+)?(?:groin|saddle|genitals|butt)/i,
    ],
  },
  {
    id: "ectopic-pregnancy",
    label: "Possible ectopic pregnancy",
    patterns: [
      /(?:severe|sharp)\s+(?:pelvic|abdominal|belly)\s+pain\s+(?:and|with)\s+(?:vaginal\s+(?:bleeding|spotting)|dizziness|shoulder)/i,
    ],
  },
  {
    id: "dka",
    label: "Possible diabetic ketoacidosis",
    patterns: [
      /(?:fruity|sweet)\s+(?:breath|smell)\s+(?:and|with)\s+(?:vomit|confus|stomach\s+pain)/i,
    ],
  },
];

const ESCALATION_TEXT =
  "This may be a medical emergency. Call 911 (or your local emergency number) now — do not drive yourself if alone.";

export function detectRedFlags(text) {
  const input = String(text ?? "");
  const matched = [];
  const seen = new Set();
  for (const cat of RED_FLAG_CATEGORIES) {
    for (const pattern of cat.patterns) {
      if (pattern.test(input)) {
        if (!seen.has(cat.id)) {
          matched.push({ id: cat.id, label: cat.label });
          seen.add(cat.id);
        }
        break;
      }
    }
  }
  return {
    matched,
    forceEmergency: matched.length > 0,
    escalation: matched.length > 0 ? ESCALATION_TEXT : null,
  };
}
