// Questions about the user's files or documents always think first, whatever the Think
// toggle says. Measured with scripts/ask.ts: without thinking, the 9B often answered them
// from file NAMES alone — or invented a document; with thinking it looked them up every time.
// "About the user's files" = "my/the/attached … document", a file name, or the workspace —
// not any mention of the word ("how do I read a file in Python" stays fast). Arabic: whole
// words, with or without "ال" / a possessive ending ("ملفت" = eye-catching doesn't count).
const NEEDS_LOOKUP = new RegExp(
  [
    String.raw`\b(my|the|this|these|those|attached|uploaded|our)\s+(\w+\s+)?(documents?|docs?|files?|pdfs?|uploads?|attachments?|contracts?|cv|resume|reports?|spreadsheets?|notes|slides?)\b`,
    String.raw`\b\w[\w-]*\.(md|txt|pdf|docx?|csv|json|html?|xlsx?)\b`,
    String.raw`\bworkspace\b`,
    String.raw`(^|[\s،,.؟?!:])(ال)?(ملف|ملفات|مستند|مستندات|وثيقة|وثائق)(ي|ك|نا)?($|[\s،,.؟?!:])`,
  ].join("|"),
  "i",
);
export const shouldThink = (requested: boolean, text: string) => requested || NEEDS_LOOKUP.test(text);
