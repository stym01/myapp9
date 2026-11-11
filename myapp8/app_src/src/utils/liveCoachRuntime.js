"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

// Live Coach model contract:
// - Provider/model selection is enforced server-side (/live-coach worker).
// - Client enforces JSON shape + basic word budgets, but must not inject "coaching templates".
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_QUESTION_MAX_WORDS = 26;
const DEFAULT_FIRST_SENTENCE_MAX_WORDS = 24;
const DEFAULT_OUTLINE_MAX_WORDS = 20;
const DEFAULT_DONT_MISS_MAX_WORDS = 18;
const MIN_TALKING_POINTS = 3;
const MAX_TALKING_POINTS = 4;
// Keep client aborts above the worker's own overall budgets so slow-but-valid
// worker responses are not killed in the final network/serialization margin.
const LIVE_COACH_INTENT_REQUEST_TIMEOUT_MS = 5000;
const LIVE_COACH_CARDS_REQUEST_TIMEOUT_MS = 9500;
const LIVE_COACH_CODING_CARDS_REQUEST_TIMEOUT_MS = 12500;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeWhitespace(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function tokenizeSemantic(value) {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return [];
  return raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

function semanticTokenSet(value) {
  return new Set(tokenizeSemantic(value));
}

function safeTrimLocal(value, maxChars = 0, side = "both") {
  const text = typeof value === "string" ? value : "";
  const max = Number(maxChars);
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  if (side === "start") return `…${text.slice(text.length - max + 1)}`;
  if (side === "end") return `${text.slice(0, max - 1)}…`;
  const head = Math.max(1, Math.floor((max - 1) / 2));
  const tail = Math.max(1, max - 1 - head);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function trimWholeWordsEndLocal(value, maxChars = 0) {
  const text = normalizeWhitespace(value);
  const max = Number(maxChars);
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  const words = text.split(" ").filter(Boolean);
  let out = "";
  for (const word of words) {
    const candidate = out ? `${out} ${word}` : word;
    if (candidate.length > max) break;
    out = candidate;
  }
  if (!out) return safeTrimLocal(text, max, "end").replace(/…$/, "").trim();
  return out.trim();
}

function stripCodeFences(text) {
  const t = typeof text === "string" ? text : "";
  return t
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function extractFirstJsonObject(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return null;

  const coerceJsonLike = (candidate) => {
    const c = typeof candidate === "string" ? candidate.trim() : "";
    if (!c) return "";
    const clipped = c.length > 20000 ? c.slice(0, 20000) : c;
    if (!clipped.includes("{") || !clipped.includes("}")) return "";

    let t = clipped.replace(/[“”]/g, '"').replace(/[’]/g, "'").trim();
    t = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
    t = t.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner) => {
      const safe = String(inner || "").replace(/"/g, '\\"');
      return `"${safe}"`;
    });
    t = t.replace(/:\s*\.(\d)/g, ": 0.$1");
    t = t.replace(
      /("action"\s*:\s*)(start_new_question|refine_current|ignore)(\s*[,}])/g,
      '$1"$2"$3',
    );
    t = t.replace(
      /("questionType"\s*:\s*)(behavioral|system_design|coding|other)(\s*[,}])/g,
      '$1"$2"$3',
    );
    t = t.replace(
      /("question_type"\s*:\s*)(behavioral|system_design|coding|other)(\s*[,}])/g,
      '$1"$2"$3',
    );
    t = t.replace(/,(\s*[}\]])/g, "$1");
    return t;
  };

  const tryParse = (candidate) => {
    const c = stripCodeFences(typeof candidate === "string" ? candidate.trim() : "");
    if (!c) return null;
    const coerced = coerceJsonLike(c);
    const attempts = [
      c,
      c.replace(/,(\s*[}\]])/g, "$1"),
      ...(coerced ? [coerced, coerced.replace(/,(\s*[}\]])/g, "$1")] : []),
    ];
    for (const attempt of attempts) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed)) {
            const firstObj = parsed.find(
              (x) => x && typeof x === "object" && !Array.isArray(x),
            );
            if (firstObj) return firstObj;
            continue;
          }
          return parsed;
        }
      } catch (_) { }
    }
    return null;
  };

  const findFragments = (input, limit = 5) => {
    const out = [];
    const t = typeof input === "string" ? input : "";
    if (!t) return out;
    for (
      let start = t.indexOf("{");
      start !== -1 && out.length < limit;
      start = t.indexOf("{", start + 1)
    ) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < t.length; i++) {
        const ch = t[i];
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === "\\") {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
            continue;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{") depth++;
        if (ch === "}") {
          depth--;
          if (depth === 0) {
            out.push(t.slice(start, i + 1));
            break;
          }
        }
      }
    }
    return out;
  };

  const candidates = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match = null;
  while ((match = fenceRe.exec(s)) && candidates.length < 4) {
    const inner = (match[1] || "").trim();
    if (inner) candidates.push(inner);
  }
  candidates.push(s);

  const parsedCandidates = [];
  const seen = new Set();
  for (const cand0 of candidates) {
    const cand = typeof cand0 === "string" ? cand0.trim() : "";
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);

    const direct = tryParse(cand);
    if (direct) parsedCandidates.push(direct);

    for (const frag of findFragments(cand)) {
      const parsed = tryParse(frag);
      if (parsed) parsedCandidates.push(parsed);
    }
  }
  if (parsedCandidates.length === 0) return null;

  const score = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return -1;
    const outline =
      obj.outline ?? obj.plan ?? obj.steps ?? obj.skeleton ?? obj.outline_points;
    const outlineOk =
      (Array.isArray(outline) && outline.filter(Boolean).length > 0) ||
      (typeof outline === "string" && outline.trim().length > 0);
    const questionOk =
      (typeof obj.question === "string" && obj.question.trim()) ||
      (typeof obj.canonicalQuestion === "string" && obj.canonicalQuestion.trim()) ||
      (typeof obj.whatTheyreAsking === "string" && obj.whatTheyreAsking.trim()) ||
      (typeof obj.what_theyre_asking === "string" && obj.what_theyre_asking.trim());

    let n = 0;
    if (outlineOk) n += 5;
    if (questionOk) n += 3;
    if (typeof obj.action === "string") n += 2;
    if (typeof obj.confidence === "number") n += 1;
    return n;
  };

  let best = parsedCandidates[0];
  let bestScore = score(best);
  for (let i = 1; i < parsedCandidates.length; i++) {
    const cand = parsedCandidates[i];
    const sc = score(cand);
    if (sc > bestScore) {
      best = cand;
      bestScore = sc;
    }
  }
  return best;
}

function extractChatCompletionTextPayload(json) {
  const choice0 = json?.choices?.[0];
  const finishReason =
    choice0?.finish_reason || choice0?.finishReason || json?.finish_reason || "";
  const message0 = choice0?.message || {};

  const candidates = [];
  const add = (source, value) => {
    if (typeof value === "string" && value.trim()) {
      candidates.push({ source, value });
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const v =
        typeof value.text === "string"
          ? value.text
          : typeof value.content === "string"
            ? value.content
            : typeof value.value === "string"
              ? value.value
              : typeof value.output_text === "string"
                ? value.output_text
                : "";
      if (typeof v === "string" && v.trim()) {
        candidates.push({ source: `${source}.object`, value: v });
      }
    }
    if (Array.isArray(value)) {
      const joined = value
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            if (typeof part.text === "string") return part.text;
            if (typeof part.content === "string") return part.content;
            if (typeof part.value === "string") return part.value;
            if (typeof part.output_text === "string") return part.output_text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      candidates.push({ source: `${source}[]`, value: joined });
    }
  };

  // Tool-call style responses (content may be empty). Prefer these when present.
  if (Array.isArray(message0?.tool_calls)) {
    for (const tc of message0.tool_calls) {
      const args = tc?.function?.arguments;
      if (typeof args === "string" && args.trim()) {
        candidates.push({
          source: "tool_calls.function.arguments",
          value: args,
        });
        break;
      }
    }
  }
  if (typeof message0?.function_call?.arguments === "string") {
    candidates.push({
      source: "function_call.arguments",
      value: message0.function_call.arguments,
    });
  }

  add("message.content", message0?.content);
  add("message.reasoning", message0?.reasoning);
  add("choice.text", choice0?.text);
  add("json.output_text", json?.output_text);

  const best = candidates.find((c) => typeof c.value === "string" && c.value.trim())
    ? candidates.find((c) => typeof c.value === "string" && c.value.trim())
    : candidates[0] || { source: "none", value: "" };

  return {
    text: typeof best?.value === "string" ? best.value : "",
    source: best?.source || "none",
    finishReason,
    choiceKeys: choice0 && typeof choice0 === "object" ? Object.keys(choice0) : [],
    messageKeys:
      message0 && typeof message0 === "object" ? Object.keys(message0) : [],
  };
}

function stripBulletPrefix(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  return s
    .replace(/^\s*(?:[-*•\u2022]|→|–|—)+\s*/g, "")
    .replace(/^\s*\d+[.)]\s+/g, "")
    .trim();
}

function tokenizeWords(text) {
  return normalizeWhitespace(text).split(" ").filter(Boolean);
}

function truncateToWordLimit(text, maxWords) {
  const max = Number.isFinite(Number(maxWords)) ? Math.max(1, Math.floor(Number(maxWords))) : 0;
  const words = tokenizeWords(text);
  if (!max || words.length <= max) return words.join(" ");
  return words.slice(0, max).join(" ");
}

function isLikelyInterviewerBackchannel(text) {
  const s = normalizeWhitespace(text).toLowerCase();
  if (!s) return true;
  if (tokenizeWords(s).length <= 2) {
    if (/^(?:yes|yeah|yep|ok|okay|alright|right|sure|mm|mmhmm|uh huh|got it|exactly|correct)\b/.test(s)) {
      return true;
    }
  }
  return /^(?:yes|yeah|yep|ok|okay|alright|right|sure|mm|mmhmm|uh huh|got it|exactly|correct)[.!?]*$/i.test(
    s,
  );
}

function flattenMergedQuestionForDisplay(value) {
  const s = normalizeWhitespace(value);
  if (!s) return "";
  if (!s.includes(";")) return s;
  const parts = s
    .split(/\s*;\s*/g)
    .map((p) => normalizeWhitespace(p))
    .filter(Boolean);
  if (parts.length <= 1) return s.replace(/;/g, " ");
  const head = parts[0].replace(/[?!.]+$/g, "").trim();
  const tailRaw = parts.slice(1).join(" and ").replace(/[?!.]+$/g, "").trim();
  if (!head || !tailRaw) return head || tailRaw || "";
  const tail =
    tailRaw.length >= 2
      ? `${tailRaw.charAt(0).toLowerCase()}${tailRaw.slice(1)}`
      : tailRaw.toLowerCase();
  return `${head} and ${tail}`.replace(/\s+/g, " ").trim();
}

function stripQuestionLeadIn(value) {
  let s = normalizeWhitespace(value);
  if (!s) return "";
  for (let i = 0; i < 3; i += 1) {
    const next = s
      .replace(/^(?:okay|ok|alright|all right|so|now|well|and so|and now)\b[\s,.:;!\-]*/i, "")
      .replace(
        /^(?:could|can|would)\s+you\s+(?:please\s+)?(?:just\s+)?(?:remind me(?: again)?|briefly|quickly)\s*[,:\-]*/i,
        "",
      )
      .replace(/^(?:please\s+)?(?:remind me(?: again)?|briefly|quickly)\s*[,:\-]*/i, "")
      .replace(/^(?:for starters|to start with|firstly|first)\s*[,:\-]*/i, "")
      .trim();
    if (!next || next === s) break;
    s = next;
  }
  return s;
}

