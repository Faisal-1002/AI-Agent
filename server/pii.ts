// Deterministic personal-data detection: a second, independent layer next to the ML guard.
//
// Found by testing: Qwen3Guard 0.6B flagged a bare "name, address, phone, SSN" row as PII,
// but rated the SAME data Safe once it sat inside a longer explanation. Small classifiers
// can be distracted by context; a pattern can't. Rules catch the high-certainty cases,
// the model catches what rules can't express — that's defense in depth.
//
// Kept to high-signal patterns only (emails and phone numbers alone are too common in
// normal replies and would flag constantly).

const SSN = /\b\d{3}-\d{2}-\d{4}\b/; // US social security number format
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g; // 13–19 digits, optional spaces/dashes

// Luhn checksum: real payment card numbers pass it, random digit runs mostly don't.
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Which kinds of personal data appear in the text (empty if none).
export function findPII(text: string): string[] {
  const found: string[] = [];
  if (SSN.test(text)) found.push("social security number");
  const cards = [...text.matchAll(CARD_CANDIDATE)].map((m) => m[0].replace(/[ -]/g, ""));
  if (cards.some((c) => c.length >= 13 && luhnValid(c))) found.push("payment card number");
  return found;
}