function sanitizeQuestionLine(value, maxWords = DEFAULT_QUESTION_MAX_WORDS) {
  let s = normalizeWhitespace(value);
  if (!s) return "";
  s = stripBulletPrefix(s);
  s = s.replace(/^\s*["']+/, "").replace(/["']+\s*$/g, "");
  s = s.replace(/[“”]/g, '"').replace(/[’]/g, "'");
  s = stripQuestionLeadIn(s);
  s = s
    .replace(/\btell me about yourself question\b/gi, "tell me about yourself")
    .replace(/\btell me about\s+what['’]?s\b/gi, "tell me about")
    .replace(
      /\btell me about yourself and describe who are you\b/gi,
      "tell me about yourself, including who you are",
    )
    .replace(
      /\btell me about yourself and who are you\b/gi,
      "tell me about yourself, including who you are",
    )
    .replace(/\bwhat a difference between\b/gi, "what is the difference between")
    .replace(
      /\bwhat a ([a-z][^?!.]{0,80}\b(?:would|could|should|can|will|did|does|is|are|was|were)\b)/gi,
      "what $1",
    )
    .replace(/\btell me what a time when\b/i, "tell me about a time when")
    .replace(/\bwhat a time when\b/i, "about a time when")
    .replace(/\bwhich was the\b/gi, "what was the")
    .replace(/\bwhich was\b/gi, "what was");
  s = s
    .replace(/\boutput the json object now\b[\s\S]*$/i, "")
    .replace(/\breturn(?: exactly)?(?: one)? valid json(?: object)?(?: only)?\b[\s\S]*$/i, "")
    .replace(/\bstart with\s*["']?\{["']?\s*and end with\s*["']?\}["']?\b[\s\S]*$/i, "")
    .replace(/\blatest turn\s*\(\s*speaker\s*=\s*[^)]+\)\s*:\s*/gi, "")
    .replace(/\b(?:current canonical draft|canonical question|interviewer question(?: \(raw\))?|raw interviewer question|recent transcript|candidate context)\s*:\s*/gi, "")
    .replace(/\blanguage\s*:\s*[a-z][a-z -]{1,20}\b/gi, "")
    .trim();
  s = flattenMergedQuestionForDisplay(s);
  // Keep the first sentence-ish chunk; avoid carrying transcript blobs.
  const first = (s.match(/^[^.!?\n]+[.!?]?/u) || [])[0];
  if (first) s = normalizeWhitespace(first);
  s = stripQuestionLeadIn(s);
  s = flattenMergedQuestionForDisplay(s);
  s = truncateToWordLimit(s, maxWords);
  s = s.replace(/[,:;.\-–—]+$/g, "").trim();
  return s;
}

function mergeQuestionSummaryParts(lead, tail) {
  const head = stripTerminalPunctuation(lead);
  const follow = stripTerminalPunctuation(tail);
  if (!head || !follow) return head || follow || "";
  const tailLower =
    follow.length >= 2
      ? `${follow.charAt(0).toLowerCase()}${follow.slice(1)}`
      : follow.toLowerCase();
  if (/^and\b/i.test(follow)) return `${head} ${tailLower}`.trim();
  if (looksLikeQuestionTurn(head)) return `${head} and ${tailLower}`.trim();
  return `${head}, ${tailLower}`.trim();
}

function summarizeQuestionTurn(value, maxWords = DEFAULT_QUESTION_MAX_WORDS) {
  const raw = normalizeWhitespace(value);
  const fallback = sanitizeQuestionLine(raw, maxWords);
  if (!raw) return fallback;

  const parts = raw
    .split(/(?<=[.!?])\s+/u)
    .map((part) => normalizeWhitespace(stripTerminalPunctuation(part)))
    .filter(Boolean);
  if (parts.length < 2) return fallback;

  const tail = sanitizeQuestionLine(parts[parts.length - 1], maxWords);
  if (!tail || !isLikelyFollowupTurn(tail)) return fallback;

  const lead = normalizeWhitespace(
    parts
      .slice(0, -1)
      .map((part) => stripQuestionLeadIn(part))
      .map((part) => stripTerminalPunctuation(part))
      .filter(Boolean)
      .join(" "),
  );
  if (!lead) return fallback;

  const merged = mergeQuestionSummaryParts(lead, tail);
  if (!merged) return fallback;

  return truncateToWordLimit(merged, maxWords)
    .replace(/[,:;.\-–—]+$/g, "")
    .trim() || fallback;
}

function findPreviousQuestionContextTurn(
  recentTurns,
  candidateSpeaker,
  candidateText,
) {
  const turns = Array.isArray(recentTurns) ? recentTurns : [];
  const speaker = normalizeWhitespace(candidateSpeaker);
  const candidate = normalizeWhitespace(candidateText);
  if (!candidate || turns.length === 0) return "";

  const findMatch = ({ requireSameSpeaker }) => {
    let skippedCurrent = false;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (!turn || typeof turn !== "object") continue;
      const text = normalizeWhitespace(turn.text);
      const turnSpeaker = normalizeWhitespace(turn.speaker);
      if (!text) continue;
      if (requireSameSpeaker && speaker && turnSpeaker && turnSpeaker !== speaker) continue;
      if (
        !skippedCurrent &&
        (text === candidate || text.endsWith(candidate) || candidate.endsWith(text))
      ) {
        skippedCurrent = true;
        continue;
      }
      if (isLikelyInterviewerBackchannel(text)) continue;
      return text;
    }
    return "";
  };

  const sameSpeakerMatch = findMatch({ requireSameSpeaker: true });
  if (sameSpeakerMatch) return sameSpeakerMatch;
  return findMatch({ requireSameSpeaker: false });
}

function summarizeQuestionTurnWithRecentContext({
  candidateText,
  candidateSpeaker,
  recentTurns,
  maxWords = DEFAULT_QUESTION_MAX_WORDS,
}) {
  const summary = summarizeQuestionTurn(candidateText, maxWords);
  if (!summary) return "";
  if (!isLikelyFollowupTurn(summary)) return summary;

  const previousTurn = findPreviousQuestionContextTurn(
    recentTurns,
    candidateSpeaker,
    candidateText,
  );
  if (!previousTurn) return summary;

  const previousSummary = summarizeQuestionTurn(previousTurn, maxWords);
  if (!previousSummary || isLikelyFollowupTurn(previousSummary)) return summary;

  const merged = mergeQuestionSummaryParts(previousSummary, summary);
  if (!merged) return summary;

  const mergedSummary =
    truncateToWordLimit(merged, maxWords)
      .replace(/[,:;.\-–—]+$/g, "")
      .trim() || summary;
  if (!mergedSummary) return summary;
  return mergedSummary;
}

function looksLikeQuestionSummaryLine(value) {
  const s = normalizeWhitespace(value);
  if (!s) return false;
  if (s.includes("?")) return true;
  if (
    /^(?:describe|tell me|explain|walk me through|share|give(?: me)?(?: an)? example|what|why|how|who|which|when|where|do you|can you|could you|would you|have you|implement|design|build|create|debug|write|given|return)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/\bgiven\b[\s\S]{0,200}\breturn\b/i.test(s)) return true;
  return false;
}

function buildQuestionSummaryTokenList(value) {
  return tokenizeSemantic(value)
    .map((x) => normalizeTechnicalToken(x))
    .filter((x) => x && x.length >= 4 && !GROUNDING_STOPWORDS.has(x));
}

function isLikelyLengthTruncatedQuestionSummary(summary, sourceAsk) {
  const normalizeForComparison = (value) =>
    normalizeWhitespace(value).replace(
      /\b([a-z0-9]+)\.([a-z0-9]+)\b/gi,
      "$1$2",
    );
  const candidate = sanitizeQuestionLine(
    normalizeForComparison(summary),
    DEFAULT_QUESTION_MAX_WORDS,
  );
  const ask = sanitizeQuestionLine(
    normalizeForComparison(sourceAsk),
    DEFAULT_QUESTION_MAX_WORDS + 8,
  );
  if (!candidate || !ask) return false;

  const candidateNorm = stripTerminalPunctuation(candidate).toLowerCase();
  const askNorm = stripTerminalPunctuation(ask).toLowerCase();
  if (!candidateNorm || !askNorm || candidateNorm === askNorm) return false;

  const candidateTokens = buildQuestionSummaryTokenList(candidateNorm);
  const askTokens = buildQuestionSummaryTokenList(askNorm);
  if (candidateTokens.length === 0 || askTokens.length < 2) return false;

  const askSet = new Set(askTokens);
  const candidateSet = new Set(candidateTokens);
  let overlap = 0;
  for (const token of candidateTokens) {
    if (askSet.has(token)) overlap += 1;
  }
  if (overlap === 0) return false;

  let missing = 0;
  for (const token of askTokens) {
    if (!candidateSet.has(token)) missing += 1;
  }
  if (missing === 0) return false;

  if (
    /\bdifference between\b/i.test(candidateNorm) &&
    !/\band\b/i.test(candidateNorm) &&
    /\bdifference between\b/i.test(askNorm) &&
    /\band\b/i.test(askNorm)
  ) {
    return true;
  }

  const prefixLike =
    askNorm.startsWith(candidateNorm) ||
    candidateNorm.startsWith(askNorm) ||
    askNorm.includes(candidateNorm);
  if (prefixLike && missing >= 1 && candidateNorm.length + 8 < askNorm.length) {
    return true;
  }

  if (overlap === candidateTokens.length && askTokens.length >= candidateTokens.length + 1) {
    return true;
  }

  if (missing >= 2 && candidateNorm.length < askNorm.length * 0.78) {
    return true;
  }

  return false;
}

function shouldPromoteCandidateQuestionSummary({
  canonicalQuestion,
  candidateQuestion,
  confidence,
}) {
  const canonical = sanitizeQuestionLine(
    canonicalQuestion,
    DEFAULT_QUESTION_MAX_WORDS,
  );
  const candidate = normalizeWhitespace(candidateQuestion);
  if (!canonical || !candidate) return false;

  const canonicalNorm = stripTerminalPunctuation(canonical).toLowerCase();
  const candidateNorm = stripTerminalPunctuation(candidate).toLowerCase();
  if (!canonicalNorm || !candidateNorm || canonicalNorm === candidateNorm) {
    return false;
  }

  if (isLikelyFollowupTurn(canonical) && !isLikelyFollowupTurn(candidate)) {
    return true;
  }

  if (isLikelyLengthTruncatedQuestionSummary(canonical, candidate)) {
    if (confidence == null || confidence < 0.6) return true;
    return intentJaccard(canonical, candidate) <= 0.45;
  }

  if (confidence != null && confidence >= 0.35) return false;

  const canonicalTokens = buildQuestionSummaryTokenList(canonicalNorm);
  const candidateTokens = buildQuestionSummaryTokenList(candidateNorm);
  if (canonicalTokens.length === 0 || candidateTokens.length < 2) return false;

  return (
    candidateTokens.length >= canonicalTokens.length + 2 &&
    intentJaccard(canonical, candidate) <= 0.25
  );
}

const FIRST_PERSON_RE = /\b(?:i|i'm|i've|i'd|i'll|my|me|we|we're|we've|we'd|we'll|our|us)\b/i;
const SECOND_PERSON_RE = /\b(?:you|your|you're|you've|you'll)\b/i;
const STARTS_WITH_FIRST_PERSON_RE = /^(?:i\b|i['’]|my\b)/i;
const TEMPLATE_META_RE =
  /\b(?:pick one|one relevant example|use one example|use one story|pick one story|choose one example|what (?:i|you) did|what happened|and the result|link it to (?:this|the) role|stay specific|keep it short|answer directly|clarify constraints|first[, ]|then[, ]|finally|let me|i'll use|i'll share|restate what they want|answer in a simple structure|close with|link it to this role|state complexity|restate (?:the )?goal|outline approach|discuss tradeoffs|bullets?\s+with|list of bullet points|list of points|list of \d+(?:\s*-\s*\d+)? points|list of \d+(?:\s*-\s*\d+)? sentences?|\d+(?:\s*-\s*\d+)?\s+concise\s+(?:points|questions|bullets|sentences?)(?:\s+the\s+candidate\s+can\s+ask\s+back)?|(?:i|we)\s+list of \d+(?:\s*-\s*\d+)?\s+(?:points|sentences?)|each as a sentence|provide maybe \d+ points|maybe \d+ points|\beg\b|i can answer this clearly and directly|i can answer this directly with clear, grounded points|i can share a clear example from my work|the key answer is based on requirements, complexity, and tradeoffs|core requirements, constraints, and edge cases are addressed first|data structure and algorithm choices are justified|final solution explains correctness, limits, and practical impact|the main point is how\b|the tradeoff usually comes from\b|in practice the right answer depends on\b|the answer usually depends on\b|the tradeoff is usually between\b|in practice the right choice depends on\b|avoid skipping constraints or tradeoffs|do not claim details you cannot support|i focused on the main objective and clear actions|i explained key decisions and the expected impact|i highlighted outcomes and the core takeaway|i set clear expectations early and aligned on what success looked like|i handled the key actions directly and kept communication calm and clear|i delivered the outcome, then applied the lesson to improve future work|i would keep the answer focused on|i would support it with|i would end with|i would close with|lead with the direct answer(?:\s+in\s+one\s+sentence)?|before expanding into detail|core mechanism or tradeoff|edge cases?, limits?, or what you would do in practice|briefly describe the core concept or purpose|do not think aloud in content)\b/i;
const META_DIRECTIVE_START_RE =
  /^(?:pick|choose|mention|highlight|clarify|link|keep|stay|answer(?:\s+directly)?|restate|outline(?:\s+approach)?|discuss(?:\s+tradeoffs)?|give\s+(?:an|a)\s+(?:example|story)|share\s+(?:an|a)\s+(?:example|story)|close\s+with|lead\s+with|briefly\s+describe)\b/i;
const GENERAL_META_DIRECTIVE_START_RE =
  /^(?:explain|provide|mention|highlight|clarify|tie|link|state|restate|outline|summarize|answer|bullets?\s+with|lead\s+with|briefly\s+describe|close\s+with)\b/i;
const TECHNICAL_SECOND_PERSON_META_RE =
  /^(?:you|your|you're|you've|you'll)\b|\b(?:you\s+(?:should|can|could|would|need to|want to)|your\s+(?:answer|response|approach|story|example))\b/i;
const DONTMISS_STYLE_META_RE =
  /\b(?:just describe actions|first person|second person|third person|answer(?:ing)? style|response style|quote marks?|quotation marks?|use the word candidate|the word candidate|word candidate)\b|["']i["']/i;
const PROMPT_LEAK_RE =
  /\b(?:the interviewer is asking|interviewer is asking|the interviewer asked|interviewer asked|the question is|question is behavioral|question is coding|question is system design|candidate context|recent transcript|output json|return exactly|schema|questiontype|firstsentence|dontmiss|outline|talking points|assistant|model|rules?:|fields?:|answer-content bullets)\b/i;
const BROKEN_SCHEMA_SINGLETON_RE =
  /^(?:behavioral|system_design|coding|other|question|questiontype|question_type|firstsentence|first_sentence|outline|dontmiss|confidence|plan|steps|skeleton)$/i;
const BROKEN_SCHEMA_PREFXED_RE =
  /^(?:i\s+)?(?:behavioral|system_design|coding|other|question|questiontype|question_type|firstsentence|first_sentence|outline|dontmiss|confidence|plan|steps|skeleton)\b/i;
const PLACEHOLDER_BULLET_RE =
  /^(?:point|item|bullet|step|line|talking\s*point|tp)\s*[-#:]*\s*\d+\b(?:\s*(?:of|\/)\s*\d+)?$/i;
const BROKEN_TALKING_POINT_RE =
  /(?:\\["']|["']\s*=|\b=\s*\d+\s+words?\b|\bvalid json\b|\bjson object\b|\bdouble quotes\b|\btrailing commas?\b|\breturn one valid json\b|\boutput exactly\b|\bwords?\s*:\b|\bword count\b|\b\d+\s+bullets?\b|\blist of bullet points\b|\bprovide maybe \d+ points\b|\bmaybe \d+ points\b|\bmaybe bullet points\b|\bprovide pitfalls starting\b|\bbullets may start with concrete answer phrasing\b|\bavoid["']?\s+or\s+["']?do not\b)/i;
const GENERIC_TECHNICAL_OPENER_RE =
  /^(?:sure|certainly|absolutely|okay|ok)\b.*\b(?:overview|design|approach|solution|implementation)\b/i;

function isBrokenSchemaLikeLine(text, { allowDontMissPrefix = false } = {}) {
  const t = normalizeWhitespace(text);
  if (!t) return false;
  if (BROKEN_SCHEMA_SINGLETON_RE.test(t)) return true;
  if (BROKEN_SCHEMA_PREFXED_RE.test(t)) return true;
  if (PLACEHOLDER_BULLET_RE.test(t)) return true;
  if (/^(?:array|list|object|json)\s+of\s+[a-z0-9_-]+(?:\s+[a-z0-9_-]+)?$/i.test(t)) {
    return true;
  }
  if (!allowDontMissPrefix && /^(?:avoid|do not)$/i.test(t)) return true;
  if (/^[.,"'`:;()[\]{}<>=\\/|?!-]+$/.test(t)) return true;
  if (/^[a-z]{1,3}$/i.test(t)) return true;
  if (BROKEN_TALKING_POINT_RE.test(t)) return true;
  return false;
}

function sanitizeFirstSentence(text, maxWords) {
  const DANGLING_TAIL_WORDS = new Set([
    "and",
    "or",
    "to",
    "for",
    "with",
    "as",
    "the",
    "a",
    "an",
    "while",
    "when",
    "if",
    "because",
    "that",
    "which",
  ]);
  const trimDanglingTail = (value) => {
    const words = tokenizeWords(value);
    while (words.length >= 4) {
      const tail = String(words[words.length - 1] || "").toLowerCase();
      if (!DANGLING_TAIL_WORDS.has(tail)) break;
      words.pop();
    }
    return words.join(" ");
  };
  const max = Number.isFinite(Number(maxWords))
    ? Math.max(6, Math.floor(Number(maxWords)))
    : DEFAULT_FIRST_SENTENCE_MAX_WORDS;
  let clean = normalizeWhitespace(text)
    .replace(
      /^(?:first sentence|say next|opener|candidate response)\s*[:\-–—]?\s*/i,
      "",
    )
    .replace(/^["']+|["']+$/g, "");
  if (!clean) return "";
  clean = truncateToWordLimit(clean, max);
  clean = trimDanglingTail(clean);
  clean = clean.replace(/[,:;]+$/, "").trim();
  if (!clean) return "";
  if (
    TEMPLATE_META_RE.test(clean) ||
    META_DIRECTIVE_START_RE.test(clean) ||
    PROMPT_LEAK_RE.test(clean) ||
    GENERIC_TECHNICAL_OPENER_RE.test(clean)
  ) {
    return "";
  }
  if (!/[.!?]$/.test(clean)) clean += ".";
  return clean;
}

function coerceTechnicalFirstSentence(text) {
  let s = normalizeWhitespace(text);
  if (!s) return "";
  if (GENERIC_TECHNICAL_OPENER_RE.test(s)) return "";
  if (!FIRST_PERSON_RE.test(s)) return s;
  s = s
    .replace(
      /^(?:i(?:['’]m| am)\s+going\s+to|i(?:['’]ll| will)|i(?:['’]d| would)|i(?:\s+can|\s+could)|i)\s+/i,
      "",
    )
    .trim();
  if (!s) return "";
  if (TECHNICAL_SECOND_PERSON_META_RE.test(s)) return "";
  if (s.length >= 2) s = `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  return s;
}

function sanitizeTalkingPointBullet(text, { maxWords = DEFAULT_OUTLINE_MAX_WORDS } = {}) {
  const DANGLING_TAIL_WORDS = new Set([
    "and",
    "or",
    "to",
    "for",
    "with",
    "as",
    "the",
    "a",
    "an",
    "of",
    "in",
    "on",
    "at",
    "by",
    "from",
    "when",
    "while",
    "because",
    "that",
    "which",
    "who",
    "what",
    "where",
    "how",
    "after",
    "before",
    "during",
    "through",
    "using",
    "via",
    "causing",
    "so",
    "leading",
    "allowing",
    "resulting",
    "making",
    "creating",
    "out",
    "like",
    "such",
    "without",
    "unless",
    "i",
    "we",
  ]);
  const trimDanglingTail = (value) => {
    const words = tokenizeWords(value);
    while (words.length >= 3) {
      const tail = String(words[words.length - 1] || "").toLowerCase();
      if (!DANGLING_TAIL_WORDS.has(tail)) break;
      words.pop();
    }
    return words.join(" ");
  };
  let s = stripBulletPrefix(text);
  if (!s) return "";
  s = s
    .replace(/\\"/g, '"')
    .replace(/\s+(?:["'])?\s*(?:words?|word count|count)\s*:\s*[\s\S]*$/i, "")
    .replace(/\s+\bthat'?s\s+\d+\s+words?\b[\s\S]*$/i, "");
  s = s.replace(/\s*→\s*/g, ": ");
  s = s.replace(/;/g, ",");
  s = normalizeWhitespace(s);
  if (containsVariablePlaceholderLine(s) || /\bplaceholder\b/i.test(s)) return "";
  if (/^optional\s*:/i.test(s)) return "";
  if (isTemplateLikeLine(s) || PROMPT_LEAK_RE.test(s)) return "";
  if (isBrokenSchemaLikeLine(s)) return "";
  s = truncateToWordLimit(s, maxWords);
  s = trimDanglingTail(s);
  s = s.replace(/[,:;.\-–—]+$/g, "").trim();
  if (containsVariablePlaceholderLine(s) || /\bplaceholder\b/i.test(s)) return "";
  if (!s || isTemplateLikeLine(s) || PROMPT_LEAK_RE.test(s) || isBrokenSchemaLikeLine(s)) return "";
  return s;
}

function isLikelyUnsafeDontMissLine(value) {
  const text = normalizeWhitespace(value);
  if (!text) return false;
  return /^(?:avoid|do not)\b[\s\S]{0,180}\b(?:illegal activities?|tax evasion|criminal activity|crime|fraud|embezzlement|bribery|money laundering)\b/i.test(
    text,
  );
}

function sanitizeDontMissBullet(text, { maxWords = DEFAULT_DONT_MISS_MAX_WORDS } = {}) {
  const DANGLING_TAIL_WORDS = new Set([
    "and",
    "or",
    "to",
    "for",
    "with",
    "the",
    "a",
    "an",
    "of",
    "in",
    "on",
    "at",
    "by",
    "from",
    "so",
    "leading",
    "allowing",
    "resulting",
    "making",
    "creating",
    "out",
    "like",
    "such",
    "without",
    "unless",
    "i",
    "we",
  ]);
  const trimDanglingTail = (value) => {
    const words = tokenizeWords(value);
    while (words.length >= 3) {
      const tail = String(words[words.length - 1] || "").toLowerCase();
      if (!DANGLING_TAIL_WORDS.has(tail)) break;
      words.pop();
    }
    return words.join(" ");
  };
  let s = stripBulletPrefix(text);
  if (!s) return "";
  s = normalizeWhitespace(s).replace(/^["'`]+|["'`]+$/g, "");
  if (containsVariablePlaceholderLine(s) || /\bplaceholder\b/i.test(s)) return "";
  if (/^optional\s*:/i.test(s)) return "";
  if (
    /^(?:avoid\s+(?:drifting away from the main ask|being too vague|generic answers?)|do not\s+(?:make unsupported claims|be too vague|be generic))$/i.test(
      s,
    )
  ) {
    return "";
  }
  if (isBrokenSchemaLikeLine(s, { allowDontMissPrefix: true })) return "";
  s = truncateToWordLimit(s, maxWords);
  s = trimDanglingTail(s);
  s = s
    .replace(/\s*(?:["'`]|,\s*)+$/g, "")
    .replace(/[,:;.\-–—]+$/g, "")
    .trim();
  if (containsVariablePlaceholderLine(s) || /\bplaceholder\b/i.test(s)) return "";
  const tokenCount = tokenizeWords(s).length;
  if (/^(?:avoid|do not)\b/i.test(s) && tokenCount < 4) return "";
  if (tokenCount < 3) return "";
  if (!s || isBrokenSchemaLikeLine(s, { allowDontMissPrefix: true })) return "";
  if (isLikelyUnsafeDontMissLine(s)) return "";
  if (isLikelyClippedResponseLine(s) || isLikelyLengthTruncatedResponseLine(s)) return "";
  s = s.replace(/^avoid\b/i, "Avoid").replace(/^do not\b/i, "Do not");
  return s;
}

const BEHAVIORAL_ACTION_START_RE =
  /^(?:built|led|created|designed|developed|implemented|delivered|improved|reduced|increased|managed|owned|resolved|handled|mentored|collaborated|optimized|automated|tested|focused|learned|drove|launched|shipped|ran|worked|coordinated|identified|expanded|strengthened|streamlined|defined|communicated|planned|prioritized|organized|scheduled|tracked|aligned|partnered|presented|reviewed|gathered|translated|negotiated|clarified|escalated|listened|agreed|set)\b/i;
const TECHNICAL_RELEVANCE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "you",
  "about",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "will",
  "would",
  "could",
  "should",
  "into",
  "over",
  "them",
  "they",
  "their",
  "there",
  "then",
  "than",
  "just",
  "tell",
  "describe",
  "explain",
  "share",
  "give",
  "example",
  "time",
  "work",
  "role",
  "company",
  "job",
  "question",
  "interview",
]);

function normalizeTechnicalToken(token) {
  let t = typeof token === "string" ? token.trim().toLowerCase() : "";
  if (!t) return "";
  if (t.length > 5 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

function buildTechnicalContextTokenSet({ questionText, canonicalQuestion, recentTurns }) {
  const parts = [];
  const q = normalizeWhitespace(questionText);
  const cq = normalizeWhitespace(canonicalQuestion);
  if (q) parts.push(q);
  if (cq) parts.push(cq);
  const turns = Array.isArray(recentTurns) ? recentTurns.slice(-8) : [];
  for (const t of turns) {
    if (!t || typeof t !== "object") continue;
    const speaker = typeof t.speaker === "string" ? t.speaker : "";
    if (speaker !== "Interviewer") continue;
    const text = typeof t.text === "string" ? normalizeWhitespace(t.text) : "";
    if (!text) continue;
    parts.push(text);
  }
  const out = new Set();
  for (const part of parts) {
    for (const token0 of tokenizeSemantic(part)) {
      const token = normalizeTechnicalToken(token0);
      if (!token || token.length < 3) continue;
      if (TECHNICAL_RELEVANCE_STOPWORDS.has(token)) continue;
      out.add(token);
    }
  }
  return out;
}

function isTechnicalLineRelevant(text, contextTokens) {
  const t = normalizeWhitespace(text);
  if (!t) return false;
  if (!(contextTokens instanceof Set) || contextTokens.size === 0) return true;
  const tokens = tokenizeSemantic(t)
    .map((x) => normalizeTechnicalToken(x))
    .filter((x) => x && x.length >= 3 && !TECHNICAL_RELEVANCE_STOPWORDS.has(x));
  if (tokens.length === 0) return false;
  const strongTechnicalTokenCount = tokens.filter((token) => token.length >= 4).length;
  for (const token of tokens) {
    if (contextTokens.has(token)) return true;
  }
  if (strongTechnicalTokenCount >= 3) return true;
  if (contextTokens.size <= 3) {
    if (strongTechnicalTokenCount >= 2) return true;
  }
  return false;
}

function buildBriefTokenSet(brief) {
  const text = typeof brief === "string" ? brief : "";
  if (!text) return new Set();
  const out = new Set();
  for (const token0 of tokenizeSemantic(text)) {
    const token = normalizeTechnicalToken(token0);
    if (!token || token.length < 3) continue;
    if (TECHNICAL_RELEVANCE_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

function technicalTokenStats(text, tokenSet) {
  const tokens = tokenizeSemantic(text)
    .map((x) => normalizeTechnicalToken(x))
    .filter((x) => x && x.length >= 3 && !TECHNICAL_RELEVANCE_STOPWORDS.has(x));
  if (tokens.length === 0) return { total: 0, overlap: 0 };
  if (!(tokenSet instanceof Set) || tokenSet.size === 0) {
    return { total: tokens.length, overlap: 0 };
  }
  let overlap = 0;
  for (const token of tokens) {
    if (tokenSet.has(token)) overlap += 1;
  }
  return { total: tokens.length, overlap };
}

const RESUME_ACHIEVEMENT_START_RE =
  /^(?:created|built|led|enhanced|improved|reduced|increased|developed|implemented|delivered|optimized|automated|managed|owned|focused|mentored|coordinated|drove|launched|shipped|ran|worked|expanded|strengthened|streamlined)\b/i;
const BRANDED_TOOL_OR_TECH_RE =
  /\b(?:cypress|playwright|postman|circleci|docker|wordpress|selenium|jira|qa|automation|kubernetes|react|node(?:\.js)?|python|javascript|typescript|java|router|switch|splitter|modem|bit\.?ly|url shortener)\b/i;
const OTHER_SELF_SPECIFIC_CLAIM_RE =
  /^(?:my\s+(?:experience|background|expertise|work|projects?)|i\s+(?:have|bring|offer|worked|used|built|led|managed|developed|designed|implemented))\b/i;
const OTHER_COMPANY_SPECIFIC_CLAIM_RE =
  /\b(?:your\s+(?:mission|culture|values?|customers?|industry|product|products|technology|technologies|team|organization|goals?|focus|commitment)|(?:the\s+)?company'?s?\s+(?:mission|culture|values?|customers?|industry|product|products|technology|technologies|team|organization|goals?|focus|commitment))\b/i;
const BEHAVIORAL_UNGROUNDED_TECH_DETAIL_RE =
  /\b(?:pipeline|latency|throughput|cluster|microservice|queue|cache|database|redis|postgres|kafka|deployment|incident|outage|etl|api|backend|frontend|query|index|replica|server|container|docker|kubernetes|aws|gcp|azure|load test|performance test)\b/i;

function isLikelyResumeBleedTechnicalLine(
  text,
  { contextTokens = null, briefTokens = null } = {},
) {
  const line = normalizeWhitespace(text);
  if (!line) return false;
  const ctx = technicalTokenStats(line, contextTokens);
  if (ctx.overlap > 0) return false;

  const brief = technicalTokenStats(line, briefTokens);
  const hasMetric = /\b\d+(?:[.,]\d+)?%?\b/.test(line);
  const hasPastAchievementStart = RESUME_ACHIEVEMENT_START_RE.test(line);
  const hasBrandedToolList = /\b(?:cypress|playwright|postman|circleci|docker|wordpress|selenium|jira|qa|automation)\b/i.test(
    line,
  );

  if (hasPastAchievementStart && (hasMetric || brief.overlap >= 2)) return true;
  if (hasBrandedToolList && brief.overlap >= 2) return true;
  return false;
}

function coerceBehavioralTalkingPoint(text) {
  const t = normalizeWhitespace(text);
  if (!t) return "";
  if (isBrokenSchemaLikeLine(t)) return "";
  if (isTemplateLikeLine(t)) return "";
  if (PROMPT_LEAK_RE.test(t)) return "";
  if (SECOND_PERSON_RE.test(t)) return "";
  if (STARTS_WITH_FIRST_PERSON_RE.test(t)) return t;
  if (/^my\b/i.test(t)) return t;
  if (BEHAVIORAL_ACTION_START_RE.test(t)) {
    const lowered =
      t.length >= 2 ? `${t.charAt(0).toLowerCase()}${t.slice(1)}` : t.toLowerCase();
    return `I ${lowered}`;
  }
  return "";
}

function coerceTechnicalFamiliarityTalkingPoint(text) {
  let t = normalizeWhitespace(text);
  if (!t) return "";
  if (isBrokenSchemaLikeLine(t)) return "";
  if (isTemplateLikeLine(t)) return "";
  if (PROMPT_LEAK_RE.test(t)) return "";
  t = t
    .replace(/^the candidate\s+has\b/i, "I have")
    .replace(/^candidate\s+has\b/i, "I have")
    .replace(/^the candidate\s+is\b/i, "I am")
    .replace(/^candidate\s+is\b/i, "I am")
    .replace(/^the candidate\s+used\b/i, "I used")
    .replace(/^candidate\s+used\b/i, "I used")
    .replace(/^the candidate\s+worked\b/i, "I worked")
    .replace(/^candidate\s+worked\b/i, "I worked")
    .replace(/^the candidate\s+built\b/i, "I built")
    .replace(/^candidate\s+built\b/i, "I built")
    .replace(/^the candidate\s+integrated\b/i, "I integrated")
    .replace(/^candidate\s+integrated\b/i, "I integrated")
    .replace(/^the candidate\s+wrote\b/i, "I wrote")
    .replace(/^candidate\s+wrote\b/i, "I wrote")
    .replace(/^the candidate\s+know(?:s)?\b/i, "I know")
    .replace(/^candidate\s+know(?:s)?\b/i, "I know")
    .replace(/^the candidate\b/i, "I")
    .replace(/^candidate\b/i, "I");
  return normalizeWhitespace(t);
}

function isBehavioralAnswerStructureMeta(text) {
  const t = normalizeWhitespace(text);
  if (!t) return false;
  return /^i\s+(?:described|explained|highlighted|detailed|outlined|summarized|walked\s+through|shared|mentioned|stated)\s+(?:the\s+)?(?:context|background|situation|task|problem|challenge|steps?|actions?|approach|outcome|result|resolution|takeaway|story|example)\b/i.test(
    t,
  );
}

function isTemplateLikeLine(text) {
  const t = normalizeWhitespace(text);
  if (!t) return false;
  return (
    TEMPLATE_META_RE.test(t) ||
    META_DIRECTIVE_START_RE.test(t) ||
    PROMPT_LEAK_RE.test(t)
  );
}

function cleanReturnedFirstSentence(text, question) {
  const line = normalizeWhitespace(text);
  if (!line) return "";
  if (GENERIC_TECHNICAL_OPENER_RE.test(line)) return "";
  if (/\?$/.test(line) && looksLikeQuestionSummaryLine(line)) return "";
  const lhs = line.replace(/[.!?]+$/g, "").toLowerCase();
  const rhs = normalizeWhitespace(question).replace(/[.!?]+$/g, "").toLowerCase();
  if (lhs && rhs && lhs === rhs) return "";
  return line;
}

function isBehavioralSpeakableLine(text) {
  const t = normalizeWhitespace(text);
  if (!t) return false;
  if (isTemplateLikeLine(t)) return false;
  if (isBehavioralAnswerStructureMeta(t)) return false;
  return STARTS_WITH_FIRST_PERSON_RE.test(t);
}

function isTechnicalSpeakableLine(text) {
  const t = normalizeWhitespace(text);
  if (!t) return false;
  if (FIRST_PERSON_RE.test(t)) return false;
  if (TECHNICAL_SECOND_PERSON_META_RE.test(t)) return false;
  if (isTemplateLikeLine(t)) return false;
  return true;
}

function isCandidateAskBackQuestionLine(text) {
  const t = normalizeWhitespace(text);
  if (!t) return false;
  return /^(?:what|how|why|when|where|who|which|can|could|would|do|does|is|are)\b/i.test(
    t,
  ) && /\?$/.test(t);
}

function isGeneralSpeakableLine(text, { allowCandidateQuestionLines = false } = {}) {
  const t = normalizeWhitespace(text);
  if (!t) return false;
  if (isTemplateLikeLine(t)) return false;
  if (GENERAL_META_DIRECTIVE_START_RE.test(t)) return false;
  if (allowCandidateQuestionLines && isCandidateAskBackQuestionLine(t)) return true;
  if (SECOND_PERSON_RE.test(t) && !FIRST_PERSON_RE.test(t)) return false;
  return true;
}

function buildCurrentAskTokenSet(questionText, canonicalQuestion) {
  return new Set(
    tokenizeSemantic(canonicalQuestion || questionText)
      .map((x) => normalizeTechnicalToken(x))
      .filter((x) => x && x.length >= 4 && !GROUNDING_STOPWORDS.has(x)),
  );
}

function buildPriorTurnTokenSet(recentTurns, currentAskText) {
  const current = normalizeWhitespace(currentAskText).toLowerCase();
  const out = new Set();
  const turns = Array.isArray(recentTurns) ? recentTurns : [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    if (turn.speaker !== "Interviewer") continue;
    const text = normalizeWhitespace(turn.text);
    if (!text) continue;
    if (current && text.toLowerCase() === current) continue;
    for (const token of tokenizeSemantic(text)
      .map((x) => normalizeTechnicalToken(x))
      .filter((x) => x && x.length >= 4 && !GROUNDING_STOPWORDS.has(x))) {
      out.add(token);
    }
  }
  return out;
}

function overlapCount(tokens, tokenSet) {
  if (!Array.isArray(tokens) || !(tokenSet instanceof Set) || tokenSet.size === 0) return 0;
  let count = 0;
  for (const token of tokens) {
    if (tokenSet.has(token)) count += 1;
  }
  return count;
}

function isLikelyOtherQuestionBleedLine(
  text,
  {
    currentAskTokens = null,
    priorTurnTokens = null,
    briefTokens = null,
    allowPriorOverlap = false,
  } = {},
) {
  const line = normalizeWhitespace(text);
  if (!line) return false;
  const tokens = tokenizeSemantic(line)
    .map((x) => normalizeTechnicalToken(x))
    .filter((x) => x && x.length >= 4 && !GROUNDING_STOPWORDS.has(x));
  if (tokens.length < 3) return false;
  if (overlapCount(tokens, currentAskTokens) > 0) return false;
  const priorOverlap = overlapCount(tokens, priorTurnTokens);
  const briefOverlap = overlapCount(tokens, briefTokens);
  const hasMetric = /\b\d+(?:[.,]\d+)?%?\b/.test(line);
  const hasBrandedTech = BRANDED_TOOL_OR_TECH_RE.test(line);
  if (!allowPriorOverlap && priorOverlap >= 1) return true;
  if (briefOverlap === 0 && OTHER_SELF_SPECIFIC_CLAIM_RE.test(line)) return true;
  if ((hasMetric || hasBrandedTech) && briefOverlap >= 2) return true;
  return false;
}

function isLikelyUngroundedOtherSpecificLine(
  text,
  { groundingTokens = null, briefTokens = null, allowSelfSpecificClaims = false } = {},
) {
  const line = normalizeWhitespace(text);
  if (!line) return false;
  const briefOverlap = overlapCount(
    tokenizeSemantic(line)
      .map((x) => normalizeTechnicalToken(x))
      .filter((x) => x && x.length >= 4 && !GROUNDING_STOPWORDS.has(x)),
    briefTokens,
  );
  if (briefOverlap >= 1) return false;
  if (OTHER_COMPANY_SPECIFIC_CLAIM_RE.test(line)) return true;
  if (!allowSelfSpecificClaims && OTHER_SELF_SPECIFIC_CLAIM_RE.test(line) && briefOverlap === 0) {
    return true;
  }
  return isPotentiallyUngroundedSpecificLine(line, groundingTokens, { strictMode: true });
}

function isLikelyUngroundedAvailabilityLine(text, { briefTokens = null } = {}) {
  const line = normalizeWhitespace(text);
  if (!line) return false;
  const briefOverlap = overlapCount(
    tokenizeSemantic(line)
      .map((x) => normalizeTechnicalToken(x))
      .filter((x) => x && x.length >= 4 && !GROUNDING_STOPWORDS.has(x)),
    briefTokens,
  );
  if (briefOverlap >= 1) return false;
  return /\b(?:currently employed|current employer|current role|two[- ]week notice|notice period|relocat(?:e|ion)|remote setup|available immediately|start immediately|available from|start earlier|transition period|give a .*notice|wrap up .*obligation|immediately)\b/i.test(
    line,
  );
}

function isLikelyUngroundedBehavioralLine(
  text,
  { groundingTokens = null, briefTokens = null } = {},
) {
  const line = normalizeWhitespace(text);
  if (!line) return false;
  if (briefTokens instanceof Set && briefTokens.size > 0) return false;
  const tokens = tokenizeSemantic(line)
    .map((x) => normalizeTechnicalToken(x))
    .filter((x) => x && x.length >= 4 && !GROUNDING_STOPWORDS.has(x));
  if (tokens.length < 3) return false;
  if (overlapCount(tokens, groundingTokens) > 0) return false;
  if (/\b\d+(?:[.,]\d+)?%?\b/.test(line)) return true;
  return BEHAVIORAL_UNGROUNDED_TECH_DETAIL_RE.test(line);
}

function isValidTalkingPointByType(text, questionType, options = {}) {
  if (!text) return false;
  if (questionType === "coding" || questionType === "system_design") {
    if (!isTechnicalSpeakableLine(text)) return false;
    return isTechnicalLineRelevant(text, options.technicalContextTokens);
  }
  if (containsVariablePlaceholderLine(text)) return false;
  if (questionType === "behavioral") {
    if (!isBehavioralSpeakableLine(text)) return false;
    if (
      isLikelyUngroundedBehavioralLine(text, {
        groundingTokens: options.groundingTokens,
        briefTokens: options.briefTokens,
      })
    ) {
      return false;
    }
    return true;
  }
  if (
    !isGeneralSpeakableLine(text, {
      allowCandidateQuestionLines: options.allowCandidateQuestionLines,
    })
  ) {
    return false;
  }
  if (
    questionType === "other" &&
    isLikelyOtherQuestionBleedLine(text, {
      currentAskTokens: options.currentAskTokens,
      priorTurnTokens: options.priorTurnTokens,
      briefTokens: options.briefTokens,
      allowPriorOverlap: options.allowPriorOverlap === true,
    })
  ) {
    return false;
  }
  if (
    questionType === "other" &&
    isLikelyUngroundedOtherSpecificLine(text, {
      groundingTokens: options.groundingTokens,
      briefTokens: options.briefTokens,
      allowSelfSpecificClaims: options.allowSelfSpecificClaims === true,
    })
  ) {
    return false;
  }
  if (
    questionType === "other" &&
    isAvailabilityStartAsk(options.askText) &&
    isLikelyUngroundedAvailabilityLine(text, {
      briefTokens: options.briefTokens,
    })
  ) {
    return false;
  }
  return true;
}

function normalizeDontMissBullets(rawBullets) {
  const expanded = [];
  for (const raw of Array.isArray(rawBullets) ? rawBullets : []) {
    const text = normalizeWhitespace(raw).replace(/\\+/g, "");
    if (!text) continue;
    const matches = [...text.matchAll(/\b(?:Avoid|Do not)\b/gi)].filter((match, index, all) => {
      const start = match.index ?? 0;
      if (start <= 0 || index === 0) return true;
      const prev = text.slice(Math.max(0, start - 4), start);
      // Only split when the next Avoid/Do not starts a new sentence/bullet.
      return /(?:^|[.;\n]\s*|[-•]\s*|["'`,/]+\s*)$/u.test(prev);
    });
    if (matches.length <= 1) {
      expanded.push(text);
      continue;
    }
    for (let i = 0; i < matches.length; i += 1) {
      const start = matches[i].index ?? 0;
      const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
      const segment = text
        .slice(start, end)
        .replace(/\s*(?:and|or)\s*$/i, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
      if (segment) expanded.push(segment);
    }
  }
  const normalized = normalizeStringList(expanded, { maxItems: 4, maxChars: 140 })
    .map((line) => {
      const t = normalizeWhitespace(line)
        .replace(/\\+/g, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
      if (!t) return "";
      if (containsVariablePlaceholderLine(t) || /\bplaceholder\b/i.test(t)) return "";
      if (isTemplateLikeLine(t)) return "";
      if (DONTMISS_STYLE_META_RE.test(t)) return "";
      if (isBrokenSchemaLikeLine(t, { allowDontMissPrefix: true })) return "";
      if (isLikelyUnsafeDontMissLine(t)) return "";
      if (isLikelyClippedResponseLine(t) || isLikelyLengthTruncatedResponseLine(t)) return "";
      if (tokenizeWords(t).length < 4) return "";
      if (/^(?:avoid|do not)\b/i.test(t)) return t;
      return "";
    })
    .filter(Boolean);
  const deduped = [];
  for (const line of normalized) {
    const lower = line.toLowerCase();
    if (deduped.some((existing) => existing.toLowerCase().includes(lower))) continue;
    for (let i = deduped.length - 1; i >= 0; i -= 1) {
      if (lower.includes(deduped[i].toLowerCase())) deduped.splice(i, 1);
    }
    deduped.push(line);
    if (deduped.length >= 2) break;
  }
  return deduped.slice(0, 2);
}

function normalizeQuestionType(value) {
  const v = normalizeWhitespace(value).toLowerCase();
  if (v === "behavioral" || v === "system_design" || v === "coding" || v === "other") {
    return v;
  }
  return "other";
}

function isExperienceBehavioralAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  if (
    /\b(?:a time when|a time you|an example of|an example when|give(?:\s+me)?\s+an?\s+example|describe\s+(?:a|an)\s+(?:time|example|situation)|share\s+(?:a|an)\s+(?:time|example|situation)|walk me through (?:a|an)\s+(?:time|example|situation)|situation where|situation when|what happened|how did you handle|how was it resolved|what did it consist of|what was the outcome|which was the outcome)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (
    /\b(?:mistake|conflict|disagreement|deadline|initiative|challenge|failure|teammate|coworker|project)\b/i.test(
      s,
    ) &&
    /\b(?:time|example|situation|when|how|resolved|outcome|happened)\b/i.test(s)
  ) {
    return true;
  }
  if (
    /\b(?:tell me about|describe|share|walk me through)\b/i.test(s) &&
    /\b(?:problem|challenge|bug|issue|incident|outage|failure|project|migration)\b/i.test(s) &&
    /\b(?:you\s+(?:solved|handled|fixed|debugged|worked on|dealt with|resolved|faced))\b/i.test(
      s,
    )
  ) {
    return true;
  }
  return false;
}

function isTechnicalExperienceAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  const asksForExperience =
    /\b(?:tell me about|describe|share|walk me through|give(?:\s+me)?\s+an?\s+example)\b/i.test(
      s,
    ) || /\b(?:hardest|toughest|most difficult|most challenging)\b/i.test(s);
  if (!asksForExperience) return false;
  const technicalSignal =
    /\b(?:technical problem|technical challenge|technical issue|production issue|performance issue|scaling issue|bug|incident|outage|migration|integration problem|integration issue)\b/i.test(
      s,
    );
  const solvedSignal =
    /\b(?:you\s+(?:solved|fixed|debugged|resolved|handled|worked on|dealt with|faced))\b/i.test(
      s,
    ) || /\b(?:problem|challenge|issue)\s+you\s+(?:solved|fixed|debugged|resolved|handled)\b/i.test(
      s,
    );
  return technicalSignal && solvedSignal;
}

function isTechnicalFamiliarityAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  if (
    !/\b(?:do you know|have you (?:used|worked with|written)|did you (?:use|work with|write)|worked with|familiar with|experience with|exposure to|written any|write any)\b/i.test(
      s,
    )
  ) {
    return false;
  }
  const inferred = inferQuestionTypeFromAskText(s);
  return inferred === "coding" || inferred === "system_design";
}

function extractTechnicalFamiliaritySubject(value) {
  const s = normalizeWhitespace(value);
  if (!s) return "";
  const match = s.match(
    /\b(?:do you know|have you (?:used|worked with|written)|did you (?:use|work with|write)|worked with|familiar with|experience with|exposure to|written any|write any)\b\s+(.+?)(?:\?|$)/i,
  );
  if (!match || !match[1]) return "";
  let subject = normalizeWhitespace(match[1])
    .replace(/^(?:any|a|an|the)\s+/i, "")
    .replace(/\bfiles?\b$/i, "")
    .trim();
  if (!subject) return "";
  subject = sanitizeQuestionLine(subject, 6).replace(/[?!.]+$/g, "").trim();
  return subject;
}

function inferQuestionTypeFromAskText(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return "other";
  if (isTransferableSkillsAsk(s)) {
    return "behavioral";
  }
  if (isClarificationRepeatAsk(s) || isCareerChangeCommitmentAsk(s)) {
    return "other";
  }
  if (isImplementationLanguageAsk(s)) {
    return "coding";
  }
  if (
    /\b(?:server|instance|ssh|shell|terminal|host|vm|prod|production|rollback|mitigate|diagnose|troubleshoot|investigate|logged?\s+into?|utp|ethernet|cat5e?|cat6|twisted pair|dsl|adsl|vdsl)\b/i.test(
      s,
    )
  ) {
    return "system_design";
  }
  if (
    /\b(?:implement|code|coding|algorithm|data structure|complexity|big o|binary tree|binary search tree|bst|hashmap|treemap|linkedhashmap|function|bug|debug|stack trace|leetcode|array|node|javascript|typescript|python|java|c\+\+|c#|golang|go\b|ruby|php|swift|kotlin|rust|pyspark|apache spark|spark sql|spark streaming|yaml|yml)\b/i.test(
      s,
    )
  ) {
    return "coding";
  }
  if (
    /\b(?:system design|design a|architecture|scalability|throughput|latency|kubernetes|microservice|distributed|queue|load balancer|cache|database|container|deployment|url shortener|shortener|bit\.?ly|timeout|timeouts|dependency|dependencies|service|services|network|router|switch|splitter|modem|mac address|logs?|resource(?:s)?|thread pool|connection pool|downstream|process|restart|healing|heal|hangs?|failure|failures)\b/i.test(
      s,
    )
  ) {
    return "system_design";
  }
  if (
    /\b(?:tell me about a time|describe a time|example of|conflict|strengths?|weakness(?:es)?|initiative|leadership|challenge|experience|yourself)\b/i.test(
      s,
    )
  ) {
    return "behavioral";
  }
  return "other";
}

function resolveQuestionTypeFromAsk({
  parsedQuestionType = "",
  askText = "",
  fallbackQuestionType = "",
} = {}) {
  const parsed = normalizeQuestionType(parsedQuestionType || "");
  const inferred = normalizeQuestionType(
    inferQuestionTypeFromAskText(askText || fallbackQuestionType || ""),
  );
  const askLooksExperiential = isExperienceBehavioralAsk(askText);
  const askLooksTechnicalExperience = isTechnicalExperienceAsk(askText);
  const askLooksTechnicalFamiliarity = isTechnicalFamiliarityAsk(askText);
  const askLooksMotivation = isMotivationOrFitAsk(askText);
  const askLooksCandidateQuestions = isCandidateQuestionsPrompt(askText);
  const askLooksAvailability = isAvailabilityStartAsk(askText);
  const askLooksClarification = isClarificationRepeatAsk(askText);
  const askLooksTransferableSkills = isTransferableSkillsAsk(askText);
  const askLooksCareerChangeCommitment = isCareerChangeCommitmentAsk(askText);

  if (
    askLooksClarification ||
    askLooksMotivation ||
    askLooksCandidateQuestions ||
    askLooksAvailability ||
    askLooksCareerChangeCommitment
  ) {
    return "other";
  }
  if (askLooksTransferableSkills) return "behavioral";
  if (askLooksTechnicalExperience || askLooksTechnicalFamiliarity) return "other";
  if (inferred === "behavioral") return "behavioral";

  if (askLooksExperiential) {
    if (parsed === "coding" || parsed === "system_design") return parsed;
    if (inferred === "coding" || inferred === "system_design") return inferred;
    return "behavioral";
  }
  if (inferred === "coding" || inferred === "system_design") return inferred;
  if (parsed === "behavioral" && inferred === "other") return "other";
  if (parsed !== "other") return parsed;
  return inferred !== "other" ? inferred : normalizeQuestionType(fallbackQuestionType || "");
}

function isMotivationOrFitAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:why do you (?:want to|wanna)\s+(?:work (?:for|with) us|join us|get this role)|why do you want\s+(?:this|the|our)?\s*(?:job|role|position|opportunity)|why did you apply(?:\s+for)?\s+(?:this|the|our)?\s*(?:job|role|position|company|team|opportunity)|what made you apply(?:\s+for)?\s+(?:this|the|our)?\s*(?:job|role|position|company|team|opportunity)|why (?:this|our)\s+(?:role|job|position|company|team|opportunity)|why are you interested in (?:this|the)\s+(?:role|job|position|company|team|opportunity)|why are you interviewing(?:\s+with me)?(?:\s+today)?|what makes you a (?:good|great) fit|great fit|fit for (?:our|this)\s+(?:company|team|role)|why should we hire you|interested in this role)\b/i.test(
    s,
  );
}

function isCandidateQuestionsPrompt(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:do you have any questions for me|any questions for me|what questions do you have|do you have any questions|would you like to ask any questions)\b/i.test(
    s,
  );
}

function isRevisitTopicsAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return (
    /\brevisit\b/.test(s) ||
    /\b(?:first|earlier|previous)\s+interview\b/.test(s)
  ) && /\b(?:topic|topics|anything|something|part|parts|question|questions)\b/.test(s);
}

function isDifferenceComparisonAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:difference between|different between|compare|comparison|versus|vs\.?)\b/i.test(
    s,
  );
}

function extractComparedTerms(value) {
  const s = normalizeWhitespace(value)
    .replace(/[?!.]+$/g, "")
    .trim();
  if (!s) return null;
  const betweenMatch = s.match(
    /\b(?:difference between|different between|compare)\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+)$/i,
  );
  if (betweenMatch?.[1] && betweenMatch?.[2]) {
    const left = sanitizeQuestionLine(betweenMatch[1], 5).replace(/[?!.]+$/g, "").trim();
    const right = sanitizeQuestionLine(betweenMatch[2], 5).replace(/[?!.]+$/g, "").trim();
    if (left && right) return { left, right };
  }
  const versusMatch = s.match(/\b(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i);
  if (versusMatch?.[1] && versusMatch?.[2]) {
    const left = sanitizeQuestionLine(versusMatch[1], 5)
      .replace(/^(?:what(?:'s| is)? the difference between|compare)\s+/i, "")
      .replace(/[?!.]+$/g, "")
      .trim();
    const right = sanitizeQuestionLine(versusMatch[2], 5).replace(/[?!.]+$/g, "").trim();
    if (left && right) return { left, right };
  }
  return null;
}

function isWeaknessAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:what are your weaknesses|what is your greatest weakness|what is your biggest weakness|biggest weakness|greatest weakness|main weakness|development area|something you(?:'re| are) working on|what would you improve about yourself|your\s+(?:greatest|biggest|main)\s+improvement areas?|improvement areas?|areas?\s+for\s+improvement)\b/i.test(
    s,
  );
}

function isSelfIntroductionAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:tell me about yourself|tell me something about yourself|introduce yourself|walk me through your background|give me a quick introduction|who are you|your background)\b/i.test(
    s,
  );
}

function isSalaryExpectationsAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:salary expectations|compensation expectations|salary range|compensation range|what are you looking for(?: in compensation)?|what salary are you looking for|expected compensation)\b/i.test(
    s,
  );
}

function isAvailabilityStartAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:when could you start|when can you start|when would you start|how soon can you start|start date|availability|available to start|available to join|earliest start)\b/i.test(
    s,
  );
}

function isClarificationRepeatAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:can|could|would)\s+you\s+(?:say|repeat|restate|go over)\s+(?:that|the last part|that last part|that part|the question)\s+again\b/i.test(
    s,
  ) || /\b(?:say|repeat|restate)\s+(?:that|the last part|that last part|that part)\s+again\b/i.test(
    s,
  );
}

function isTransferableSkillsAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  if (!/\bskills?\b/i.test(s)) return false;
  return (
    /\btransfer(?:able)?\b/i.test(s) ||
    /\bfrom\s+your\s+previous\b/i.test(s) ||
    /\bprevious\s+(?:work|role|experience|line of work|field)\b/i.test(s) ||
    /\bbring\s+from\s+your\s+previous\b/i.test(s)
  );
}

function isCareerChangeCommitmentAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return (
    /\b(?:career change|current field|master(?:'s|s)\s+degree)\b/i.test(s) &&
    /\b(?:position|job|role|field|future)\b/i.test(s)
  ) || /\bif\s+(?:a\s+)?(?:position|job|role)\s+becomes?\s+available\b/i.test(s);
}

function isImplementationLanguageAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  if (
    !/\b(?:what language|which language|in what language)\b/i.test(s) ||
    !/\b(?:coded|written|implemented|built)\b/i.test(s)
  ) {
    return false;
  }
  return /\b(?:unity|unreal|engine|framework|library|runtime|compiler|kernel|database|sdk|api|service|software|application|app|backend|frontend|game)\b/i.test(
    s,
  );
}

function isMaximumLimitAsk(value) {
  const s = normalizeWhitespace(value).toLowerCase();
  if (!s) return false;
  return /\b(?:maximum|max|longest|limit)\b/i.test(s) &&
    /\b(?:length|distance|range|size|duration|payload|bandwidth|cable)\b/i.test(s);
}

function extractOutlineCandidatesFromRawText(raw) {
  const text = normalizeWhitespace(raw);
  if (!text) return [];
  const out = [];
  const push = (value) => {
    const line = sanitizeTalkingPointBullet(value);
    if (!line) return;
    if (isTemplateLikeLine(line)) return;
    if (out.includes(line)) return;
    out.push(line);
  };

  const parsed = extractFirstJsonObject(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const parsedOutline = coerceBulletList(
      parsed.outline ?? parsed.plan ?? parsed.steps ?? parsed.skeleton,
    );
    for (const item of parsedOutline) {
      push(item);
      if (out.length >= 12) break;
    }
  }

  const planListMatch = text.match(/plan\s*=\s*\[([^\]]{1,2000})\]/i);
  if (planListMatch && planListMatch[1]) {
    const quoted = planListMatch[1].match(/"([^"]{1,240})"/g) || [];
    for (const q of quoted) {
      push(q.replace(/^"|"$/g, ""));
      if (out.length >= 12) break;
    }
  }

  const quotedBullets =
    (typeof raw === "string"
      ? raw.match(/(?:^|\n)\s*(?:[-*•]|\d+[.)])\s*"([^"\n]{6,240})"/gim)
      : null) || [];
  for (const item of quotedBullets) {
    const match = item.match(/"([^"\n]{6,240})"/);
    if (!match?.[1]) continue;
    push(match[1]);
    if (out.length >= 12) break;
  }

  const lines = raw
    .split(/\r?\n+/g)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  let inOutlineSection = false;
  for (const line of lines) {
    if (/^outline\b/i.test(line)) {
      inOutlineSection = true;
      const after = line.replace(/^outline\s*:\s*/i, "").trim();
      if (after && !/^maybe:?$/i.test(after)) push(after);
      continue;
    }
    if (/^(?:dontmiss|dont miss|pitfalls?)\b/i.test(line)) {
      inOutlineSection = false;
      continue;
    }
    if (/^(?:[-*•]|\d+[.)])\s+/.test(line)) {
      if (inOutlineSection || !/^(?:[-*•]|\d+[.)])\s+(?:avoid|do not)\b/i.test(line)) {
        push(line);
      }
    }
    if (out.length >= 12) break;
  }

  return out;
}

function extractDontMissCandidatesFromRawText(raw) {
  const text = normalizeWhitespace(raw);
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const line = sanitizeDontMissBullet(value);
    if (!line) return;
    if (!/^(?:Avoid|Do not)\b/i.test(line)) return;
    if (isTemplateLikeLine(line)) return;
    if (isBrokenSchemaLikeLine(line, { allowDontMissPrefix: true })) return;
    const key = line.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(line);
  };

  const parsed = extractFirstJsonObject(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const parsedDontMiss = coerceBulletList(parsed.dontMiss);
    for (const item of parsedDontMiss) {
      push(item);
      if (out.length >= 2) break;
    }
  }

  const quoted = text.match(/"(Avoid[^"]{1,200}|Do not[^"]{1,200})"/gi) || [];
  for (const item of quoted) {
    push(item.replace(/^"|"$/g, ""));
    if (out.length >= 2) break;
  }

  const lines = text
    .split(/\n+/g)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  for (const line of lines) {
    if (/^(?:Avoid|Do not)\b/i.test(line)) {
      push(line);
      if (out.length >= 2) break;
    }
  }

  return out.slice(0, 2);
}

function hasLengthFinishReason(value) {
  return /\blength\b/i.test(normalizeWhitespace(value));
}

function containsVariablePlaceholderLine(value) {
  const text = normalizeWhitespace(value);
  if (!text) return false;
  if (/\bplaceholder\b/i.test(text)) return true;
  const standins = text.match(/\b(?:X|Y|Z)\b/g);
  if (standins && standins.length >= 2) return true;
  if (
    /\b(?:including|such as|for example)\s+[A-Z](?:\s*,\s*[A-Z])+(?:\s*,?\s*(?:and|or)\s+[A-Z])?\b/.test(
      text,
    )
  ) {
    return true;
  }
  const genericStandins = text.match(/\b[A-Z]\b/g);
  if (
    genericStandins &&
    genericStandins.length >= 3 &&
    /\b(?:years?(?:\s+of)?\s+experience|experience\s+in|background\s+in|expertise\s+in|my\s+(?:most\s+recent\s+)?(?:position|role)|position\s+involved|role\s+involved|helped\s+(?:me|us)\s+(?:achieve|deliver|reach|improve)|technolog(?:y|ies)|tool|tools|methodolog(?:y|ies)|framework|frameworks|stack|platform|company|team|project|responsible\s+for|including)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/\b(?:X|Y|Z)\b(?:\s*(?:,|\/|and|or)\s*\b(?:X|Y|Z)\b)+/u.test(text)) return true;
  if (
    /\b(?:point|topic|issue|detail|details|part|aspect|something|anything)\s+(?:about|on|regarding)?\s*(?:X|Y|Z)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:expertise|experience|skill|skills|project|projects|technology|technologies|role|team|company|area|areas|example|examples)\s+(?:in|with|around|about|on|for)?\s*(?:X|Y|Z)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:clarify|elaborate on|expand on|revisit|discuss)\s+(?:X|Y|Z)\b/i.test(text)
  ) {
    return true;
  }
  if (
    /^(?:the|my|our|this|that|these|those|i|we|yes|no|if needed|if helpful)\b[\s\S]{0,120}\b(?:in|with|around|about|on|for)\s+(?:X|Y|Z)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/^(?:yes|no|if needed|if helpful)\b[\s\S]{0,120}\b(?:X|Y|Z)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(?:X|Y|Z)\s+(?:members?|people|engineers?|developers?|analysts?|designers?|stakeholders?|customers?|users?|clients?|teammates?|participants?|interns?|outcome|result|results|impact|improvement|gain|reduction|increase|metric|metrics)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:achiev(?:e|ed|ing)|deliver(?:ed|ing)|produc(?:e|ed|ing)|generat(?:e|ed|ing)|dr(?:ove|iving))\s+(?:X|Y|Z)\s+(?:outcome|result|results|impact|improvement|gain|reduction|increase)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/\bXYZ\s+(?:product|project|launch|client|company|team)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(?:experience|expertise|background)\s+in\s+[A-Z]\s+(?:technology|tool|stack|platform|field|domain|area)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\bhelped\s+(?:me|us)\s+(?:achieve|deliver|reach|improve)\s+[A-Z](?:%| percent)?\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:my\s+(?:most\s+recent\s+)?(?:position|role)|(?:position|role|project|work))\s+(?:involved|focused on|required)\s+[A-Z]\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/\b(?:improved|reduced|increased)\s+[A-Z]\s+by\s+[A-Z]%\b/i.test(text)) {
    return true;
  }
  if (/\bas\s+a\s+[A-Z]\s+at\s+[A-Z]\b/i.test(text)) {
    return true;
  }
  return false;
}

function isLikelyClippedResponseLine(value) {
  const text = normalizeWhitespace(value)
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!text) return false;
  if (containsVariablePlaceholderLine(text) || /\bplaceholder\b/i.test(text)) return true;
  if (/^(?:avoid|do not)\b/i.test(text) && tokenizeWords(text).length < 4) return true;
  if (/[\\]["']/.test(text)) return true;
  if (/\betc\b/i.test(text)) return true;
  if (
    /,\s*(?:demonstrating|showing|highlighting|reflecting)\s+(?:strong|solid|clear|effective|practical|valuable|meaningful|relevant|different|multiple|single)$/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/,\s*[A-Z]{2,}(?:\s*,\s*[A-Z]{2,})*$/u.test(text)) return true;
  if (
    /\b(?:multiple|single|several|many|few|various|different|specific|relevant|strong|solid|clear|effective|practical|valuable|meaningful|key)$/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/\b(?:designed|implemented|built|created|managed|led|owned)\s+key$/i.test(text)) {
    return true;
  }
  if (/\b(?:to|for|with|into|from|by|as|of|in|on|at|about|through|during|without|before|after|while|than|between|via)$/i.test(text)) {
    return true;
  }
  if (
    /\b(?:that|which|who|when|where|because|via|for|to|into|with|between|from|than|as)\s+(?:the|a|an|this|that|these|those|my|our|your|their)?\s*[\p{L}\p{N}'’.-]+$/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /^(?:avoid|do not)\b/i.test(text) &&
    /\b(?:you|your|yours|me|my|mine|we|our|ours|they|their|theirs|it|its|this|that|these|those|the|a|an|to|for|with|from|into|by|and|or|of|in|on|at|have|has|had|be|been|being|can|could|will|would|should|may|might|must|do|does|did)$/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\byou\s+(?:haven't|have not)\s+worked\b(?!\s+(?:with|on|in|at|for)\b)/i.test(text)
  ) {
    return true;
  }
  if (/^(?:avoid|do not)\b.*\b(?:without|before|after|while)\s+[a-z]+ing$/i.test(text)) {
    return true;
  }
  if (
    /\b(?:whereas|while)\b.*\b(?:can|could|would|should|may|might|will)\s+(?:work|be|run|operate|fit|handle|support)$/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:deep|strong|solid|advanced|practical|proven|rigorous|measurable)\s+(?:technical|analytical|strategic|operational)\b$/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:a|an)\s+[a-z][\w'-]*\s+but\s+(?:more|less)\s+[a-z][\w'-]*$/i.test(text)
  ) {
    return true;
  }
  if (
    /,\s*(?:returning|providing|using|showing|demonstrating|highlighting|creating|making|producing)\s+(?:a|an|the)\s+[a-z][\w'-]*$/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/,\s*(?:it|this|that|they|these|those)$/i.test(text)) {
    return true;
  }
  if (/\b(?:and|or)\s+optionally\s+(?:annotate|mark|label|tag)$/i.test(text)) {
    return true;
  }
  if (/^(?:avoid|do not)\b.*\b(?:focusing|focused)\s+on\s+personal$/i.test(text)) {
    return true;
  }
  return false;
}

function isLikelyLengthTruncatedResponseLine(value) {
  const text = normalizeWhitespace(value)
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!text) return false;
  if (isLikelyClippedResponseLine(text)) return true;
  if (
    /\bsuch as\s+[a-z0-9][\w'.-]*(?:\s+[a-z0-9][\w'.-]*){0,2}$/i.test(text) &&
    !/\b(?:and|or)\b/i.test(text.replace(/^.*\bsuch as\b/i, ""))
  ) {
    return true;
  }
  if (
    /\b(?:including|like)\s+[a-z0-9][\w'.-]*(?:\s+[a-z0-9][\w'.-]*){0,1}$/i.test(text) &&
    !/\b(?:and|or)\b/i.test(text.replace(/^.*\b(?:including|like)\b/i, ""))
  ) {
    return true;
  }
  return false;
}

function hasClippedCardsContent(cards) {
  if (!cards || typeof cards !== "object") return false;
  const outline = Array.isArray(cards.outline) ? cards.outline : [];
  const dontMiss = Array.isArray(cards.dontMiss) ? cards.dontMiss : [];
  if (outline.some((line) => isLikelyClippedResponseLine(line))) return true;
  if (dontMiss.some((line) => isLikelyClippedResponseLine(line))) return true;
  if (cards.firstSentence && isLikelyClippedResponseLine(cards.firstSentence)) return true;
  return false;
}

function hasLengthTruncatedCardsContent(cards, { sourceAsk = "" } = {}) {
  if (!cards || typeof cards !== "object") return false;
  const outline = Array.isArray(cards.outline) ? cards.outline : [];
  const dontMiss = Array.isArray(cards.dontMiss) ? cards.dontMiss : [];
  if (outline.some((line) => isLikelyLengthTruncatedResponseLine(line))) return true;
  if (dontMiss.some((line) => isLikelyLengthTruncatedResponseLine(line))) return true;
  if (cards.firstSentence && isLikelyLengthTruncatedResponseLine(cards.firstSentence)) {
    return true;
  }
  if (
    sourceAsk &&
    cards.question &&
    isLikelyLengthTruncatedQuestionSummary(cards.question, sourceAsk)
  ) {
    return true;
  }
  return false;
}

function buildFallbackQuestionKeywords(question) {
  const q = normalizeWhitespace(question);
  if (!q) return [];
  const seen = new Set();
  const out = [];
  for (const token0 of tokenizeSemantic(q)) {
    const token = normalizeTechnicalToken(token0);
    if (!token || token.length < 3) continue;
    if (TECHNICAL_RELEVANCE_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 3) break;
  }
  return out;
}

function buildTechnicalFallbackKeywords(question) {
  const noisy = new Set([
    "build",
    "call",
    "compare",
    "demo",
    "design",
    "differ",
    "difference",
    "did",
    "do",
    "doe",
    "done",
    "explain",
    "handle",
    "implement",
    "make",
    "repeat",
    "share",
    "show",
    "simulate",
    "tell",
    "walk",
    "work",
  ]);
  return buildFallbackQuestionKeywords(question).filter((token) => !noisy.has(token));
}

function buildGeneralFallbackKeywords(question) {
  const noisy = new Set([
    "apply",
    "applied",
    "area",
    "areas",
    "biggest",
    "company",
    "day",
    "far",
    "fit",
    "greatest",
    "identify",
    "identified",
    "improve",
    "improvement",
    "interview",
    "interviewing",
    "job",
    "made",
    "main",
    "position",
    "project",
    "projects",
    "role",
    "team",
    "today",
    "want",
    "work",
    "worked",
  ]);
  return buildFallbackQuestionKeywords(question).filter((token) => !noisy.has(token));
}

function buildQuestionSpecificTechnicalFallbackOutline(questionText) {
  const seed = normalizeWhitespace(questionText).toLowerCase();
  const out = [];
  const add = (line) => {
    const s = sanitizeTalkingPointBullet(line);
    if (!s || isTemplateLikeLine(s) || out.includes(s)) return;
    out.push(s);
  };

  if (/\b(?:llm|language model|prompt|retrieval|rag|hallucinat|wrong answer|wrong answers)\b/.test(seed)) {
    add("Collect failing examples and compare expected answers against LLM outputs");
    add("Inspect prompt, retrieved context, tool calls, generation settings, and post-processing separately");
    add("Add eval cases before changing prompts, retrieval parameters, or provider configuration");
    add("If RAG is involved, verify chunking, source relevance, and citation traces first");
  } else if (/\b(?:docker|container|kubernetes|pod)\b/.test(seed)) {
    add("Check runtime status, restart count, image, command, and exposed ports");
    add("Read container logs first and separate application errors from platform errors");
    add("Exec into the container only after logs identify what to inspect");
    add("Validate the fix with a minimal repro and restart-safe deployment");
  } else if (/\b(?:adsl|vdsl)\b/.test(seed)) {
    add("Compare ADSL and VDSL by speed, upload symmetry, distance, and frequency range");
    add("Explain that VDSL is faster but degrades more quickly with distance");
    add("Mention both usually run over copper phone lines with different DSL profiles");
    add("Tie the choice to cabinet distance, upload needs, and provider availability");
  } else if (/\b(?:s3|bucket|object key|presigned|pre-signed|object storage)\b/.test(seed)) {
    add("Define bucket, key naming, metadata, ownership, and access-control boundaries");
    add("Use presigned URLs or scoped credentials with explicit expiration");
    add("Cover lifecycle policies, cost controls, encryption, and audit logging");
    add("Plan failure handling for retries, missing objects, and stale links");
  } else if (/\b(?:vector database|embedding|embeddings|chunk|chunks|chunking)\b/.test(seed)) {
    add("Split source documents into bounded chunks with overlap before embedding them");
    add("Store embeddings with source ID, chunk index, text, and metadata for traceability");
    add("Tune chunk size against retrieval quality, context length, and latency");
    add("Validate retrieval with known questions before changing the model prompt");
  } else if (/\b(?:file|files|csv|log|large|huge|millions?|numeric ids?|integer ids?|exception|exceptions)\b/.test(seed)) {
    add("Stream the files and validate each record before joining or comparing data");
    add("Handle numeric IDs explicitly so parsing and comparison stay deterministic");
    add("Report malformed rows, missing fields, and exception paths without crashing");
    add("Keep memory bounded and explain complexity for the expected input size");
  } else if (/\b(?:array|string|tree|graph|hashmap|hash map|linked list|binary search|dynamic programming|two sum)\b/.test(seed)) {
    add("Restate inputs, outputs, constraints, and edge cases before coding");
    add("Choose the data structure that gives the required time and space complexity");
    add("Walk through correctness on a small example before final implementation");
    add("Call out duplicate, empty, null, and boundary cases explicitly");
  }

  return out.slice(0, MAX_TALKING_POINTS);
}

function isPastProjectsAsk(questionText) {
  const s = normalizeWhitespace(questionText).toLowerCase();
  if (!s) return false;
  return (
    /\bprojects?\b/.test(s) &&
    /\b(?:worked on|have you worked on|kind of|types of|in the past|past)\b/.test(s)
  );
}

function buildGenericFallbackOutline(questionType, questionText) {
  const effectiveType = normalizeQuestionType(questionType);
  if (isClarificationRepeatAsk(questionText)) {
    return [
      "Ask which specific point they want repeated if the unclear part is not obvious",
      "Repeat that point more simply and in fewer words",
      "Check whether they want more detail or an example after the repeat",
    ];
  }
  if (isTransferableSkillsAsk(questionText)) {
    return [
      "Communication under pressure, calm problem solving, and clear follow-through are the strongest transferable skills here",
      "A concrete example from previous work makes each skill credible",
      "The value is how those habits help customers feel heard and get issues resolved",
    ];
  }
  if (isCareerChangeCommitmentAsk(questionText)) {
    return [
      "The change needs to sound intentional rather than like a backup plan",
      "The answer should explain why this role still fits even if options reopen in the previous field",
      "Credible commitment matters more than overpromising permanence",
    ];
  }
  if (isPastProjectsAsk(questionText)) {
    return [
      "Group the answer by the most relevant project types or problem areas",
      "For each example, cover the goal, your role, and the outcome",
      "Prioritize the projects that best match this role instead of listing everything",
    ];
  }
  if (isRevisitTopicsAsk(questionText)) {
    return [
      "It is fine to say the first interview covered the role well if nothing important feels incomplete",
      "If one answer needs more detail, clarify the exact example, decision, or impact instead of reopening everything",
      "The follow-up should sharpen one point, not introduce a brand-new story",
    ];
  }
  if (isImplementationLanguageAsk(questionText)) {
    return [
      "State the primary implementation language first",
      "Separate the core engine or runtime from scripting or extension languages",
      "Mention secondary or historical languages only as supporting context",
    ];
  }
  if (isDifferenceComparisonAsk(questionText)) {
    const compared = extractComparedTerms(questionText);
    const left = compared?.left || "the first option";
    const right = compared?.right || "the second option";
    return [
      `Define ${left} and ${right} before comparing them`,
      `Compare ${left} and ${right} on the same dimensions: capability, constraints, and typical use`,
      `Close with when ${left} is the better fit and when ${right} is`,
    ];
  }
  if (isMaximumLimitAsk(questionText)) {
    return [
      "State the concrete limit first",
      "Explain why that limit exists and what fails when you exceed it",
      "Add the standard workaround if the requirement goes beyond that limit",
    ];
  }
  if (isCandidateQuestionsPrompt(questionText)) {
    return [
      "What does success look like in the first 90 days?",
      "What are the biggest priorities for this role right now?",
      "How is the team structured and how does it collaborate day to day?",
      "What are the main challenges for the person stepping into this role?",
    ];
  }
  if (isMotivationOrFitAsk(questionText)) {
    return [
      "This role fits the kind of problems I want to work on and where I can contribute quickly",
      "My background gives me a strong base for the team’s needs without overstating company-specific knowledge",
      "I see this as a strong mutual fit because I can add value quickly and keep growing in the role",
    ];
  }
  if (isExperienceBehavioralAsk(questionText)) {
    return [
      "The situation and stakes should be clear before the action",
      "The action should show what you personally did and why you chose it",
      "The result should show what changed and what you learned",
    ];
  }
  if (isWeaknessAsk(questionText)) {
    return [
      "Choose one real weakness that is fixable and not central to the role",
      "Explain the habit or change that keeps it under control",
      "Evidence of progress makes the answer credible",
    ];
  }
  if (isSelfIntroductionAsk(questionText)) {
    return [
      "Past experience, current focus, and fit for this role should connect cleanly",
      "Only the background that helps this interview should stay in the answer",
      "The ending should make the transition to this opportunity obvious",
    ];
  }
  if (isSalaryExpectationsAsk(questionText)) {
    return [
      "The range should reflect the level, scope, and full package",
      "Flexibility matters until the responsibilities are fully clear",
      "A grounded range is better than anchoring too early",
    ];
  }
  if (isAvailabilityStartAsk(questionText)) {
    return [
      "Use the earliest realistic start date, not an optimistic guess",
      "State any notice period or relocation constraint clearly",
      "Flexibility helps once the hiring timeline is known",
    ];
  }
  if (effectiveType === "coding" || effectiveType === "system_design") {
    const specific = buildQuestionSpecificTechnicalFallbackOutline(questionText);
    if (specific.length >= MIN_TALKING_POINTS) return specific;

    const technicalKeywords = buildTechnicalFallbackKeywords(questionText);
    const technicalFocus = technicalKeywords.slice(0, 3).join(" ");
    if (technicalFocus && technicalFocus.length >= 4) {
      return [
        `State the exact inputs, outputs, and constraints for ${technicalFocus}`,
        `Choose concrete data flow and algorithm steps for ${technicalFocus}`,
        `Test ${technicalFocus} against edge cases, failures, and expected scale`,
      ];
    }
    return [
      "Restate the technical inputs, outputs, and constraints before proposing a solution",
      "Walk through the concrete execution path from input to result",
      "Validate correctness with edge cases, failure modes, and expected scale",
    ];
  }
  if (effectiveType === "behavioral") {
    const behavioralFocus = buildGeneralFallbackKeywords(questionText).slice(0, 2).join(" and ");
    if (behavioralFocus) {
      return [
        `The example should stay centered on ${behavioralFocus} and remain concrete`,
        "The action should make your role, judgment, and communication clear",
        "The outcome should show what changed and what you learned",
      ];
    }
    return [
      "The context should make the challenge and goal clear",
      "The answer should focus on your specific actions and communication",
      "The ending should show the result and the lesson carried forward",
    ];
  }
  const fallbackKeywords = buildGeneralFallbackKeywords(questionText);
  const fallbackFocus = fallbackKeywords.slice(0, 2).join(" and ");
  if (fallbackFocus) {
    return [
      `The answer should stay centered on ${fallbackFocus}`,
      "One concrete example or reason makes the point believable",
      "The value for the role, team, or customer should be explicit",
    ];
  }
  return [
    "The answer should address the exact ask directly and stay specific",
    "One concrete example or supporting reason is usually enough",
    "The ending should make the outcome, tradeoff, or next step clear",
  ];
}

function buildGenericFallbackDontMiss(questionType, questionText) {
  const effectiveType = normalizeQuestionType(questionType);
  if (isClarificationRepeatAsk(questionText)) {
    return [
      "Do not restart the entire answer if only one part was unclear",
      "Avoid pretending they asked a different question than the part they want repeated",
    ];
  }
  if (isTransferableSkillsAsk(questionText)) {
    return [
      "Avoid listing abstract strengths without tying them to daily customer service work",
      "Do not claim direct customer service experience if the transfer is really from another field",
    ];
  }
  if (isRevisitTopicsAsk(questionText)) {
    return [
      "Avoid inventing confusion just to fill the answer",
      "Do not reopen every topic if only one point needs more detail",
    ];
  }
  if (isCareerChangeCommitmentAsk(questionText)) {
    return [
      "Avoid sounding as if this role is only a temporary backup plan",
      "Do not promise forever; show credible intent and honesty instead",
    ];
  }
  if (isImplementationLanguageAsk(questionText)) {
    return [
      "Avoid mixing the core implementation language with the scripting API",
      "Do not claim a deprecated or peripheral language is the main implementation",
    ];
  }
  if (isDifferenceComparisonAsk(questionText)) {
    return [
      "Avoid listing features without comparing the same dimensions side by side",
      "Do not pretend an ambiguous term is standard; clarify it if needed",
    ];
  }
  if (isMaximumLimitAsk(questionText)) {
    return [
      "Avoid giving only a workaround without stating the actual limit",
      "Do not ignore the protocol or signal reason behind the limit",
    ];
  }
  if (isCandidateQuestionsPrompt(questionText)) {
    return [
      "Avoid asking about topics that were already covered",
      "Do not lead with salary, perks, or PTO only",
    ];
  }
  if (isMotivationOrFitAsk(questionText)) {
    return [
      "Avoid inventing company-specific mission, culture, product, or customer details",
      "Do not make compensation sound like the main reason you want the role",
    ];
  }
  if (isWeaknessAsk(questionText)) {
    return [
      "Avoid giving a fake weakness that sounds like a hidden strength",
      "Do not choose a weakness that is central to the job’s core requirements",
    ];
  }
  if (isSelfIntroductionAsk(questionText)) {
    return [
      "Avoid walking through your full resume line by line",
      "Do not spend so long on background that you delay why it is relevant here",
    ];
  }
  if (isSalaryExpectationsAsk(questionText)) {
    return [
      "Avoid naming a rigid number without context",
      "Do not anchor on compensation before signaling flexibility and fit",
    ];
  }
  if (isAvailabilityStartAsk(questionText)) {
    return [
      "Avoid inventing a current employer, notice period, or relocation plan",
      "Do not commit to an exact start date before checking your real constraints",
    ];
  }
  if (effectiveType === "coding" || effectiveType === "system_design") {
    const lower = normalizeWhitespace(questionText).toLowerCase();
    if (/\b(?:llm|language model|prompt|retrieval|rag|hallucinat|wrong answer|wrong answers)\b/.test(lower)) {
      return [
        "Avoid changing prompt, retrieval, and model settings all at once",
        "Do not debug without failing examples and expected answers",
      ];
    }
    if (/\b(?:vector database|embedding|embeddings|chunk|chunks|chunking)\b/.test(lower)) {
      return [
        "Avoid chunks so large that retrieval returns diluted context",
        "Do not store embeddings without source metadata and traceability",
      ];
    }
    if (/\b(?:docker|container|kubernetes|pod)\b/.test(lower)) {
      return [
        "Avoid exec debugging before checking logs and restart state",
        "Do not fix only the shell symptom without validating container restart behavior",
      ];
    }
    return [
      "Avoid answering a different technical problem",
      "Do not skip the concrete constraints stated in the prompt",
    ];
  }
  return [
    "Avoid vague claims without a concrete example",
    "Do not overstate ownership or impact",
  ];
}

function buildGuaranteedCardsFallback({
  questionText,
  canonicalQuestion,
  questionType,
  brief,
  recentTurns,
  failedOutputs,
}) {
  const bestQuestion =
    sanitizeQuestionLine(canonicalQuestion, DEFAULT_QUESTION_MAX_WORDS) ||
    sanitizeQuestionLine(questionText, DEFAULT_QUESTION_MAX_WORDS) ||
    sanitizeQuestionLine(
      Array.isArray(recentTurns) ? recentTurns.map((t) => (t && t.speaker === "Interviewer" ? t.text : "")).filter(Boolean).slice(-1)[0] || "" : "",
      DEFAULT_QUESTION_MAX_WORDS,
    ) ||
    "Describe the current interviewer ask";

  const fallbackQuestionTypeBase =
    normalizeQuestionType(questionType) !== "other"
      ? normalizeQuestionType(questionType)
      : inferQuestionTypeFromAskText(bestQuestion);
  const inferredType = resolveQuestionTypeFromAsk({
    parsedQuestionType: fallbackQuestionTypeBase,
    askText: bestQuestion,
    fallbackQuestionType: fallbackQuestionTypeBase,
  });
  const technicalContextTokens = buildTechnicalContextTokenSet({
    questionText,
    canonicalQuestion,
    recentTurns,
  });
  const currentAskTokens = buildCurrentAskTokenSet(questionText, canonicalQuestion);
  const priorTurnTokens = buildPriorTurnTokenSet(
    recentTurns,
    canonicalQuestion || questionText,
  );
  const briefTokenSet = buildBriefTokenSet(brief);
  const allowCandidateQuestionLines = isCandidateQuestionsPrompt(
    canonicalQuestion || questionText,
  );
  const allowSelfSpecificClaims = isTechnicalFamiliarityAsk(
    canonicalQuestion || questionText,
  );
  const groundingTokens = buildGroundingTokenSet({
    brief,
    recentTurns,
    questionText,
    canonicalQuestion,
  });

  const recovered = [];
  const recoveredDontMiss = [];
  const failed = Array.isArray(failedOutputs) ? failedOutputs : [];
  for (const raw of failed) {
    const cands = extractOutlineCandidatesFromRawText(raw);
    for (const cand of cands) {
      const line = sanitizeTalkingPointBullet(cand);
      if (!line || isTemplateLikeLine(line) || isLikelyClippedResponseLine(line)) continue;
      if (
        !isValidTalkingPointByType(line, inferredType, {
          technicalContextTokens,
          currentAskTokens,
          priorTurnTokens,
          askText: canonicalQuestion || questionText || bestQuestion,
          briefTokens: briefTokenSet,
          groundingTokens,
          allowCandidateQuestionLines,
          allowSelfSpecificClaims,
          allowPriorOverlap: allowSelfSpecificClaims,
        })
      ) {
        continue;
      }
      if (
        (inferredType === "coding" || inferredType === "system_design") &&
        isLikelyResumeBleedTechnicalLine(line, {
          contextTokens: technicalContextTokens,
          briefTokens: briefTokenSet,
        })
      ) {
        continue;
      }
      if (recovered.includes(line)) continue;
      recovered.push(line);
      if (recovered.length >= MAX_TALKING_POINTS) break;
    }
    const dontMissCands = extractDontMissCandidatesFromRawText(raw);
    for (const cand of dontMissCands) {
      const line = sanitizeDontMissBullet(cand);
      if (!line) continue;
      if (recoveredDontMiss.includes(line)) continue;
      recoveredDontMiss.push(line);
      if (recoveredDontMiss.length >= 2) break;
    }
    if (recovered.length >= MAX_TALKING_POINTS) break;
  }

  const familiaritySubject = allowSelfSpecificClaims
    ? extractTechnicalFamiliaritySubject(bestQuestion)
    : "";
  if (allowSelfSpecificClaims && recovered.length < MIN_TALKING_POINTS && familiaritySubject) {
    const subject = familiaritySubject;
    const fallbackLines = [
      `I understand where ${subject} fits and what problems it is used to solve`,
      `I would describe the parts of ${subject} I have used directly and keep the scope honest`,
      `I can ramp quickly from adjacent experience if deeper ${subject} work is needed`,
    ];
    for (const cand of fallbackLines) {
      const line = sanitizeTalkingPointBullet(cand);
      if (!line || recovered.includes(line)) continue;
      if (
        !isValidTalkingPointByType(line, inferredType, {
          technicalContextTokens,
          currentAskTokens,
          priorTurnTokens,
          askText: canonicalQuestion || questionText || bestQuestion,
          briefTokens: briefTokenSet,
          groundingTokens,
          allowCandidateQuestionLines,
          allowSelfSpecificClaims,
          allowPriorOverlap: true,
        })
      ) {
        continue;
      }
      recovered.push(line);
      if (recovered.length >= MAX_TALKING_POINTS) break;
    }
    const fallbackDontMissLines = [
      `Avoid overstating hands-on ${subject} experience`,
      `Do not claim production depth with ${subject} if your exposure was limited`,
    ];
    for (const cand of fallbackDontMissLines) {
      const line = sanitizeDontMissBullet(cand);
      if (
        !line ||
        isTemplateLikeLine(line) ||
        DONTMISS_STYLE_META_RE.test(line) ||
        isBrokenSchemaLikeLine(line, { allowDontMissPrefix: true }) ||
        isLikelyClippedResponseLine(line) ||
        recoveredDontMiss.includes(line)
      ) {
        continue;
      }
      recoveredDontMiss.push(line);
      if (recoveredDontMiss.length >= 2) break;
    }
  }

  const outline = normalizeStringList(recovered, {
    maxItems: MAX_TALKING_POINTS * 2,
    maxChars: 240,
  }).filter(
    (line) =>
      !isTemplateLikeLine(line) &&
      !isBrokenSchemaLikeLine(line) &&
      !isLikelyClippedResponseLine(line),
  );
  const dontMiss = normalizeDontMissBullets(recoveredDontMiss).filter(
    (line) =>
      !isTemplateLikeLine(line) &&
      !DONTMISS_STYLE_META_RE.test(line) &&
      !isBrokenSchemaLikeLine(line, { allowDontMissPrefix: true }) &&
      !isLikelyUnsafeDontMissLine(line) &&
      !isLikelyClippedResponseLine(line) &&
      !isLikelyLengthTruncatedResponseLine(line),
  );
  const fallbackOutlineSeed = buildGenericFallbackOutline(
    inferredType,
    canonicalQuestion || questionText || bestQuestion,
  );
  const preferRecoveredOnlyOutline =
    outline.length >= MIN_TALKING_POINTS ||
    (inferredType === "other" && outline.length >= 2);
  const fallbackDontMissSeed = buildGenericFallbackDontMiss(
    inferredType,
    canonicalQuestion || questionText || bestQuestion,
  );
  const finalOutline = dedupeNearDuplicateOutlineLines(
    normalizeStringList(
      preferRecoveredOnlyOutline ? outline : [...outline, ...fallbackOutlineSeed],
      {
        maxItems: Math.max(
          MAX_TALKING_POINTS * 2,
          MAX_TALKING_POINTS + fallbackOutlineSeed.length,
        ),
        maxChars: 240,
      },
    ).filter(
      (line) =>
        !isTemplateLikeLine(line) &&
        !isBrokenSchemaLikeLine(line) &&
        !isLikelyClippedResponseLine(line),
    ),
  );
  const finalDontMiss = normalizeDontMissBullets([
    ...dontMiss,
    ...fallbackDontMissSeed,
  ]).filter(
    (line) =>
      !isTemplateLikeLine(line) &&
      !DONTMISS_STYLE_META_RE.test(line) &&
      !isBrokenSchemaLikeLine(line, { allowDontMissPrefix: true }) &&
      !isLikelyUnsafeDontMissLine(line) &&
      !isLikelyClippedResponseLine(line) &&
      !isLikelyLengthTruncatedResponseLine(line),
  );

  return {
    question: bestQuestion,
    firstSentence: "",
    firstSentenceIsFallback: false,
    outline: finalOutline.slice(0, MAX_TALKING_POINTS),
    dontMiss: finalDontMiss.slice(0, 2),
    questionType: inferredType,
    confidence: 0.3,
    cardsAreFallback: true,
    cardsFallbackReason:
      outline.length > 0 || dontMiss.length > 0
        ? "runtime_recovered_only"
        : "runtime_generic_fallback",
    debug: {
      source: "runtime_guaranteed",
      finishReason: "fallback",
    },
  };
}

function minRecoveredFallbackOutlineCount(questionType) {
  const effectiveType = normalizeQuestionType(questionType);
  if (effectiveType === "other") return 2;
  return MIN_TALKING_POINTS;
}

function buildHardConstraintHints(sourceAsk) {
  const ask = normalizeWhitespace(sourceAsk).toLowerCase();
  if (!ask) return [];
  const hints = [];
  const add = (key, bullet, patterns, options = {}) => {
    if (hints.some((hint) => hint.key === key)) return;
    hints.push({
      key,
      bullet,
      patterns: Array.isArray(patterns) ? patterns : [],
      contradiction: options.contradiction || null,
    });
  };

  if (
    /\b(?:cannot|can't|can not|must not|don't|do not|without|no)\b[\s\S]{0,80}\b(?:distribut(?:e|ed|ion)|parallel|queue|worker|external|storage|database|service)\b/i.test(
      ask,
    )
  ) {
    add(
      "no-distribution",
      "Respect the constraint that work cannot be distributed or moved to external systems",
      [/distribut/i, /external/i, /queue/i, /single/i, /constraint/i],
      {
        contradiction:
          /\b(?:add|use|introduce|offload|move|push|send|store)\b[\s\S]{0,70}\b(?:queue|kafka|worker|external|s3|object storage|separate service|distributed)\b/i,
      },
    );
  }
  if (/\b(?:exception|exceptions|error handling|invalid|malformed)\b/i.test(ask)) {
    add(
      "exceptions",
      "Cover exception handling and invalid-input behavior explicitly",
      [/exception/i, /error/i, /invalid/i, /malformed/i],
    );
  }
  if (/\b(?:numeric ids?|integer ids?|ids? are numbers?|parse ids?)\b/i.test(ask)) {
    add(
      "numeric-ids",
      "Account for numeric IDs, parsing, and comparison edge cases",
      [/numeric/i, /\bids?\b/i, /parse/i, /integer/i],
    );
  }
  if (/\b(?:two files|2 files|both files|multiple files|second file)\b/i.test(ask)) {
    add(
      "multiple-files",
      "Use both input files and define how their records are joined or compared",
      [/both files/i, /two files/i, /join/i, /compare/i],
    );
  }
  if (
    /\b(?:large|scale|volume|millions?|billions?|high[- ]?volume|huge|memory limit|performance)\b/i.test(
      ask,
    )
  ) {
    add(
      "scale",
      "Address large-volume performance and memory limits",
      [/large/i, /scale/i, /volume/i, /memory/i, /performance/i],
    );
  }
  if (/\b(?:line limit|few lines|one line|single line|limited lines)\b/i.test(ask)) {
    add(
      "line-limit",
      "Stay within the requested implementation or line-count constraint",
      [/line/i, /constraint/i, /implementation/i],
    );
  }
  if (
    /\b(?:s3|bucket|object key|presigned|pre-signed|object storage|blob storage)\b/i.test(
      ask,
    )
  ) {
    add(
      "object-storage",
      "Cover bucket/key design, expiration, security, and cost tradeoffs",
      [/bucket/i, /key/i, /expir/i, /security/i, /cost/i, /ttl/i],
    );
  }
  return hints;
}

function applyHardConstraintHintsToCards(cards, { sourceAsk = "", questionType = "" } = {}) {
  if (!cards || typeof cards !== "object") return cards;
  const effectiveType = normalizeQuestionType(questionType || cards.questionType);
  if (effectiveType !== "coding" && effectiveType !== "system_design") return cards;

  const hints = buildHardConstraintHints(sourceAsk);
  if (hints.length === 0) return cards;

  const outline = Array.isArray(cards.outline) ? cards.outline.filter(Boolean) : [];
  const dontMiss = Array.isArray(cards.dontMiss) ? cards.dontMiss.filter(Boolean) : [];
  const removedContradictionKeys = new Set();
  let filteredOutline = outline.filter((line) => {
    const text = normalizeWhitespace(line);
    if (!text) return false;
    const contradiction = hints.find(
      (hint) =>
        hint.contradiction &&
        hint.contradiction.test(text) &&
        !/\b(?:avoid|do not|don't|cannot|can't|without|instead of|rather than)\b/i.test(text),
    );
    if (contradiction) {
      removedContradictionKeys.add(contradiction.key);
      return false;
    }
    return true;
  });
  const bodyText = normalizeWhitespace(
    [cards.firstSentence, ...filteredOutline, ...dontMiss].join(" "),
  );

  const missingBullets = [];
  for (const hint of hints) {
    const mentioned =
      !removedContradictionKeys.has(hint.key) &&
      hint.patterns.some((pattern) => pattern.test(bodyText));
    if (!mentioned) missingBullets.push(hint.bullet);
  }
  if (missingBullets.length === 0 && filteredOutline.length === outline.length) {
    return cards;
  }

  filteredOutline = dedupeNearDuplicateOutlineLines(
    normalizeStringList([...missingBullets, ...filteredOutline], {
      maxItems: MAX_TALKING_POINTS,
      maxChars: 240,
    }),
  );
  return {
    ...cards,
    outline: filteredOutline,
  };
}

function normalizeStringList(list, { maxItems = 4, maxChars = 200 } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = finalizeDisplayLine(item, maxChars);
    if (!text) continue;
    if (isBrokenSchemaLikeLine(text, { allowDontMissPrefix: true })) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

const FINAL_DANGLING_TAIL_WORDS = new Set([
  "and",
  "or",
  "to",
  "for",
  "with",
  "as",
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "by",
  "from",
  "when",
  "while",
  "because",
  "that",
  "which",
  "who",
  "what",
  "where",
  "how",
  "after",
  "before",
  "during",
  "through",
  "using",
  "via",
  "causing",
  "so",
  "leading",
  "allowing",
  "resulting",
  "making",
  "creating",
  "out",
  "like",
  "such",
  "without",
  "unless",
]);

function trimDanglingTailWords(value, danglingWords = FINAL_DANGLING_TAIL_WORDS) {
  const words = tokenizeWords(value);
  while (words.length >= 3) {
    const tail = String(words[words.length - 1] || "").toLowerCase();
    if (!danglingWords.has(tail)) break;
    words.pop();
  }
  return words.join(" ");
}

function finalizeDisplayLine(value, maxChars = 0) {
  let text = trimWholeWordsEndLocal(value, maxChars);
  if (!text) return "";
  text = text
    .replace(/\s*(?:["'`]|,\s*)+$/g, "")
    .replace(/[,:;.\-–—]+$/g, "")
    .trim();
  text = trimDanglingTailWords(text);
  text = text
    .replace(/\s*(?:["'`]|,\s*)+$/g, "")
    .replace(/[,:;.\-–—]+$/g, "")
    .trim();
  return text;
}

function stripTerminalPunctuation(value) {
  return normalizeWhitespace(value)
    .replace(/[’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‑–—]/g, "-")
    .replace(/[.!?]+$/g, "")
    .trim();
}

const OUTLINE_DEDUPE_STOPWORDS = new Set([
  "define",
  "defined",
  "explain",
  "explained",
  "describe",
  "described",
  "mention",
  "mentioned",
  "highlight",
  "highlighted",
  "clarify",
  "clarified",
  "show",
  "showed",
  "using",
  "used",
  "enable",
  "enables",
  "enabled",
  "allow",
  "allows",
  "allowing",
  "optionally",
  "exactly",
  "concise",
  "implementation",
  "implementations",
  "patterns",
  "pattern",
  "assigned",
  "assignment",
  "marked",
  "mark",
]);

function normalizeOutlineDedupeToken(token) {
  let normalized = normalizeTechnicalToken(token);
  if (!normalized) return "";
  if (/ies$/i.test(normalized) && normalized.length > 5) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (
    /s$/i.test(normalized) &&
    normalized.length > 4 &&
    !/(?:ss|us|is)$/i.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function dedupeOutlineAgainstFirstSentence(lines, firstSentence) {
  const first = stripTerminalPunctuation(firstSentence).toLowerCase();
  if (!first || !Array.isArray(lines)) return Array.isArray(lines) ? lines : [];
  return lines.filter((line) => {
    const normalized = stripTerminalPunctuation(line).toLowerCase();
    return normalized && normalized !== first;
  });
}

function dedupeNearDuplicateOutlineLines(lines) {
  const out = [];
  const seen = [];
  const seenCoreUnion = new Set();
  for (const line of Array.isArray(lines) ? lines : []) {
    const normalized = stripTerminalPunctuation(line).toLowerCase();
    if (!normalized) continue;
    const tokens = new Set(
      tokenizeSemantic(normalized)
        .map((token) => normalizeOutlineDedupeToken(token))
        .filter((token) => token && token.length >= 4),
    );
    const coreTokens = new Set(
      [...tokens].filter((token) => !OUTLINE_DEDUPE_STOPWORDS.has(token)),
    );
    let duplicate = false;
    for (const prev of seen) {
      if (normalized === prev.normalized) {
        duplicate = true;
        break;
      }
      if (
        normalized.includes(prev.normalized) ||
        prev.normalized.includes(normalized)
      ) {
        duplicate = true;
        break;
      }
      if (tokens.size === 0 || prev.tokens.size === 0) continue;
      let overlap = 0;
      for (const token of tokens) {
        if (prev.tokens.has(token)) overlap += 1;
      }
      const denom = Math.max(tokens.size, prev.tokens.size);
      if (denom > 0 && overlap / denom >= 0.75) {
        duplicate = true;
        break;
      }
      const smallerDenom = Math.min(tokens.size, prev.tokens.size);
      if (smallerDenom >= 4 && overlap / smallerDenom >= 0.8) {
        duplicate = true;
        break;
      }
      if (coreTokens.size > 0 && prev.coreTokens.size > 0) {
        let coreOverlap = 0;
        for (const token of coreTokens) {
          if (prev.coreTokens.has(token)) coreOverlap += 1;
        }
        const coreSmallerDenom = Math.min(coreTokens.size, prev.coreTokens.size);
        if (coreSmallerDenom >= 3 && coreOverlap / coreSmallerDenom >= 0.8) {
          duplicate = true;
          break;
        }
      }
    }
    if (!duplicate && coreTokens.size >= 5 && seenCoreUnion.size > 0) {
      let priorCoverage = 0;
      for (const token of coreTokens) {
        if (seenCoreUnion.has(token)) priorCoverage += 1;
      }
      if (priorCoverage / coreTokens.size >= 0.65) {
        duplicate = true;
      }
    }
    if (duplicate) continue;
    out.push(line);
    seen.push({ normalized, tokens, coreTokens });
    for (const token of coreTokens) seenCoreUnion.add(token);
  }
  return out;
}

const GROUNDING_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "you",
  "about",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "will",
  "would",
  "could",
  "should",
  "into",
  "over",
  "them",
  "they",
  "their",
  "there",
  "then",
  "than",
  "just",
  "that",
  "i",
  "my",
  "me",
  "we",
  "our",
  "us",
]);

function groundingTokenSetFromText(text) {
  return new Set(
    normalizeWhitespace(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(" ")
      .map((t) => t.trim())
      .filter((t) => t && t.length >= 4 && !GROUNDING_STOPWORDS.has(t)),
  );
}

function buildGroundingTokenSet({ brief, recentTurns, questionText, canonicalQuestion }) {
  const transcript = (Array.isArray(recentTurns) ? recentTurns : [])
    .map((t) => (t && typeof t.text === "string" ? t.text : ""))
    .filter(Boolean)
    .join(" ");
  const source = [
    typeof brief === "string" ? brief : "",
    transcript,
    typeof questionText === "string" ? questionText : "",
    typeof canonicalQuestion === "string" ? canonicalQuestion : "",
  ]
    .filter(Boolean)
    .join(" ");
  return groundingTokenSetFromText(source);
}

function isPotentiallyUngroundedSpecificLine(
  line,
  groundingTokens,
  { strictMode = false } = {},
) {
  const text = normalizeWhitespace(line);
  if (!text) return false;
  if (!(groundingTokens instanceof Set) || groundingTokens.size === 0) return false;

  const tokens = Array.from(groundingTokenSetFromText(text));
  if (tokens.length < 3) return false;
  let unmatched = 0;
  for (const token of tokens) {
    if (!groundingTokens.has(token)) unmatched += 1;
  }
  const unmatchedRatio = unmatched / tokens.length;
  const hasPlanHorizon = /\b(?:30|60|90)[-\s]day\b/i.test(text);
  const hasNumber = !hasPlanHorizon && /\b\d+(?:[.,]\d+)?%?\b/.test(text);
  const hasNamedEntityLike = /\s[A-Z][a-z]{2,}\b/.test(text);
  const hasQuotedOrAcronym = /["'][^"']+["']|\b[A-Z]{2,}\b/.test(text);
  const specificSignal = hasNumber || hasNamedEntityLike || hasQuotedOrAcronym;
  if (!specificSignal) return false;

  if (strictMode) {
    return unmatched >= 2 && unmatchedRatio >= 0.34;
  }
  return unmatched >= 3 && unmatchedRatio >= 0.55;
}

function coerceBulletList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x ?? ""));
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];
    const splitByLines = raw
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (splitByLines.length > 1) return splitByLines;
    if (!raw.includes(";")) return splitByLines;
    return raw
      .split(/\s*;\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (value && typeof value === "object") {
    const nested =
      value.items || value.points || value.bullets || value.talkingPoints || value.talking_points;
    if (Array.isArray(nested)) return nested.map((x) => String(x ?? ""));
  }
  return [];
}

function buildLiveCoachSystemPrompt(answerLanguage) {
  const language =
    typeof answerLanguage === "string" && answerLanguage.trim()
      ? answerLanguage.trim()
      : "English";
  return [
    "You are Live Coach.",
    "Return exactly one JSON object with keys questionType, question, firstSentence, outline, dontMiss, confidence.",
    "Summarize the interviewer ask.",
    "Give one short opening sentence.",
    `Give ${MIN_TALKING_POINTS}-${MAX_TALKING_POINTS} short talking points the candidate can actually say.`,
    'Give 1-2 short pitfalls starting with "Avoid" or "Do not".',
    "Behavioral: first person, grounded in provided candidate context.",
    "Technical: direct answer content, not first person.",
    "Every bullet must be a complete thought, never cut off mid-phrase.",
    "If company or role specifics are missing, stay generic and do not invent mission, culture, products, tools, metrics, or customer facts.",
    "For motivation or fit asks without company context, stay in first person and keep reasons generic: role fit, learning, contribution, collaboration, or problem space.",
    "For experience questions without candidate story context, stay generic and do not invent employers, projects, technologies, architectures, metrics, or timelines.",
    "For direct familiarity asks about a tool or technology, answer in first person about familiarity, typical use, and honest limits. Never write 'Candidate'.",
    "If the interviewer is inviting the candidate to ask questions, outline must be 3-4 concise questions the candidate can ask back.",
    "Do not claim you know the company's mission, culture, focus, customers, or products unless they were provided.",
    'Never use placeholders like "X", "Y", "Z", or similar stand-ins.',
    "No coaching meta. No headings. No invented facts.",
    'Never narrate the rules or schema. Never write phrases like "We need to", "The schema requires", or "Given transcript".',
    'Never output placeholder bullets like "point1", "point2", "item1", or "step1".',
    'Never use filler openers like "Sure, here\'s a concise overview".',
    `Language: ${language}`,
  ].join("\n");
}

function buildLiveCoachTechnicalCardsSystemPrompt(answerLanguage) {
  const language =
    typeof answerLanguage === "string" && answerLanguage.trim()
      ? answerLanguage.trim()
      : "English";
  return [
    "You are Live Coach for technical questions.",
    "Return exactly one JSON object with keys questionType, question, firstSentence, outline, dontMiss, confidence.",
    "Summarize the technical ask.",
    "Give one direct technical opening sentence.",
    `Give ${MIN_TALKING_POINTS}-${MAX_TALKING_POINTS} short technical talking points.`,
    "Use short, direct technical bullets with concrete verbs when helpful.",
    'Give 1-2 short technical pitfalls starting with "Avoid" or "Do not".',
    "Every bullet must be a complete thought, never cut off mid-phrase.",
    "Stay exactly on the asked topic.",
    "No coaching meta. No headings. No invented facts.",
    'Never narrate the rules or schema. Never write phrases like "We need to", "The schema requires", or "Given transcript".',
    'Never output placeholder bullets like "point1", "point2", "item1", or "step1".',
    'Never use filler openers like "Sure, here\'s a concise overview".',
    `Language: ${language}`,
  ].join("\n");
}

function isCompactTechnicalCardsQuestion(questionText, canonicalQuestion) {
  const ask = normalizeWhitespace(canonicalQuestion || questionText).toLowerCase();
  if (!ask) return false;
  const inferred = inferQuestionTypeFromAskText(ask);
  if (inferred !== "coding" && inferred !== "system_design") return false;
  if (
    /\b(?:your|you|have you|worked with|used|experience|background|project|resume|role)\b/i.test(
      ask,
    )
  ) {
    return false;
  }
  return /^(?:what(?:'s| is)?|how|why|which|when|where|explain|describe|compare|implement|design|difference between)\b/i.test(
    ask,
  );
}

function buildLiveCoachTechnicalCardsUserPrompt({
  questionText,
  canonicalQuestion,
}) {
  const promptRaw = normalizeWhitespace(questionText);
  const canonicalRaw = normalizeWhitespace(canonicalQuestion);
  const inferredType = inferQuestionTypeFromAskText(canonicalRaw || promptRaw);
  return [
    `Question type: ${inferredType}`,
    `Question: ${canonicalRaw || promptRaw || "(none)"}`,
    promptRaw && canonicalRaw && promptRaw !== canonicalRaw
      ? `Raw: ${promptRaw}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function selectLiveCoachPromptContext({
  brief,
  questionText,
  canonicalQuestion,
  maxCharsBehavioral = 8000,
  maxCharsGeneral = 8000,
  maxCharsTechnical = 8000,
} = {}) {
  const text = typeof brief === "string" ? brief.trim() : "";
  if (!text) return "";

  const ask = normalizeWhitespace(canonicalQuestion || questionText);
  const inferredType = inferQuestionTypeFromAskText(ask);
  const sections = text
    .split(/\n{2,}/g)
    .map((section) => section.trim())
    .filter(Boolean);
  const interviewSection =
    sections.find((section) => /^Interview context:/i.test(section)) || "";

  if (inferredType === "coding" || inferredType === "system_design") {
    return interviewSection
      ? safeTrimLocal(interviewSection, maxCharsTechnical, "end")
      : "";
  }

  // For behavioral questions, always include ALL brief sections (resume, JD, etc.)
  // so the AI can personalize answers like "tell me about yourself" with real background.
  if (inferredType === "behavioral") {
    const allSections = sections.filter((s) => s && s !== "---");
    if (allSections.length > 0) {
      return safeTrimLocal(allSections.join("\n\n"), maxCharsBehavioral, "end");
    }
    return "";
  }

  const askTokens = semanticTokenSet(ask);
  const chosen = [];
  if (interviewSection) chosen.push(interviewSection);

  for (const section of sections) {
    if (!section || section === interviewSection) continue;
    if (askTokens.size === 0) continue;
    const sectionTokens = semanticTokenSet(section);
    let overlap = 0;
    for (const token of sectionTokens) {
      if (askTokens.has(token)) overlap += 1;
    }
    if (overlap >= 1) chosen.push(section);
  }

  if (chosen.length === 0) {
    const fallbackSection =
      interviewSection || sections[0] || "";
    return fallbackSection
      ? safeTrimLocal(
        fallbackSection,
        maxCharsGeneral,
        "end",
      )
      : "";
  }

  const combined = chosen.join("\n\n");
  return safeTrimLocal(
    combined,
    maxCharsGeneral,
    "end",
  );
}

function buildLiveCoachUserPrompt({
  brief,
  recentTurns,
  questionText,
  canonicalQuestion,
}) {
  const promptRaw = typeof questionText === "string" ? questionText.trim() : "";
  const canonicalRaw =
    typeof canonicalQuestion === "string" ? canonicalQuestion.trim() : "";
  const technicalFamiliarityAsk = isTechnicalFamiliarityAsk(canonicalRaw || promptRaw);
  const turns0 = Array.isArray(recentTurns) ? recentTurns.slice(-6) : [];
  const turns = technicalFamiliarityAsk ? turns0.slice(-1) : turns0;
  const transcript = turns
    .map((t) => {
      const speaker = t && typeof t.speaker === "string" ? t.speaker : "Unknown";
      const text = t && typeof t.text === "string" ? t.text : "";
      return `[${speaker}] ${text}`.trim();
    })
    .filter(Boolean)
    .join("\n");
  const context = selectLiveCoachPromptContext({
    brief,
    questionText: promptRaw,
    canonicalQuestion: canonicalRaw,
  });
  const hasContext = !!context;
  const motivationWithoutContext =
    !hasContext && isMotivationOrFitAsk(canonicalRaw || promptRaw);
  const experienceWithoutContext =
    !hasContext && isExperienceBehavioralAsk(canonicalRaw || promptRaw);
  const candidateQuestionsPrompt = isCandidateQuestionsPrompt(canonicalRaw || promptRaw);

  const blocks = [];
  if (context) blocks.push(`Candidate context:\n${safeTrimLocal(context, 8000, "end")}`);
  if (motivationWithoutContext) {
    blocks.push(
      "Grounding note:\nNo company-specific context was provided. Keep motivations generic and first person. Do not invent mission, culture, products, tools, customers, or metrics.",
    );
  }
  if (experienceWithoutContext) {
    blocks.push(
      "Grounding note:\nNo candidate-specific story context was provided. Do not invent employers, projects, technologies, architectures, metrics, or timelines. Keep the answer generic but speakable.",
    );
  }
  if (technicalFamiliarityAsk) {
    blocks.push(
      "Grounding note:\nThis is a direct familiarity question about a tool or technology. Answer in first person. Do not use the word Candidate.",
    );
  }
  if (candidateQuestionsPrompt) {
    blocks.push(
      "Grounding note:\nThe interviewer is inviting the candidate to ask questions. Return actual short questions the candidate can ask back, not meta advice.",
    );
  }
  if (transcript) blocks.push(`Recent transcript:\n${transcript}`);
  if (canonicalRaw) {
    blocks.push(`Canonical question:\n${canonicalRaw}`);
  }
  blocks.push(`Question:\n${promptRaw || "(none)"}`);
  return blocks.join("\n");
}

function buildLiveCoachCardsRescueUserPrompt({
  brief,
  recentTurns,
  questionText,
  canonicalQuestion,
}) {
  const turns = Array.isArray(recentTurns) ? recentTurns.slice(-4) : [];
  const transcript = turns
    .map((t) => {
      const speaker = t && typeof t.speaker === "string" ? t.speaker : "Unknown";
      const text = t && typeof t.text === "string" ? normalizeWhitespace(t.text) : "";
      return `[${speaker}] ${safeTrimLocal(text, 220, "end")}`.trim();
    })
    .filter(Boolean)
    .join("\n");
  const promptRaw = normalizeWhitespace(questionText);
  const canonicalRaw = normalizeWhitespace(canonicalQuestion);
  const context = selectLiveCoachPromptContext({
    brief,
    questionText: promptRaw,
    canonicalQuestion: canonicalRaw,
    maxCharsBehavioral: 1200,
    maxCharsGeneral: 700,
    maxCharsTechnical: 220,
  });
  const motivationWithoutContext =
    !context && isMotivationOrFitAsk(canonicalRaw || promptRaw);
  const experienceWithoutContext =
    !context && isExperienceBehavioralAsk(canonicalRaw || promptRaw);
  const candidateQuestionsPrompt = isCandidateQuestionsPrompt(canonicalRaw || promptRaw);
  return [
    context
      ? `Candidate context:\n${safeTrimLocal(context, 1200, "end")}`
      : "Candidate context: (none)",
    motivationWithoutContext
      ? "Grounding note:\nNo company-specific context was provided. Keep motivations generic and first person. Do not invent mission, culture, products, tools, customers, or metrics."
      : "",
    experienceWithoutContext
      ? "Grounding note:\nNo candidate-specific story context was provided. Do not invent employers, projects, technologies, architectures, metrics, or timelines. Keep the answer generic but speakable."
      : "",
    candidateQuestionsPrompt
      ? "Grounding note:\nThe interviewer is inviting the candidate to ask questions. Return actual short questions the candidate can ask back, not meta advice."
      : "",
    transcript ? `Recent transcript:\n${transcript}` : "Recent transcript: (none)",
    `Canonical question:\n${canonicalRaw || "(none)"}`,
    `Raw interviewer question:\n${promptRaw || "(none)"}`,
    "Respond with the final JSON object only.",
    'Do not restate the rules, schema, or phrases like "We need to" or "Given transcript".',
    "No explanation text. No markdown. No extra keys.",
  ].join("\n\n");
}

function buildLiveCoachCardsRepairSystemPrompt(answerLanguage) {
  const language =
    typeof answerLanguage === "string" && answerLanguage.trim()
      ? answerLanguage.trim()
      : "English";
  return [
    "You repair Live Coach cards into strict JSON.",
    "Output exactly one JSON object and nothing else.",
    "No markdown. No prose. No code fences.",
    "Never restate rules, schema, field names, or instructions.",
    'Never write phrases like "We need to", "The schema requires", or "Given transcript".',
    "",
    'Required schema: {"questionType":"behavioral|system_design|coding|other","question":"...","firstSentence":"...","outline":["..."],"dontMiss":["..."],"confidence":0.0}',
    "",
    `question: one sentence, <= ${DEFAULT_QUESTION_MAX_WORDS} words, summarize interviewer ask.`,
    `outline: ${MIN_TALKING_POINTS}-${MAX_TALKING_POINTS} bullets, each <= ${DEFAULT_OUTLINE_MAX_WORDS} words, answer content only.`,
    "- No coaching templates, no meta instructions, no headings.",
    "- Behavioral bullets: first person speakable statements.",
    "- Technical bullets: answer content, not first person.",
    "- All bullets must stay on the question topic; remove unrelated resume/work-history claims.",
    "- Every bullet must be a complete thought, not a clipped fragment.",
    "- If company or role specifics are missing, keep motivations generic and do not invent mission, culture, products, tools, metrics, or customer facts.",
    "- For motivation or fit asks without company context, keep reasons generic and first person: role fit, learning, contribution, collaboration, or problem space.",
    "- For experience questions without candidate story context, stay generic and do not invent employers, projects, technologies, architectures, metrics, or timelines.",
    "- For direct familiarity asks about a tool or technology, use first person and never write 'Candidate'.",
    "- If the interviewer is inviting the candidate to ask questions, outline must be 3-4 concise questions the candidate can ask back.",
    "- Do not claim you know the company's mission, culture, focus, customers, or products unless they were provided.",
    '- Never use placeholders like "X", "Y", "Z", or similar stand-ins.',
    '- Delete placeholders like "point1", "point2", "item1", or "step1".',
    '- Delete filler openers like "Sure, here\'s a concise overview".',
    `dontMiss: 1-2 bullets, each <= ${DEFAULT_DONT_MISS_MAX_WORDS} words.`,
    '- Every dontMiss bullet must start with "Avoid ..." or "Do not ...".',
    "",
    `Language: ${language}`,
  ].join("\n");
}

function buildLiveCoachCardsRepairUserPrompt({
  brief,
  recentTurns,
  questionText,
  canonicalQuestion,
  expectedQuestionType,
  failedResponseText,
}) {
  const raw = normalizeWhitespace(questionText);
  const canonical = normalizeWhitespace(canonicalQuestion);
  const technicalFamiliarityAsk = isTechnicalFamiliarityAsk(canonical || raw);
  const turns0 = Array.isArray(recentTurns) ? recentTurns.slice(-6) : [];
  const turns = technicalFamiliarityAsk ? turns0.slice(-1) : turns0;
  const transcript = turns
    .map((t) => {
      const speaker = t && typeof t.speaker === "string" ? t.speaker : "Unknown";
      const text = t && typeof t.text === "string" ? normalizeWhitespace(t.text) : "";
      return `[${speaker}] ${safeTrimLocal(text, 220, "end")}`.trim();
    })
    .filter(Boolean)
    .join("\n");
  const context = selectLiveCoachPromptContext({
    brief,
    questionText,
    canonicalQuestion,
    maxCharsBehavioral: 1200,
    maxCharsGeneral: 700,
    maxCharsTechnical: 220,
  });
  const failed = safeTrimLocal(normalizeWhitespace(failedResponseText), 1800, "end");
  const motivationWithoutContext =
    !context && isMotivationOrFitAsk(canonical || raw);
  const experienceWithoutContext =
    !context && isExperienceBehavioralAsk(canonical || raw);
  const candidateQuestionsPrompt = isCandidateQuestionsPrompt(canonical || raw);
  return [
    context
      ? `Candidate context:\n${safeTrimLocal(context, 1200, "end")}`
      : "Candidate context: (none)",
    motivationWithoutContext
      ? "Grounding note:\nNo company-specific context was provided. Keep motivations generic and first person. Do not invent mission, culture, products, tools, customers, or metrics."
      : "",
    experienceWithoutContext
      ? "Grounding note:\nNo candidate-specific story context was provided. Do not invent employers, projects, technologies, architectures, metrics, or timelines. Keep the answer generic but speakable."
      : "",
    technicalFamiliarityAsk
      ? "Grounding note:\nThis is a direct familiarity question about a tool or technology. Answer in first person. Do not use the word Candidate."
      : "",
    candidateQuestionsPrompt
      ? "Grounding note:\nThe interviewer is inviting the candidate to ask questions. Return actual short questions the candidate can ask back, not meta advice."
      : "",
    transcript ? `Recent transcript:\n${transcript}` : "Recent transcript: (none)",
    `Expected question type:\n${normalizeQuestionType(expectedQuestionType || "other")}`,
    `Canonical question:\n${canonical || "(none)"}`,
    `Raw interviewer question:\n${raw || "(none)"}`,
    failed
      ? `Invalid prior model output to repair:\n${failed}`
      : "Invalid prior model output to repair:\n(none)",
    "Ignore any schema discussion in the invalid output and do not reuse its wording.",
    "Return a valid JSON object only.",
  ].join("\n\n");
}

function buildLiveCoachCardsOutlineRepairUserPrompt({
  questionText,
  canonicalQuestion,
  questionType,
  parsedCardsJson,
}) {
  const raw = normalizeWhitespace(questionText);
  const canonical = normalizeWhitespace(canonicalQuestion);
  const type = normalizeQuestionType(questionType || "");
  const payload =
    parsedCardsJson && typeof parsedCardsJson === "object"
      ? safeTrimLocal(JSON.stringify(parsedCardsJson), 1800, "end")
      : "{}";
  return [
    `Question type: ${type || "other"}`,
    `Canonical question:\n${canonical || "(none)"}`,
    `Raw interviewer question:\n${raw || "(none)"}`,
    `Current JSON (needs outline fix):\n${payload}`,
    `Fix it so "outline" contains ${MIN_TALKING_POINTS}-${MAX_TALKING_POINTS} valid bullets.`,
    'Delete any placeholder bullets like "point1", "point2", "item1", or "step1".',
    "Make every bullet a complete thought, not a clipped fragment.",
    "Keep content grounded and answer-like. Return valid JSON only.",
  ].join("\n\n");
}

function buildLiveCoachIntentSystemPrompt(answerLanguage, { forceDecision = false } = {}) {
  const language =
    typeof answerLanguage === "string" && answerLanguage.trim()
      ? answerLanguage.trim()
      : "English";
  const schema = forceDecision
    ? '{"action":"start_new_question|refine_current","questionType":"behavioral|system_design|coding|other","canonicalQuestion":"...","confidence":0.0}'
    : '{"action":"start_new_question|refine_current|ignore","questionType":"behavioral|system_design|coding|other","canonicalQuestion":"...","confidence":0.0}';
  return [
    "You are a real-time intent classifier for an interview Live Coach.",
    "Decide what to do with the latest turn in the conversation.",
    "",
    "Return EXACTLY one JSON object and nothing else (no prose, no markdown, no code fences).",
    "Valid JSON only: double quotes, no trailing commas.",
    'Never narrate the rules or schema. Never write phrases like "We need to", "The schema requires", or "Given transcript".',
    "",
    `Schema: ${schema}`,
    "",
    "Definitions:",
    "- start_new_question: a NEW question/task prompt the candidate should answer now.",
    "- refine_current: adds a subquestion/constraint/clarification to the current question.",
    ...(forceDecision
      ? ["- This call is boundary-forced: choose only start_new_question or refine_current."]
      : ["- ignore: backchannels, filler, or content that does not change what to answer next."]),
    "",
    "Rules:",
    "- Be boundary-accurate: use start_new_question whenever the latest interviewer turn changes what must be answered next.",
    ...(forceDecision
      ? [
        "- If the latest turn is speaker=User, pick refine_current unless they clearly quote a new interviewer ask.",
      ]
      : [
        '- If the latest turn is from speaker=User (the candidate), it is usually the candidate answering or thinking aloud: default to ignore.',
      ]),
    "- Only use start_new_question/refine_current on speaker=User if they are clearly reading/quoting the interviewer prompt (a question/task), not giving an answer.",
    "- If the latest interviewer turn introduces a different topic/competency than the current question, choose start_new_question.",
    "- Only use refine_current when the latest turn clearly adds subparts/constraints to the same active ask.",
    "- If the latest interviewer turn can stand alone as a separate ask, choose start_new_question.",
    "- Do not combine two independent asks into one canonicalQuestion; split by choosing start_new_question.",
    `- canonicalQuestion: 1 short sentence (<= ${DEFAULT_QUESTION_MAX_WORDS} words), summarize what is being asked (NOT an answer).`,
    "- If action=refine_current, canonicalQuestion must retain the current ask and add new subparts/constraints.",
    "- For refine_current, do not drop major subparts from the current ask unless the interviewer clearly replaces it.",
    "- Do not include transcript quotes or multiple sentences.",
    "",
    `Language: ${language}`,
  ].join("\n");
}

function buildLiveCoachIntentUserPrompt({
  currentQuestionText,
  currentQuestionType,
  candidateText,
  candidateSpeaker,
  recentTurns,
}) {
  const transcript = (Array.isArray(recentTurns) ? recentTurns.slice(-6) : [])
    .map((t) => {
      const speaker = t && typeof t.speaker === "string" ? t.speaker : "Unknown";
      const text = t && typeof t.text === "string" ? t.text : "";
      const clipped = safeTrimLocal(normalizeWhitespace(text), 280, "end");
      return `[${speaker}] ${clipped}`.trim();
    })
    .filter(Boolean)
    .join("\n");

  const speaker =
    typeof candidateSpeaker === "string" && candidateSpeaker.trim()
      ? candidateSpeaker.trim()
      : "Unknown";
  const clippedCurrentQuestion = safeTrimLocal(normalizeWhitespace(currentQuestionText), 260, "end");
  const clippedCandidateTurn = safeTrimLocal(normalizeWhitespace(candidateText), 420, "end");

  return [
    `Current question (${currentQuestionType || "unknown"}):\n${clippedCurrentQuestion || "(none)"}`,
    `Latest turn (speaker=${speaker}):\n${clippedCandidateTurn || "(none)"}`,
    transcript ? `Recent transcript:\n${transcript}` : "Recent transcript:\n(none)",
    'Output the JSON object now. Start with "{" and end with "}".',
  ].join("\n\n");
}

const INTENT_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "you",
  "about",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "will",
  "would",
  "could",
  "should",
  "into",
  "over",
  "them",
  "they",
  "their",
  "there",
  "then",
  "than",
  "just",
  "difference",
  "different",
  "between",
  "compare",
  "comparison",
  "versus",
  "vs",
  "explain",
  "describe",
  "tell",
  "share",
  "give",
  "example",
  "examples",
  "walk",
  "through",
  "time",
  "situation",
  "work",
  "role",
  "company",
  "job",
  "question",
  "interview",
]);

function intentTokenSet(text) {
  return new Set(
    normalizeWhitespace(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(" ")
      .map((t) => t.trim())
      .filter((t) => t && t.length >= 3 && !INTENT_STOPWORDS.has(t)),
  );
}

function intentJaccard(textA, textB) {
  const a = intentTokenSet(textA);
  const b = intentTokenSet(textB);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function isLikelySelfDirectedWhStatement(text) {
  const s = normalizeWhitespace(text);
  if (!s || s.includes("?")) return false;
  return /^(?:what|how|why|when|where|which)\s+(?:i(?:'m| am|'ll| will|'d| would)?|we(?:'re| are|'ll| will|'d| would)?)\b/i.test(
    s,
  );
}

function looksLikeQuestionTurn(text) {
  const s = normalizeWhitespace(text);
  if (!s) return false;
  if (isLikelySelfDirectedWhStatement(s)) return false;
  if (s.includes("?")) return true;
  return /^(?:and\s+)?(?:tell me|describe|explain|walk me through|give an example|what|why|how|who|which|when|where|implement|write|design|debug|build|create|compare)\b/i.test(
    s,
  );
}

function isLikelyFollowupTurn(text) {
  const s = normalizeWhitespace(text);
  if (!s) return false;
  const wc = s.split(" ").filter(Boolean).length;
  if (wc > 14) return false;
  if (!/^(?:and\s+)?(?:what|when|where|which|who|how|why)\b/i.test(s)) return false;
  if (/^and\b/i.test(s)) return true;
  return /\b(?:it|its|that|those|these|them|there|this|they|their|same|again|already|still|so far)\b/i.test(
    s,
  );
}

function countNovelIntentTokens(candidateText, currentQuestionText) {
  const candidateTokens = intentTokenSet(candidateText);
  const currentTokens = intentTokenSet(currentQuestionText);
  if (!candidateTokens.size) return 0;
  let novel = 0;
  for (const token of candidateTokens) {
    if (!currentTokens.has(token)) novel += 1;
  }
  return novel;
}

function shouldForceStartNewIntentBoundary({
  candidateText,
  currentQuestionText,
  canonicalQuestion,
  confidence,
}) {
  const turn = normalizeWhitespace(candidateText);
  const current = normalizeWhitespace(currentQuestionText);
  const canonical = normalizeWhitespace(canonicalQuestion);
  if (!turn || !current) return false;
  if (!looksLikeQuestionTurn(turn)) return false;
  if (isLikelyFollowupTurn(turn)) return false;

  const turnOverlap = intentJaccard(current, turn);
  const canonicalOverlap = canonical ? intentJaccard(current, canonical) : 0;
  const novelTokenCount = countNovelIntentTokens(turn, current);
  if (novelTokenCount < 2) return false;

  if ((confidence == null || confidence <= 0.75) && turnOverlap <= 0.15) {
    return true;
  }
  return turnOverlap <= 0.08 && canonicalOverlap <= 0.18;
}

function inferIntentAction({
  candidateSpeaker,
  candidateText,
  currentQuestionText,
  canonicalQuestion,
  forceDecision = false,
}) {
  const speaker =
    typeof candidateSpeaker === "string" ? candidateSpeaker.trim() : "";
  const turn = normalizeWhitespace(candidateText);
  const current = normalizeWhitespace(currentQuestionText);
  const canonical = normalizeWhitespace(canonicalQuestion);

  if (forceDecision) {
    if (!current) return "start_new_question";
    if (!turn) return "refine_current";
  }

  if (speaker !== "Interviewer") {
    if (forceDecision) return current ? "refine_current" : "start_new_question";
    return "ignore";
  }

  if (!turn) return forceDecision ? (current ? "refine_current" : "start_new_question") : "ignore";
  if (!looksLikeQuestionTurn(turn) && !canonical) {
    return forceDecision ? (current ? "refine_current" : "start_new_question") : "ignore";
  }
  if (!current) return "start_new_question";
  if (isLikelyFollowupTurn(turn)) return "refine_current";

  const overlap = canonical ? intentJaccard(current, canonical) : intentJaccard(current, turn);
  if (overlap >= 0.25) return "refine_current";
  return "start_new_question";
}

function decodeJwtPayload(token) {
  const raw = typeof token === "string" ? token.trim() : "";
  if (!raw || raw.split(".").length < 2) return null;
  const payload = raw.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function isAuthTokenUsable(token, { nowMs = Date.now(), skewSeconds = 30 } = {}) {
  const raw = typeof token === "string" ? token.trim() : "";
  if (!raw) {
    return { ok: false, reason: "missing" };
  }
  const payload = decodeJwtPayload(raw);
  if (!payload) {
    return { ok: true, reason: "opaque" };
  }
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: true, reason: "no_exp" };
  }
  const expiresAtMs = exp * 1000;
  if (expiresAtMs <= nowMs + Math.max(0, skewSeconds) * 1000) {
    return { ok: false, reason: "expired", expiresAtMs };
  }
  return { ok: true, reason: "valid", expiresAtMs };
}

function resolveAuthToken(getAuthToken) {
  if (typeof getAuthToken === "function") return Promise.resolve(getAuthToken());
  if (typeof getAuthToken === "string") return Promise.resolve(getAuthToken);
  return Promise.resolve("");
}

function normalizeWorkerUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function shouldPreferNodeFetchForWorkerUrl(workerUrl) {
  const normalized = normalizeWorkerUrl(workerUrl);
  if (!normalized) return false;
  return /^http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(normalized);
}

function createNodeFetchFallback() {
  return function fetchFallback(resource, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = resource instanceof URL ? resource : new URL(String(resource || ""));
      const lib = urlObj.protocol === "http:" ? http : https;
      const headers =
        options.headers && typeof options.headers === "object" ? { ...options.headers } : {};
      let body = options.body;
      if (body && typeof body !== "string" && !Buffer.isBuffer(body)) {
        body = String(body);
      }
      if (body && !headers["Content-Length"] && !headers["content-length"]) {
        headers["Content-Length"] = Buffer.byteLength(body);
      }
      const req = lib.request(
        {
          protocol: urlObj.protocol,
          hostname: urlObj.hostname,
          port: urlObj.port || undefined,
          path: `${urlObj.pathname}${urlObj.search || ""}`,
          method: options.method || "GET",
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const headerStore = new Map();
            for (const [key, value] of Object.entries(res.headers || {})) {
              headerStore.set(
                String(key).toLowerCase(),
                Array.isArray(value) ? value.join(", ") : String(value || ""),
              );
            }
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: Number(res.statusCode || 0),
              headers: {
                get(name) {
                  return headerStore.get(String(name || "").toLowerCase()) || null;
                },
              },
              async text() {
                return raw;
              },
              async json() {
                return JSON.parse(raw || "{}");
              },
            });
          });
        },
      );
      req.on("error", reject);
      if (options.signal && typeof options.signal === "object") {
        const onAbort = () => {
          try {
            req.destroy(new Error("The operation was aborted"));
          } catch (_) { }
        };
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      if (body) req.write(body);
      req.end();
    });
  };
}

function createLiveCoachRuntime(options = {}) {
  const staticWorkerUrl = normalizeWorkerUrl(options.workerUrl);
  const getWorkerUrl =
    typeof options.getWorkerUrl === "function" ? options.getWorkerUrl : null;
  const customFetchImpl =
    typeof options.fetchImpl === "function" ? options.fetchImpl : null;
  const nodeFetchFallback = createNodeFetchFallback();
  const globalFetchImpl =
    typeof global.fetch === "function" ? global.fetch.bind(global) : null;
  const defaultFetchImpl =
    customFetchImpl ||
    (options.preferNodeFetch === true ||
      shouldPreferNodeFetchForWorkerUrl(staticWorkerUrl)
      ? nodeFetchFallback
      : globalFetchImpl || nodeFetchFallback);
  if (typeof defaultFetchImpl !== "function") {
    throw new Error("createLiveCoachRuntime requires a fetch implementation");
  }
  const getAuthToken = options.getAuthToken;
  const appVersion =
    typeof options.appVersion === "string" && options.appVersion.trim()
      ? options.appVersion.trim()
      : "2.0.0";
  const platform =
    typeof options.platform === "string" && options.platform.trim()
      ? options.platform.trim()
      : process.platform;
  const clientType =
    typeof options.clientType === "string" && options.clientType.trim()
      ? options.clientType.trim()
      : "unknown";
  const clientVersion =
    typeof options.clientVersion === "string" && options.clientVersion.trim()
      ? options.clientVersion.trim()
      : appVersion;
  const logger =
    options.logger && typeof options.logger === "object" ? options.logger : console;
  const safeTrimFn = typeof options.safeTrim === "function" ? options.safeTrim : safeTrimLocal;

  const generateLiveCoachCardsOverride =
    typeof options.generateLiveCoachCards === "function" ? options.generateLiveCoachCards : null;
  const generateLiveCoachIntentOverride =
    typeof options.generateLiveCoachIntent === "function" ? options.generateLiveCoachIntent : null;

  const isUnsupportedLanguageError = (errOrMessage) => {
    const message =
      typeof errOrMessage === "string"
        ? errOrMessage
        : errOrMessage?.message || String(errOrMessage || "");
    return /live_coach_language_unsupported|language_unsupported|available\s+in\s+english\s+only/i.test(
      message,
    );
  };

  const resolveWorkerUrl = () => {
    if (!getWorkerUrl) return staticWorkerUrl;
    try {
      return normalizeWorkerUrl(getWorkerUrl());
    } catch (_) {
      return staticWorkerUrl;
    }
  };

  const resolveFetchImpl = (resolvedWorkerUrl) => {
    if (customFetchImpl) return customFetchImpl;
    const preferNodeFetch =
      options.preferNodeFetch === true ||
      shouldPreferNodeFetchForWorkerUrl(resolvedWorkerUrl || staticWorkerUrl);
    return preferNodeFetch ? nodeFetchFallback : globalFetchImpl || nodeFetchFallback;
  };

  async function requestLiveCoach({
    mode,
    systemPrompt,
    userPrompt,
    maxTokens,
    timeoutMs,
    answerLanguage,
    temperature,
    signal,
  }) {
    const workerUrl = resolveWorkerUrl();
    if (!workerUrl) throw new Error("Missing worker URL for Live Coach runtime");
    const fetchImpl = resolveFetchImpl(workerUrl);
    const token = await resolveAuthToken(getAuthToken);
    const tokenCheck = isAuthTokenUsable(token);
    if (!tokenCheck.ok) {
      throw new Error(`Auth token unusable (${tokenCheck.reason})`);
    }

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Math.floor(Number(timeoutMs))
        : 0;
    const timer =
      controller && timeout > 0
        ? setTimeout(() => {
          try {
            controller.abort();
          } catch (_) { }
        }, timeout)
        : null;
    const detachExternalAbort =
      controller && signal && typeof signal === "object"
        ? (() => {
          const onAbort = () => {
            try {
              controller.abort();
            } catch (_) { }
          };
          if (signal.aborted) {
            onAbort();
            return null;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          return () => {
            try {
              signal.removeEventListener("abort", onAbort);
            } catch (_) { }
          };
        })()
        : null;
    let response = null;
    try {
      response = await fetchImpl(`${workerUrl}/live-coach`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": `CTRLpotato/${appVersion} (${platform})`,
          "X-Client-Type": clientType,
          "X-Client-Version": clientVersion,
          "X-Answer-Language": answerLanguage || "English",
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          liveCoachMode: mode,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature:
            Number.isFinite(Number(temperature)) && Number(temperature) >= 0
              ? Number(temperature)
              : 0,
        }),
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (typeof detachExternalAbort === "function") detachExternalAbort();
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Live Coach ${mode} upstream error ${response.status}: ${safeTrimFn(normalizeWhitespace(text), 280, "end") || "unknown"
        }`,
      );
    }

    const json = await response.json();
    const extracted = extractChatCompletionTextPayload(json);
    return {
      ...extracted,
      provider: response.headers.get("x-live-coach-provider") || "",
      salvaged: response.headers.get("x-live-coach-salvaged") || "",
      fallbackReason: response.headers.get("x-live-coach-fallback-reason") || "",
      winner: response.headers.get("x-live-coach-winner") || "",
      modeHeader: response.headers.get("x-live-coach-mode") || "",
      latencyMs: response.headers.get("x-live-coach-latency-ms") || "",
      totalLatencyMs: response.headers.get("x-live-coach-total-latency-ms") || "",
    };
  }

  async function generateLiveCoachIntent(input = {}) {
    if (generateLiveCoachIntentOverride) return generateLiveCoachIntentOverride(input);

    const answerLanguage =
      typeof input.answerLanguage === "string" && input.answerLanguage.trim()
        ? input.answerLanguage.trim()
        : "English";
    const forceDecision = input.forceDecision === true;
    const systemPrompt = buildLiveCoachIntentSystemPrompt(answerLanguage, { forceDecision });
    const userPrompt = buildLiveCoachIntentUserPrompt({
      currentQuestionText: input.currentQuestionText,
      currentQuestionType: input.currentQuestionType,
      candidateText: input.candidateText,
      candidateSpeaker: input.candidateSpeaker,
      recentTurns: input.recentTurns,
    });

    const callOnce = async (maxTokens, attempt) => {
      try {
        const extracted = await requestLiveCoach({
          mode: "intent",
          systemPrompt,
          userPrompt,
          maxTokens,
          timeoutMs: LIVE_COACH_INTENT_REQUEST_TIMEOUT_MS,
          answerLanguage,
        });
        const parsed = extractFirstJsonObject(extracted.text || "");
        if (parsed) return parsed;
        logger.debug?.(
          `[LiveCoachRuntime] Invalid intent JSON (attempt=${attempt}) source=${extracted.source} finish=${extracted.finishReason || "?"
          } provider=${extracted.provider || "?"} salvaged=${extracted.salvaged || "-"} fallback=${extracted.fallbackReason || "-"
          } winner=${extracted.winner || "-"}`,
        );
      } catch (err) {
        const message = err?.message || String(err);
        if (isUnsupportedLanguageError(message)) throw err;
        if (/aborted|aborterror/i.test(message)) {
          logger.debug?.(
            `[LiveCoachRuntime] Intent request aborted (attempt=${attempt})`,
          );
        } else {
          logger.warn?.(
            `[LiveCoachRuntime] Intent request failed (attempt=${attempt}): ${message}`,
          );
        }
      }
      return null;
    };

    const parsed = await callOnce(320, 1);
    if (!parsed) {
      const fallbackSpeaker =
        typeof input.candidateSpeaker === "string" ? input.candidateSpeaker : "";
      const fallbackText = normalizeWhitespace(input.candidateText);
      const forceDecisionOnFallback =
        forceDecision ||
        (fallbackSpeaker === "Interviewer" && !isLikelyInterviewerBackchannel(fallbackText));
      const fallbackAction = inferIntentAction({
        candidateSpeaker: input.candidateSpeaker,
        candidateText: input.candidateText,
        currentQuestionText: input.currentQuestionText,
        canonicalQuestion: "",
        forceDecision: forceDecisionOnFallback,
      });
      const fallbackCanonical =
        fallbackAction === "ignore"
          ? ""
          : summarizeQuestionTurnWithRecentContext({
            candidateText:
              normalizeWhitespace(input.candidateText) ||
              normalizeWhitespace(input.currentQuestionText),
            candidateSpeaker: input.candidateSpeaker,
            recentTurns: input.recentTurns,
            maxWords: DEFAULT_QUESTION_MAX_WORDS,
          });
      const fallbackType =
        fallbackAction === "refine_current"
          ? normalizeQuestionType(input.currentQuestionType)
          : resolveQuestionTypeFromAsk({
            parsedQuestionType: "",
            askText: fallbackCanonical || input.candidateText || "",
            fallbackQuestionType: input.currentQuestionType || "",
          });
      const fallbackConfidence = forceDecision
        ? 0.35
        : fallbackAction === "ignore"
          ? 0.2
          : 0.35;
      logger.debug?.(
        `[LiveCoachRuntime] Intent fallback used action=${fallbackAction} type=${fallbackType}`,
      );
      return {
        action: fallbackAction,
        questionType: fallbackType,
        canonicalQuestion: fallbackCanonical,
        confidence: fallbackConfidence,
      };
    }

    const canonicalQuestion = sanitizeQuestionLine(
      typeof parsed.canonicalQuestion === "string"
        ? parsed.canonicalQuestion
        : typeof parsed.question === "string"
          ? parsed.question
          : typeof parsed.whatTheyreAsking === "string"
            ? parsed.whatTheyreAsking
            : typeof parsed.what_theyre_asking === "string"
              ? parsed.what_theyre_asking
              : "",
      DEFAULT_QUESTION_MAX_WORDS,
    );

    const actionRaw = normalizeWhitespace(parsed.action);
    let action =
      actionRaw === "start_new_question" ||
        actionRaw === "refine_current" ||
        actionRaw === "ignore"
        ? actionRaw
        : inferIntentAction({
          candidateSpeaker: input.candidateSpeaker,
          candidateText: input.candidateText,
          currentQuestionText: input.currentQuestionText,
          canonicalQuestion,
          forceDecision,
        });
    if (forceDecision && action === "ignore") {
      action = normalizeWhitespace(input.currentQuestionText)
        ? "refine_current"
        : "start_new_question";
    }
    const parsedQuestionTypeRaw =
      typeof parsed.questionType === "string" ? parsed.questionType : "";
    let confidence = clamp01(parsed.confidence);
    if (
      actionRaw !== "start_new_question" &&
      actionRaw !== "refine_current" &&
      actionRaw !== "ignore" &&
      confidence === null
    ) {
      confidence = action === "ignore" ? 0.2 : 0.55;
    }
    if (forceDecision && (confidence === null || confidence < 0.35)) {
      confidence = 0.35;
    }
    const candidateQuestion = summarizeQuestionTurnWithRecentContext({
      candidateText: normalizeWhitespace(input.candidateText),
      candidateSpeaker: input.candidateSpeaker,
      recentTurns: input.recentTurns,
      maxWords: DEFAULT_QUESTION_MAX_WORDS,
    });
    const shouldPromoteCandidateQuestion =
      action === "start_new_question" &&
      shouldPromoteCandidateQuestionSummary({
        canonicalQuestion,
        candidateQuestion,
        confidence,
      });
    const effectiveCanonicalQuestion = shouldPromoteCandidateQuestion
      ? candidateQuestion || canonicalQuestion
      : canonicalQuestion;
    const questionType = resolveQuestionTypeFromAsk({
      parsedQuestionType: shouldPromoteCandidateQuestion ? "" : parsedQuestionTypeRaw,
      askText: effectiveCanonicalQuestion || input.candidateText || "",
      fallbackQuestionType:
        shouldPromoteCandidateQuestion && action === "start_new_question"
          ? ""
          : input.currentQuestionType || "",
    });
    if (shouldPromoteCandidateQuestion) {
      logger.debug?.(
        `[LiveCoachRuntime] Promoted candidate turn over underspecified canonical summary canonical="${canonicalQuestion}" candidate="${candidateQuestion}" conf=${confidence == null ? "null" : confidence.toFixed(2)
        }`,
      );
    }
    if (
      normalizeWhitespace(input.candidateSpeaker) === "Interviewer" &&
      !normalizeWhitespace(input.currentQuestionText) &&
      action !== "ignore" &&
      looksLikeQuestionTurn(input.candidateText)
    ) {
      return {
        action: "start_new_question",
        questionType: resolveQuestionTypeFromAsk({
          parsedQuestionType: questionType,
          askText: candidateQuestion || input.candidateText || "",
          fallbackQuestionType: input.currentQuestionType || "",
        }),
        canonicalQuestion: candidateQuestion || effectiveCanonicalQuestion,
        confidence: confidence === null ? 0.55 : Math.max(confidence, 0.55),
      };
    }
    const boundarySuggestedAction = inferIntentAction({
      candidateSpeaker: input.candidateSpeaker,
      candidateText: input.candidateText,
      currentQuestionText: input.currentQuestionText,
      canonicalQuestion: "",
      forceDecision,
    });
    if (
      boundarySuggestedAction === "start_new_question" &&
      action !== "start_new_question" &&
      shouldForceStartNewIntentBoundary({
        candidateText: input.candidateText,
        currentQuestionText: input.currentQuestionText,
        canonicalQuestion,
        confidence,
      })
    ) {
      return {
        action: "start_new_question",
        questionType: resolveQuestionTypeFromAsk({
          parsedQuestionType: questionType,
          askText: candidateQuestion || input.candidateText || "",
          fallbackQuestionType: input.currentQuestionType || "",
        }),
        canonicalQuestion: candidateQuestion || effectiveCanonicalQuestion,
        confidence: confidence === null ? 0.55 : Math.max(confidence, 0.55),
      };
    }
    return {
      action,
      questionType,
      canonicalQuestion: effectiveCanonicalQuestion,
      confidence,
    };
  }

  async function generateLiveCoachCards(input = {}) {
    if (generateLiveCoachCardsOverride) return generateLiveCoachCardsOverride(input);

    const answerLanguage =
      typeof input.answerLanguage === "string" && input.answerLanguage.trim()
        ? input.answerLanguage.trim()
        : "English";
    const questionText = normalizeWhitespace(input.questionText);
    const canonicalQuestion = normalizeWhitespace(input.canonicalQuestion);
    const expectedQuestionType = normalizeQuestionType(
      typeof input.questionType === "string" ? input.questionType : "",
    );
    const askText = canonicalQuestion || questionText;
    const inferredQuestionType = inferQuestionTypeFromAskText(askText);
    const effectiveExpectedQuestionType = resolveQuestionTypeFromAsk({
      parsedQuestionType: expectedQuestionType,
      askText,
      fallbackQuestionType: inferredQuestionType,
    });
    const allowCandidateQuestionLines = isCandidateQuestionsPrompt(askText);
    const allowSelfSpecificClaims = isTechnicalFamiliarityAsk(askText);
    const isCodingCards =
      effectiveExpectedQuestionType === "coding" || inferredQuestionType === "coding";
    const useCompactTechnicalPrompt = isCompactTechnicalCardsQuestion(
      questionText,
      canonicalQuestion,
    );
    const baseSystemPrompt = useCompactTechnicalPrompt
      ? buildLiveCoachTechnicalCardsSystemPrompt(answerLanguage)
      : buildLiveCoachSystemPrompt(answerLanguage);
    const baseUserPrompt = useCompactTechnicalPrompt
      ? buildLiveCoachTechnicalCardsUserPrompt({
        questionText,
        canonicalQuestion,
      })
      : buildLiveCoachUserPrompt({
        brief: input.brief,
        recentTurns: input.recentTurns,
        questionText,
        canonicalQuestion,
      });

    const failedOutputs = [];
    const callOnce = async (maxTokens, attempt, { systemPrompt, userPrompt, temperature = 0 }) => {
      try {
        const extracted = await requestLiveCoach({
          mode: "cards",
          systemPrompt,
          userPrompt,
          maxTokens,
          timeoutMs: isCodingCards
            ? LIVE_COACH_CODING_CARDS_REQUEST_TIMEOUT_MS
            : LIVE_COACH_CARDS_REQUEST_TIMEOUT_MS,
          answerLanguage,
          temperature,
          signal: input.signal,
        });
        if (typeof extracted?.text === "string" && extracted.text.trim()) {
          failedOutputs.push(extracted.text);
        }
        const parsed = extractFirstJsonObject(extracted.text || "");
        if (parsed) return { parsed, extracted };
        logger.debug?.(
          `[LiveCoachRuntime] Invalid cards JSON (attempt=${attempt}) source=${extracted.source} finish=${extracted.finishReason || "?"
          } provider=${extracted.provider || "?"} salvaged=${extracted.salvaged || "-"} fallback=${extracted.fallbackReason || "-"
          } winner=${extracted.winner || "-"}`,
        );
      } catch (err) {
        const message = err?.message || String(err);
        if (isUnsupportedLanguageError(message)) throw err;
        if (/aborted|aborterror/i.test(message)) {
          logger.debug?.(
            `[LiveCoachRuntime] Cards request aborted (attempt=${attempt})`,
          );
        } else {
          logger.warn?.(
            `[LiveCoachRuntime] Cards request failed (attempt=${attempt}): ${message}`,
          );
        }
      }
      return null;
    };

    let attemptNo = 0;
    const callCards = (maxTokens, prompts) => callOnce(maxTokens, ++attemptNo, prompts);

    const isTechnicalCards =
      effectiveExpectedQuestionType === "coding" ||
      effectiveExpectedQuestionType === "system_design" ||
      inferredQuestionType === "coding" ||
      inferredQuestionType === "system_design";
    const isSystemDesignCards =
      isTechnicalCards && !isCodingCards;
    const primaryMaxTokens = isCodingCards
      ? 620
      : isSystemDesignCards
        ? useCompactTechnicalPrompt
          ? 420
          : 500
        : 420;
    const outlineRepairMaxTokens = isCodingCards ? 680 : isTechnicalCards ? 520 : 460;
    const applyFallbackConstraintCleanup = (cards) =>
      applyHardConstraintHintsToCards(cards, {
        sourceAsk: canonicalQuestion || questionText,
        questionType:
          cards?.questionType || effectiveExpectedQuestionType || inferredQuestionType,
      });

    let packed = await callCards(primaryMaxTokens, {
      systemPrompt: baseSystemPrompt,
      userPrompt: baseUserPrompt,
    });
    if (!packed) {
      const repairPacked = await callCards(primaryMaxTokens, {
        systemPrompt: buildLiveCoachCardsRepairSystemPrompt(answerLanguage),
        userPrompt: buildLiveCoachCardsRepairUserPrompt({
          brief: input.brief,
          recentTurns: input.recentTurns,
          questionText,
          canonicalQuestion,
          expectedQuestionType: effectiveExpectedQuestionType || inferredQuestionType,
          failedResponseText: failedOutputs[failedOutputs.length - 1] || "",
        }),
      });
      if (repairPacked) packed = repairPacked;
    }
    if (!packed) {
      const recoveredOnly = buildGuaranteedCardsFallback({
        questionText,
        canonicalQuestion,
        questionType: effectiveExpectedQuestionType || inferredQuestionType,
        brief: input.brief,
        recentTurns: input.recentTurns,
        failedOutputs,
      });
      if (recoveredOnly.outline.length >= MIN_TALKING_POINTS) {
        return applyFallbackConstraintCleanup(recoveredOnly);
      }
      throw new Error("Live Coach cards unavailable");
    }

    const keepGroundedLines = (lines) => lines;
    const technicalContextTokens = buildTechnicalContextTokenSet({
      questionText,
      canonicalQuestion,
      recentTurns: input.recentTurns,
    });
    const groundingTokens = buildGroundingTokenSet({
      brief: input.brief,
      recentTurns: input.recentTurns,
      questionText,
      canonicalQuestion,
    });
    const currentAskTokens = buildCurrentAskTokenSet(questionText, canonicalQuestion);
    const priorTurnTokens = buildPriorTurnTokenSet(
      input.recentTurns,
      canonicalQuestion || questionText,
    );
    const briefTokenSet = buildBriefTokenSet(input.brief);

    const normalizeCardsFromParsed = (parsed, extracted) => {
      const modelQuestionRaw =
        typeof parsed.question === "string"
          ? parsed.question
          : typeof parsed.whatTheyreAsking === "string"
            ? parsed.whatTheyreAsking
            : typeof parsed.what_theyre_asking === "string"
              ? parsed.what_theyre_asking
              : "";

      const questionCandidates = [
        sanitizeQuestionLine(modelQuestionRaw, DEFAULT_QUESTION_MAX_WORDS),
        sanitizeQuestionLine(canonicalQuestion, DEFAULT_QUESTION_MAX_WORDS),
        sanitizeQuestionLine(questionText, DEFAULT_QUESTION_MAX_WORDS + 8),
      ].filter(Boolean);
      const question =
        questionCandidates.find((line) => looksLikeQuestionSummaryLine(line)) ||
        questionCandidates[0] ||
        "";

      const modelFirstSentenceRaw =
        typeof parsed.firstSentence === "string"
          ? parsed.firstSentence
          : typeof parsed.first_sentence === "string"
            ? parsed.first_sentence
            : typeof parsed.opener === "string"
              ? parsed.opener
              : "";
      const firstSentenceCandidate = sanitizeFirstSentence(
        modelFirstSentenceRaw,
        DEFAULT_FIRST_SENTENCE_MAX_WORDS,
      );

      const parsedOutline = coerceBulletList(
        parsed.outline ?? parsed.plan ?? parsed.steps ?? parsed.skeleton,
      );
      const outlineRaw =
        parsedOutline.length > 0 ? parsedOutline : [];
      const dontMissRaw = coerceBulletList(parsed.dontMiss);
      const parsedQuestionType = normalizeQuestionType(
        typeof parsed.questionType === "string"
          ? parsed.questionType
          : typeof parsed.question_type === "string"
            ? parsed.question_type
            : typeof parsed.type === "string"
              ? parsed.type
              : "",
      );
      const questionType = resolveQuestionTypeFromAsk({
        parsedQuestionType:
          parsedQuestionType !== "other"
            ? parsedQuestionType
            : effectiveExpectedQuestionType,
        askText: question || canonicalQuestion || questionText,
        fallbackQuestionType: inferredQuestionType,
      });
      const confidence = clamp01(parsed.confidence);

      const firstSentence0 =
        questionType === "coding" || questionType === "system_design"
          ? !isTemplateLikeLine(coerceTechnicalFirstSentence(firstSentenceCandidate))
            ? coerceTechnicalFirstSentence(firstSentenceCandidate)
            : ""
          : !isTemplateLikeLine(firstSentenceCandidate)
            ? firstSentenceCandidate
            : "";
      const firstSentence =
        questionType === "coding" || questionType === "system_design"
          ? isTechnicalLineRelevant(firstSentence0, technicalContextTokens)
            ? firstSentence0
            : ""
          : questionType === "behavioral" &&
            isLikelyUngroundedBehavioralLine(firstSentence0, {
              groundingTokens,
              briefTokens: briefTokenSet,
            })
            ? ""
            : firstSentence0;
      const finalFirstSentence =
        firstSentence &&
          normalizeWhitespace(firstSentence).replace(/[.!?]+$/g, "").toLowerCase() ===
          normalizeWhitespace(question).replace(/[.!?]+$/g, "").toLowerCase()
          ? ""
          : firstSentence;

      const buildOutline = (rawBullets, effectiveType) => {
        const talkingPointMaxWords =
          effectiveType === "coding" || effectiveType === "system_design"
            ? DEFAULT_OUTLINE_MAX_WORDS + 6
            : effectiveType === "other"
              ? DEFAULT_OUTLINE_MAX_WORDS
              : Math.max(16, DEFAULT_OUTLINE_MAX_WORDS - 1);
        const normalizedCandidates = rawBullets
          .map((x) =>
            sanitizeTalkingPointBullet(String(x ?? ""), { maxWords: talkingPointMaxWords }),
          )
          .map((line) =>
            effectiveType === "behavioral"
              ? coerceBehavioralTalkingPoint(line)
              : effectiveType === "other" && allowSelfSpecificClaims
                ? coerceTechnicalFamiliarityTalkingPoint(line)
                : line,
          )
          .filter(Boolean);
        const outlineCandidates = normalizeStringList(normalizedCandidates, {
          maxItems: 8,
          maxChars: 240,
        }).filter(
          (line) =>
            !isTemplateLikeLine(line) &&
            !isBrokenSchemaLikeLine(line) &&
            !isLikelyClippedResponseLine(line),
        );
        const strictByType = outlineCandidates.filter((line) =>
          isValidTalkingPointByType(line, effectiveType, {
            technicalContextTokens,
            currentAskTokens,
            priorTurnTokens,
            askText: canonicalQuestion || questionText,
            briefTokens: briefTokenSet,
            groundingTokens,
            allowCandidateQuestionLines,
            allowSelfSpecificClaims,
            allowPriorOverlap: allowSelfSpecificClaims,
          }),
        );
        let byType = strictByType;
        const isTechnicalType =
          effectiveType === "coding" || effectiveType === "system_design";
        if (isTechnicalType && byType.length < MIN_TALKING_POINTS) {
          // Relax to preserve output reliability, but keep anti-resume-bleed guardrails.
          const relaxedTechnical = outlineCandidates.filter((line) => {
            if (!isTechnicalSpeakableLine(line)) return false;
            return !isLikelyResumeBleedTechnicalLine(line, {
              contextTokens: technicalContextTokens,
              briefTokens: briefTokenSet,
            });
          });
          byType = normalizeStringList([...strictByType, ...relaxedTechnical], {
            maxItems: 8,
            maxChars: 240,
          });
        }
        return dedupeNearDuplicateOutlineLines(keepGroundedLines(byType)).slice(
          0,
          MAX_TALKING_POINTS,
        );
      };
      const buildDontMiss = (rawBullets) =>
        normalizeDontMissBullets(
          rawBullets
            .map((x) =>
              sanitizeDontMissBullet(String(x ?? ""), {
                maxWords:
                  questionType === "coding" || questionType === "system_design"
                    ? DEFAULT_DONT_MISS_MAX_WORDS + 1
                    : DEFAULT_DONT_MISS_MAX_WORDS,
              }),
            )
            .filter(Boolean),
        ).filter(
          (line) =>
            !isBrokenSchemaLikeLine(line, { allowDontMissPrefix: true }) &&
            !isLikelyUnsafeDontMissLine(line) &&
            !isLikelyClippedResponseLine(line) &&
            !isLikelyLengthTruncatedResponseLine(line),
        );

      let outline = buildOutline(outlineRaw, questionType);
      const outlineSeed =
        questionType === "behavioral"
          ? coerceBehavioralTalkingPoint(finalFirstSentence)
          : questionType === "other" && allowSelfSpecificClaims
            ? coerceTechnicalFamiliarityTalkingPoint(finalFirstSentence)
            : finalFirstSentence;
      if (
        outlineSeed &&
        isValidTalkingPointByType(outlineSeed, questionType, {
          technicalContextTokens,
          currentAskTokens,
          priorTurnTokens,
          askText: canonicalQuestion || questionText,
          briefTokens: briefTokenSet,
          groundingTokens,
          allowCandidateQuestionLines,
          allowSelfSpecificClaims,
          allowPriorOverlap: allowSelfSpecificClaims,
        })
      ) {
        outline = dedupeNearDuplicateOutlineLines(
          normalizeStringList([outlineSeed, ...outline], {
            maxItems: MAX_TALKING_POINTS,
            maxChars: 240,
          }),
        );
      }
      let dontMiss = buildDontMiss(dontMissRaw);
      outline = outline.slice(0, MAX_TALKING_POINTS);

      return {
        question,
        firstSentence: finalFirstSentence,
        firstSentenceIsFallback: false,
        outline,
        dontMiss,
        questionType,
        confidence: confidence === null ? 0 : confidence,
        cardsAreFallback: false,
        cardsFallbackReason: "",
        debug: {
          source: extracted?.source || "",
          finishReason: extracted?.finishReason || "",
          provider: extracted?.provider || "",
          salvaged: extracted?.salvaged || "",
          fallbackReason: extracted?.fallbackReason || "",
          winner: extracted?.winner || "",
          latencyMs: extracted?.latencyMs || "",
          totalLatencyMs: extracted?.totalLatencyMs || "",
        },
      };
    };
    const needsCardsRepair = (cards) => {
      const effectiveType = normalizeQuestionType(
        cards?.questionType || effectiveExpectedQuestionType || inferredQuestionType,
      );
      const sourceAsk = canonicalQuestion || questionText;
      const outline = Array.isArray(cards?.outline)
        ? cards.outline.filter(Boolean)
        : [];
      const dontMiss = Array.isArray(cards?.dontMiss)
        ? cards.dontMiss.filter(Boolean)
        : [];
      const finishReason = normalizeWhitespace(cards?.debug?.finishReason).toLowerCase();
      const finishReasonHasLength = hasLengthFinishReason(finishReason);
      if (!cards?.question || !looksLikeQuestionSummaryLine(cards.question)) return true;
      if (cards.firstSentence && isTemplateLikeLine(cards.firstSentence)) return true;
      if (outline.length < MIN_TALKING_POINTS) return true;
      if (dontMiss.length < 1) return true;
      if (hasClippedCardsContent(cards)) return true;
      if (
        finishReasonHasLength &&
        hasLengthTruncatedCardsContent(cards, { sourceAsk })
      ) {
        return true;
      }
      if (
        finishReasonHasLength &&
        (dontMiss.length < 2 ||
          !cards.firstSentence ||
          ((effectiveType === "coding" || effectiveType === "system_design") &&
            outline.length < MAX_TALKING_POINTS))
      ) {
        return true;
      }
      if (outline.some((line) => isTemplateLikeLine(line))) return true;
      if (
        dontMiss.some(
          (line) =>
            isTemplateLikeLine(line) ||
            isBrokenSchemaLikeLine(line, { allowDontMissPrefix: true }) ||
            isLikelyUnsafeDontMissLine(line),
        )
      ) {
        return true;
      }
      if (
        outline.some((line) =>
          /^(?:behavioral|system_design|coding|other|question|firstsentence|outline|dontmiss|confidence)$/i.test(
            normalizeWhitespace(line),
          ),
        )
      ) {
        return true;
      }
      if (
        outline.some((line) =>
          !isValidTalkingPointByType(line, effectiveType, {
            technicalContextTokens,
            currentAskTokens,
            priorTurnTokens,
            askText: canonicalQuestion || questionText,
            briefTokens: briefTokenSet,
            groundingTokens,
            allowCandidateQuestionLines,
            allowSelfSpecificClaims,
            allowPriorOverlap: allowSelfSpecificClaims,
          }),
        )
      ) {
        return true;
      }
      if (
        (effectiveType === "coding" || effectiveType === "system_design") &&
        outline.some((line) =>
          isLikelyResumeBleedTechnicalLine(line, {
            contextTokens: technicalContextTokens,
            briefTokens: briefTokenSet,
          }),
        )
      ) {
        return true;
      }
      return false;
    };
    const mergeCardsCandidates = (base, extra) => {
      if (!extra || typeof extra !== "object") return base;
      if (!base || typeof base !== "object") return extra;
      const effectiveType = normalizeQuestionType(
        base.questionType || extra.questionType || effectiveExpectedQuestionType || inferredQuestionType,
      );
      const mergedOutline = dedupeNearDuplicateOutlineLines(
        normalizeStringList(
          [
            ...(Array.isArray(base.outline) ? base.outline : []),
            ...(Array.isArray(extra.outline) ? extra.outline : []),
          ].filter((line) =>
            isValidTalkingPointByType(line, effectiveType, {
              technicalContextTokens,
              currentAskTokens,
              priorTurnTokens,
              askText: canonicalQuestion || questionText,
              briefTokens: briefTokenSet,
              groundingTokens,
              allowCandidateQuestionLines,
              allowSelfSpecificClaims,
            }),
          ),
          { maxItems: MAX_TALKING_POINTS, maxChars: 240 },
        ).filter((line) => {
          if (
            isTemplateLikeLine(line) ||
            isBrokenSchemaLikeLine(line) ||
            isLikelyClippedResponseLine(line)
          ) {
            return false;
          }
          if (effectiveType === "coding" || effectiveType === "system_design") {
            return !isLikelyResumeBleedTechnicalLine(line, {
              contextTokens: technicalContextTokens,
              briefTokens: briefTokenSet,
            });
          }
          return true;
        }),
      );
      const mergedDontMiss = normalizeDontMissBullets([
        ...(Array.isArray(base.dontMiss) ? base.dontMiss : []),
        ...(Array.isArray(extra.dontMiss) ? extra.dontMiss : []),
      ]).filter(
        (line) =>
          !isLikelyUnsafeDontMissLine(line) &&
          !isLikelyClippedResponseLine(line) &&
          !isLikelyLengthTruncatedResponseLine(line),
      );
      return {
        question:
          (looksLikeQuestionSummaryLine(base.question) && base.question) ||
          (looksLikeQuestionSummaryLine(extra.question) && extra.question) ||
          base.question ||
          extra.question ||
          "",
        firstSentence:
          base.firstSentence ||
          extra.firstSentence ||
          "",
        firstSentenceIsFallback:
          base.firstSentenceIsFallback === true && !base.firstSentence
            ? Boolean(extra.firstSentenceIsFallback)
            : Boolean(base.firstSentenceIsFallback),
        outline: mergedOutline,
        dontMiss: mergedDontMiss,
        questionType: effectiveType,
        confidence: Math.max(
          clamp01(base.confidence) ?? 0,
          clamp01(extra.confidence) ?? 0,
        ),
        cardsAreFallback: Boolean(base.cardsAreFallback || extra.cardsAreFallback),
        cardsFallbackReason: base.cardsFallbackReason || extra.cardsFallbackReason || "",
        debug: {
          source: [base.debug?.source, extra.debug?.source].filter(Boolean).join("+"),
          finishReason: [base.debug?.finishReason, extra.debug?.finishReason]
            .filter(Boolean)
            .join("+"),
          provider: [base.debug?.provider, extra.debug?.provider].filter(Boolean).join("+"),
          salvaged: [base.debug?.salvaged, extra.debug?.salvaged]
            .filter(Boolean)
            .join("+"),
          fallbackReason: [base.debug?.fallbackReason, extra.debug?.fallbackReason]
            .filter(Boolean)
            .join("+"),
          winner: [base.debug?.winner, extra.debug?.winner].filter(Boolean).join("+"),
          latencyMs: extra.debug?.latencyMs || base.debug?.latencyMs || "",
          totalLatencyMs:
            extra.debug?.totalLatencyMs || base.debug?.totalLatencyMs || "",
        },
      };
    };
    const applyFinalCardsCleanup = (cards) =>
      cards && typeof cards === "object"
        ? (() => {
          const firstSentence = cleanReturnedFirstSentence(
            cards.firstSentence,
            cards.question,
          );
          const outline = dedupeOutlineAgainstFirstSentence(
            Array.isArray(cards.outline) ? cards.outline : [],
            firstSentence,
          );
          const dedupedOutline = dedupeNearDuplicateOutlineLines(outline);
          return applyHardConstraintHintsToCards({
            ...cards,
            firstSentence,
            outline: dedupedOutline,
          }, {
            sourceAsk: canonicalQuestion || questionText,
            questionType:
              cards.questionType || effectiveExpectedQuestionType || inferredQuestionType,
          });
        })()
        : cards;

    let normalized = applyFinalCardsCleanup(
      normalizeCardsFromParsed(packed.parsed, packed.extracted),
    );
    const primaryRecoveredOnly = buildGuaranteedCardsFallback({
      questionText,
      canonicalQuestion,
      questionType: effectiveExpectedQuestionType || inferredQuestionType,
      brief: input.brief,
      recentTurns: input.recentTurns,
      failedOutputs,
    });
    const recoveredOutlineMin = minRecoveredFallbackOutlineCount(
      effectiveExpectedQuestionType || inferredQuestionType,
    );
    if (
      packed?.extracted &&
      hasLengthFinishReason(packed.extracted.finishReason) &&
      (
        hasClippedCardsContent(normalized) ||
        hasLengthTruncatedCardsContent(normalized, {
          sourceAsk: canonicalQuestion || questionText,
        })
      ) &&
      primaryRecoveredOnly.outline.length >= recoveredOutlineMin &&
      primaryRecoveredOnly.dontMiss.length >= 1 &&
      !hasClippedCardsContent(primaryRecoveredOnly) &&
      !hasLengthTruncatedCardsContent(primaryRecoveredOnly, {
        sourceAsk: canonicalQuestion || questionText,
      })
    ) {
      return applyFallbackConstraintCleanup(primaryRecoveredOnly);
    }
    if (needsCardsRepair(normalized)) {
      const repairPrompt = buildLiveCoachCardsOutlineRepairUserPrompt({
        questionText,
        canonicalQuestion,
        questionType: effectiveExpectedQuestionType || inferredQuestionType,
        parsedCardsJson: packed.parsed,
      });
      const outlineRepairPacked = await callCards(outlineRepairMaxTokens, {
        systemPrompt: buildLiveCoachCardsRepairSystemPrompt(answerLanguage),
        userPrompt: repairPrompt,
      });
      if (outlineRepairPacked) {
        const repairedOutline = normalizeCardsFromParsed(
          outlineRepairPacked.parsed,
          outlineRepairPacked.extracted,
        );
        normalized = applyFinalCardsCleanup(
          mergeCardsCandidates(normalized, repairedOutline),
        );
        if (
          !needsCardsRepair(repairedOutline) ||
          repairedOutline.outline.length > normalized.outline.length ||
          repairedOutline.dontMiss.length > normalized.dontMiss.length
        ) {
          normalized = applyFinalCardsCleanup(repairedOutline);
        }
      }
    }
    if (needsCardsRepair(normalized)) {
      const rescuePacked = await callCards(primaryMaxTokens, {
        systemPrompt: buildLiveCoachCardsRepairSystemPrompt(answerLanguage),
        userPrompt: buildLiveCoachCardsRepairUserPrompt({
          brief: input.brief,
          recentTurns: input.recentTurns,
          questionText,
          canonicalQuestion,
          expectedQuestionType: effectiveExpectedQuestionType || inferredQuestionType,
          failedResponseText:
            failedOutputs[failedOutputs.length - 1] ||
            safeTrimLocal(JSON.stringify(packed.parsed || {}), 1800, "end"),
        }),
      });
      if (rescuePacked) {
        const rescued = normalizeCardsFromParsed(
          rescuePacked.parsed,
          rescuePacked.extracted,
        );
        normalized = applyFinalCardsCleanup(mergeCardsCandidates(normalized, rescued));
        if (
          !needsCardsRepair(rescued) ||
          rescued.outline.length > normalized.outline.length ||
          rescued.dontMiss.length > normalized.dontMiss.length
        ) {
          normalized = applyFinalCardsCleanup(rescued);
        }
      }
    }
    if (needsCardsRepair(normalized)) {
      const recoveredOnly = buildGuaranteedCardsFallback({
        questionText,
        canonicalQuestion,
        questionType: effectiveExpectedQuestionType || inferredQuestionType,
        brief: input.brief,
        recentTurns: input.recentTurns,
        failedOutputs,
      });
      if (
        recoveredOnly.outline.length >= recoveredOutlineMin &&
        !hasClippedCardsContent(recoveredOnly) &&
        !hasLengthTruncatedCardsContent(recoveredOnly, {
          sourceAsk: canonicalQuestion || questionText,
        })
      ) {
        return applyFallbackConstraintCleanup(recoveredOnly);
      }
      throw new Error("Live Coach cards missing valid talking points");
    }
    if (normalized.outline.length < MIN_TALKING_POINTS) {
      throw new Error("Live Coach cards missing valid talking points");
    }

    return applyFinalCardsCleanup(normalized);
  }

  return {
    generateLiveCoachCards,
    generateLiveCoachIntent,
    extractFirstJsonObject,
    extractChatCompletionTextPayload,
    isAuthTokenUsable,
  };
}

module.exports = {
  createLiveCoachRuntime,
  extractFirstJsonObject,
  extractChatCompletionTextPayload,
  isAuthTokenUsable,
  inferQuestionTypeFromAskText,
  resolveQuestionTypeFromAsk,
  buildGenericFallbackOutline,
  buildGenericFallbackDontMiss,
  // Sanitization functions used by aiService for card parsing
  sanitizeFirstSentence,
  sanitizeTalkingPointBullet,
  sanitizeDontMissBullet,
  sanitizeQuestionLine,
  normalizeQuestionType,
  normalizeDontMissBullets,
  coerceBulletList,
  normalizeWhitespace,
};
