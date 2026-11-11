const crypto = require("crypto");
const {
  inferQuestionTypeFromAskText,
  resolveQuestionTypeFromAsk,
  buildGenericFallbackOutline,
  buildGenericFallbackDontMiss,
} = require("./liveCoachRuntime");

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripQuestionNoisePrefix(text) {
  return normalizeOneLine(text).replace(/^[\s,.;:!?()[\]{}"'`-]+/g, "").trim();
}

function countWords(text) {
  const t = normalizeText(text);
  if (!t) return 0;
  return t.split(" ").filter(Boolean).length;
}

function sleep(ms) {
  const waitMs = Number.isFinite(Number(ms)) ? Math.max(0, Math.floor(Number(ms))) : 0;
  if (waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function shouldHoldInterviewerTurnForRecovery(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return false;
  const wc = countWords(s);
  if (wc >= 7) return true;
  if (wc >= 4 && /\?\s*$/.test(s)) return true;
  const qMarks = (s.match(/\?/g) || []).length;
  if (qMarks >= 2 && wc >= 6) return true;
  return false;
}

function isImplicitCareerChangeHypotheticalAsk(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return false;
  const s = normalizeOneLine(stripInterviewerLeadIn(raw) || raw);
  if (!s) return false;
  if (!/^if\b/i.test(s)) return false;
  const wc = countWords(s);
  if (wc < 6 || wc > 32) return false;
  const availabilityScenario =
    /\b(?:position|job|role)\s+becomes?\s+available\b/i.test(s) ||
    /\bcurrent field\b/i.test(s);
  const retentionContext =
    /\b(?:career change|master(?:'s|s)\s+degree|now and in the future|in the future)\b/i.test(s) ||
    /\b(?:stay|leave|take it|go back|return)\b/i.test(s) ||
    /\b(?:would you|will you|do you)\b/i.test(s);
  return availabilityScenario && retentionContext;
}

function shouldHoldInterviewerContextPreambleForRecovery(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return false;
  const s = normalizeOneLine(stripInterviewerLeadIn(raw) || raw);
  if (!s || s.includes("?")) return false;
  const wc = countWords(s);
  if (wc < 8 || wc > 32) return false;
  if (!/^(?:i\s+(?:have|do\s+have|need)\s+to\s+ask)\b/i.test(s)) return false;
  return /\b(?:given that|career change|master(?:'s|s)\s+degree|current field|education)\b/i.test(
    s,
  );
}

function normalizeTranscriptedImperativeAskCue(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return "";
  const s = normalizeOneLine(raw);
  if (!s || s.includes("?")) return s;
  if (!/\b(?:you|your)\b/i.test(s)) return s;
  if (countWords(s) < 5) return s;

  const replacements = [
    [/^(and\s+)?described\b/i, "$1Describe"],
    [/^(and\s+)?explained\b/i, "$1Explain"],
    [/^(and\s+)?shared\b/i, "$1Share"],
    [/^(and\s+)?walked\s+me\s+through\b/i, "$1Walk me through"],
    [/^(and\s+)?walked\s+through\b/i, "$1Walk me through"],
    [/^(and\s+)?told\s+me\s+about\b/i, "$1Tell me about"],
    [/^(and\s+)?gave(?:\s+me)?\s+(?:an?\s+)?example(?:\s+of)?\b/i, "$1Give an example of"],
  ];
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(s)) continue;
    return normalizeOneLine(s.replace(pattern, replacement));
  }
  return s;
}

function shouldConsiderInterviewerFragmentForIntent(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return false;
  const s = normalizeTranscriptedImperativeAskCue(
    normalizeOneLine(stripInterviewerLeadIn(raw) || raw),
  );
  if (!s) return false;
  if (isLikelySelfDirectedWhStatement(s)) return false;
  if (isBackchannelLike(normalizeText(s))) return false;
  if (isConversationManagementTurn(s)) return false;
  if (isLikelyInterviewerPreamble(s)) return false;
  if (isImplicitCareerChangeHypotheticalAsk(s)) return true;
  const wc = countWords(s);
  if (wc < 2 || wc > 12) return false;
  if (hasEmbeddedAskDirective(s)) return true;
  if (/^(?:and|or|but)\b/i.test(s)) return true;
  if (/^(?:difference|different|between|compare|comparison|versus|vs)\b/i.test(s)) return true;
  if (/[.?!:]$/.test(raw) && wc <= 8) return true;
  return false;
}

function isStandaloneQuestionForRecovery(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return false;
  const wc = countWords(s);
  const qMarks = (s.match(/\?/g) || []).length;
  if (wc >= 8 && qMarks >= 1) return true;
  if (wc < 8) return false;
  const normalized = normalizeText(normalizeTranscriptedImperativeAskCue(s));
  return /\b(?:tell me|describe|explain|share|walk me through|give an example|give a situation|what|why|how|who|which|when|where)\b/i.test(
    normalized,
  );
}

function isLikelyInterviewerPreamble(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return false;
  if (s.includes("?")) return false;
  const normalized = normalizeText(normalizeTranscriptedImperativeAskCue(s));
  if (!normalized) return false;
  const hasAskCue =
    /\b(?:tell me|describe|explain|walk me through|give an example|share|please share|could you|can you|would you|what|why|how|who|which|when|where)\b/i.test(
      normalized,
    );
  if (hasAskCue) return false;
  const hasSetupCue =
    /\b(?:thank you for|i would like to|i d like to|i am going to|i m going to|let me|before we start|we will|we re going to|i also|hope that|welcome)\b/i.test(
      normalized,
    );
  return hasSetupCue && countWords(normalized) >= 8;
}

function isLikelyShortFollowupSubquestion(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  const wc = countWords(s);
  if (wc > 12) return false;
  if (!/^(?:and\s+)?(?:when|what|which|how|where|who|why)\b/i.test(s)) return false;
  if (/^what\s+is\s+it\s+about\b/i.test(s)) return false;
  if (/^and\b/i.test(s)) return true;
  // Treat clearly referential short turns as follow-ups, but do not block standalone asks
  // that merely contain words like "that" in content ("that major", "that school").
  if (
    /\b(?:it|these|them|there|so far|again|already|the same|back again|comes? back|same (?:behavior|behaviors|issue|issues|problem|problems)|at that point|that point|that stage|that scenario|now that)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/\bthis\b/i.test(s) && !/\bthis\s+(?:role|job|company|position|team|opportunity)\b/i.test(s)) {
    return true;
  }
  return false;
}

function isLikelyAttachedFollowupSubquestion(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  const wc = countWords(s);
  if (wc > 14) return false;
  if (!/^(?:and\s+)?(?:when|what|which|how|where|who|why)\b/i.test(s)) return false;
  if (/^what\s+is\s+it\s+about\b/i.test(s)) return false;
  if (/^and\b/i.test(s)) return true;
  if (
    /\b(?:it|those|these|them|there|so far|then|the same|back again|comes? back|same (?:behavior|behaviors|issue|issues|problem|problems)|at that point|that point|that stage|that scenario|now that)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/\bthis\b/i.test(s) && !/\bthis\s+(?:role|job|company|position|team|opportunity)\b/i.test(s)) {
    return true;
  }
  if (
    /\bthat\s+(?:was|is|did|does|do|went|goes|looked|look|happened|resolved|mean|work(?:ed)?|help(?:ed)?|impact(?:ed)?|result(?:ed)?|consist(?:ed)?)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/^(?:what|when|how)\s+did\b/i.test(s)) return true;
  return false;
}

function isLikelyVagueHandleFollowup(text) {
  const s = normalizeOneLine(text).replace(/[?!.]+$/g, "").trim();
  if (!s) return false;
  return /^how\s+(?:(?:do|would|should)\s+(?:we|you)\s+|to\s+)?handle\s+(?:it|them|this|that|those|these|men)$/i.test(
    s,
  );
}

function isUsefulCanonicalizedVagueHandleFollowup({ currentQuestion, canonicalQuestion }) {
  const current = normalizeOneLine(currentQuestion);
  const next = normalizeOneLine(canonicalQuestion);
  if (!current || !next) return false;
  if (isLikelyVagueHandleFollowup(next)) return false;
  if (!isAskLikeSummaryText(next) || countWords(next) < 5) return false;
  const overlap = questionSemanticOverlap(current, next);
  const jaccard = tokenSetJaccard(current, next);
  const nextOnCurrent = questionCoverageScore(next, current);
  return overlap >= 0.2 || jaccard >= 0.18 || nextOnCurrent >= 0.22;
}

function isLikelyCoordinatedQuestionTail(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  if (!/^and\b/i.test(s)) return false;
  const tail = s
    .replace(/^and\b[\s,.:;!?-]*/i, "")
    .replace(/[?!.]+$/g, "")
    .trim();
  if (!tail) return false;
  const wc = countWords(tail);
  if (wc < 1 || wc > 4) return false;
  if (isBackchannelLike(normalizeText(tail))) return false;
  return /^(?:weakness(?:es)?|strengths?|development(?:\s+areas?)?|improvement(?:\s+areas?)?|limitations?|challenge(?:s)?|gaps?)\b/i.test(
    tail,
  );
}

function hasFollowupReferencePronoun(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  if (/^what\s+is\s+it\s+about\b/i.test(s)) return false;
  if (
    /\b(?:it|those|these|them|there|again|already|still|so far|the same|back again|comes? back|same (?:behavior|behaviors|issue|issues|problem|problems)|at that point|that point|that stage|that scenario|now that)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/\bthis\b/i.test(s) && !/\bthis\s+(?:role|job|company|position|team|opportunity)\b/i.test(s)) {
    return true;
  }
  return false;
}

function isReferentialFollowupAsk(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  if (
    !/^(?:and\s+)?(?:tell me|what|why|how|who|which|when|where|can you|could you|would you|do you|have you)\b/i.test(
      s,
    )
  ) {
    return false;
  }
  if (!hasFollowupReferencePronoun(s)) return false;
  if (!s.includes("?") && !hasEmbeddedAskDirective(s)) return false;
  return true;
}

function recoverQuotedUserReferentialQuestion(text) {
  const raw = stripQuestionNoisePrefix(text);
  if (!raw) return "";
  const stripped = normalizeOneLine(stripInterviewerLeadIn(raw) || raw);
  if (!stripped) return "";
  const sentenceParts = stripped
    .split(/(?<=[?!.])\s+/g)
    .map((part) => normalizeOneLine(part))
    .filter(Boolean);
  if (sentenceParts.length < 2) return "";
  const tail = stripQuestionNoisePrefix(sentenceParts[sentenceParts.length - 1]);
  if (!tail || !isReferentialFollowupAsk(tail)) return "";

  let context = "";
  for (let i = sentenceParts.length - 2; i >= 0; i -= 1) {
    const candidate = stripQuestionNoisePrefix(
      stripInterviewerLeadIn(sentenceParts[i]) || sentenceParts[i],
    );
    if (!candidate) continue;
    const normalized = normalizeText(candidate);
    if (!normalized || isBackchannelLike(normalized)) continue;
    if (isConversationManagementTurn(candidate)) continue;
    if (countWords(candidate) < 4) continue;
    if (candidate.includes("?")) continue;
    context = candidate.replace(/[.!?]+$/g, "").trim();
    break;
  }
  if (!context) return "";
  return `${context}. ${tail}`;
}

function isSelfIntroductionExpansion(currentQuestion, rawQuestion) {
  const current = normalizeOneLine(currentQuestion);
  const raw = normalizeOneLine(rawQuestion);
  if (!current || !raw) return false;

  const currentLooksIntro =
    /\b(?:tell me about yourself|about yourself|introduce yourself|introduction|your background)\b/i.test(
      current,
    ) || /\b(?:who are you|what have you studied|your studies|your experience)\b/i.test(current);
  if (!currentLooksIntro) return false;

  const rawLooksIntroFacet =
    /\b(?:who are you|what have you studied|study|studied|education|experience|background|major|school)\b/i.test(
      raw,
    );
  if (!rawLooksIntroFacet) return false;

  // "Why did you choose X" is usually a separate interview ask, not a pure intro facet.
  if (/^why\b/i.test(raw) && /\b(?:choose|chose|selected|pick(?:ed)?)\b/i.test(raw)) {
    return false;
  }
  return true;
}

function stripInterviewerLeadIn(text) {
  let s = stripQuestionNoisePrefix(text);
  if (!s) return "";
  // Remove stacked discourse lead-ins from ASR so question cue matching can focus on the ask.
  for (let i = 0; i < 3; i += 1) {
    const next = s
      .replace(
        /^(?:okay|ok|alright|all right|right|so|now|well|yes|yeah|yep|all right then|alright then)\b[\s,.:;!\-]*/i,
        "",
      )
      .trim();
    if (!next || next === s) break;
    s = next;
  }
  return stripQuestionNoisePrefix(s);
}

function isLikelySelfDirectedWhStatement(text) {
  const s = normalizeOneLine(stripInterviewerLeadIn(text) || text);
  if (!s || s.includes("?")) return false;
  return /^(?:what|how|why|when|where|which)\s+(?:i(?:'m| am|'ll| will|'d| would)?|we(?:'re| are|'ll| will|'d| would)?)\b/i.test(
    s,
  );
}

function hasEmbeddedAskDirective(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  return /\b(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what do you|why do you|how do you|what are your|why are you|how would you|do you|can you|could you|would you|have you)\b/i.test(
    s,
  );
}

function hasSubstantiveCandidateAskDirective(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  return /\b(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what are your|why are you|why do you|why would you|why did you|how do you|how did you|how have you|how would you|what would you|what can you|what do you know|what interests you|what excites you|do you have any questions|what questions do you have|implement|design|build|create|debug|write (?:a|an|the)?\s*(?:function|algorithm|class|api|query|program|solution))\b/i.test(
    s,
  );
}

function hasDirectCandidateAskDirective(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  return (
    /\b(?:what are your|why are you|why do you|why would you|how would you|what would you|what can you|what do you know|what interests you|do you have any questions|what questions do you have)\b/i.test(
      s,
    ) ||
    /\b(?:what excites you|what interests you|why this role|why this company|why our company|why do you want (?:this|the) (?:job|role|position)|why do you want to work (?:here|with us|at our company)|how do you incorporate feedback)\b/i.test(
      s,
    ) ||
    /\b(?:tell me about|walk me through|describe|give me|share)\s+(?:you|your|a time|an example|some of|the roles|the projects|the products|your experience|your background)\b/i.test(
      s,
    ) ||
    /\b(?:can you|could you|would you|do you|have you)\s+(?:tell|describe|explain|walk|share|give|implement|design|build|create|debug|write)\b/i.test(
      s,
    )
  );
}

function isLikelySocialTurn(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  if (countWords(s) > 16) return false;
  return /\b(?:how are you|how are things|how's it going|how is it going|good to meet you|nice to meet you|great to meet you|pleasure to meet you|thanks for joining|thank you for joining|welcome)\b/i.test(
    s,
  );
}

function isLikelyProcessOrWrapUpTurn(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  if (countWords(s) > 30) return false;
  if (hasSubstantiveCandidateAskDirective(s)) return false;
  return /\b(?:next steps?|hr|human resources|recruiter|recruiting|debrief|write[- ]?up|scorecard|we(?:'ll| will) reach out|will reach out|reach out to you|be in touch|follow up with you|circle back|let you know|get back to you)\b/i.test(
    s,
  );
}

function isLikelyRecruiterOrCompanyNarration(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  if (countWords(s) < 12) return false;
  if (/\b(?:i don't know how|hard (?:role )?to explain|how to (?:kind of )?explain|share (?:you )?(?:all )?the job descriptions?)\b/i.test(s)) {
    return true;
  }
  if (hasDirectCandidateAskDirective(s)) return false;
  const hasNarrationSignal =
    /\b(?:company|startup|scale[- ]?up|team|founder|hq|headquarters|based in|raised|funding|seed round|series [abc]|countries|role|position|department|recruiter|hiring manager|interview process|next steps|hr|human resources|report|feedback|reach out|be in touch|follow up|job descriptions?|hands[- ]?on|strategic|managerial|calling it|they(?:'ve| have) got|there (?:is|are))\b/i.test(
      s,
    );
  if (!hasNarrationSignal) return false;
  const hasTechnicalAssignmentSignal =
    /\b(?:implement|design|debug|build|write)\b[\s\S]{0,180}\b(?:function|algorithm|class|api|service|system|container|database|query)\b/i.test(
      s,
    );
  return !hasTechnicalAssignmentSignal;
}

function recoverReferentialQuestionWithContext(text) {
  const source = normalizeOneLine(stripInterviewerLeadIn(text) || text);
  if (!source) return "";
  if (isConversationManagementTurn(source)) return "";

  const cueRe =
    /\b(?:what|why|how|when|where|which|who|can you|could you|would you|do you|have you|tell me|describe|explain|walk me through)\b/gi;
  const matches = [];
  let current = null;
  while ((current = cueRe.exec(source))) {
    matches.push(current.index);
  }
  for (const index of matches) {
    if (index <= 0) continue;
    const context = stripQuestionNoisePrefix(
      source.slice(0, index).replace(/[,;:\s-]+$/g, "").trim(),
    );
    const tail = stripQuestionNoisePrefix(source.slice(index).trim());
    if (!context || !tail) continue;
    if (countWords(context) < 4 || countWords(tail) < 4) continue;
    if (!isReferentialFollowupAsk(tail)) continue;
    if (isConversationManagementTurn(context) || isLikelyRecruiterOrCompanyNarration(context)) {
      continue;
    }

    const normalizedContext = context.replace(/[?!.]+$/g, "").trim();
    const normalizedTail = tail.replace(/[.]+$/g, "").trim();
    if (!normalizedContext || !normalizedTail) continue;
    return `${normalizedContext}. ${normalizedTail}`;
  }
  return "";
}

function splitReferentialQuestionContext(text) {
  const s = normalizeOneLine(text);
  if (!s) return null;
  const parts = s
    .split(/\.\s+/g)
    .map((part) => normalizeOneLine(part))
    .filter(Boolean);
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1];
  const context = parts.slice(0, -1).join(". ");
  if (!context || !tail) return null;
  if (countWords(context) < 4 || !isReferentialFollowupAsk(tail)) return null;
  return { context, tail };
}

function sliceAskClauseFromText(text) {
  const s = normalizeOneLine(text);
  if (!s) return "";
  const startsAskCue =
    /^(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where|can you|could you|would you|do you|have you|implement|design|build|create|debug|write|given|problem|task)\b/i.test(
      s,
    );
  if (startsAskCue) return s;

  const cueRe =
    /(?:^|[.!?]\s+|,\s+|:\s+|;\s+)(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where|can you|could you|would you|do you|have you|implement|design|build|create|debug|write|given|problem|task)\b/i;
  const m = cueRe.exec(s);
  if (m && Number.isFinite(m.index)) {
    const matchText = m[0] || "";
    const cueIndexInMatch = matchText.search(
      /(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where|can you|could you|would you|do you|have you|implement|design|build|create|debug|write|given|problem|task)\b/i,
    );
    const normalizedCueIndex = cueIndexInMatch >= 0 ? cueIndexInMatch : 0;
    const start = Math.max(0, m.index + normalizedCueIndex);
    return s.slice(start).trim();
  }

  // Fallback: if cue appears mid-sentence without punctuation, still trim leading preamble.
  const looseCue = s.search(
    /\b(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where|can you|could you|would you|do you|have you|implement|design|build|create|debug|write|given|problem|task)\b/i,
  );
  if (looseCue >= 0) {
    const recoveredReferentialQuestion = recoverReferentialQuestionWithContext(s);
    if (recoveredReferentialQuestion) return recoveredReferentialQuestion;
    return s.slice(looseCue).trim();
  }
  return s;
}

function isConversationManagementTurn(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  const wc = countWords(s);
  if (wc <= 2 && isBackchannelLike(normalizeText(s))) return true;
  if (isLikelySocialTurn(s)) return true;
  if (isLikelyProcessOrWrapUpTurn(s)) return true;
  if (isLikelyRecruiterOrCompanyNarration(s)) return true;
  if (
    /^(?:can you|could you|would you)\s+(?:repeat|say (?:that|it) again|rephrase|clarify|speak louder|slow down|hear me)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (
    /^(?:sorry|pardon|excuse me)[, ]*(?:can you|could you)?\s*(?:repeat|say (?:that|it) again|clarify)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (
    wc <= 18 &&
    /\b(?:there(?:'s| is)?\s+(?:a\s+)?lag|audio|mic|connection(?: issue| problem)?|internet connection|network(?: issue| problem| lag)?|hear me|hear you|repeat (?:that|it)|say (?:that|it) again)\b/i.test(
      s,
    )
  ) {
    const networkingConceptQuestion =
      /\b(?:difference|different|between|compare|switch|splitter|router|modem|ip address|subnet|vlan|mac address)\b/i.test(
        s,
      );
    if (!networkingConceptQuestion) {
      return true;
    }
  }
  if (
    wc <= 20 &&
    /\b(?:bathroom|restroom|water|coffee|tea|bio break|break)\b/i.test(s)
  ) {
    return true;
  }
  return false;
}

function isLikelyHypotheticalEmbeddedAskNarration(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  if (countWords(s) < 16) return false;
  const hasHypotheticalCue =
    /\b(?:suppose|imagine|for example|as an example|if)\b/i.test(s);
  const hasQuotedAskCue =
    /\b(?:asked|asking|asks|start asking|starts asking|say|says)\b[\s\S]{0,180}\b(?:can you tell me|could you tell me|tell me about|describe|explain|what|why|how)\b/i.test(
      s,
    );
  const hasGuardrailContext =
    /\b(?:agent|llm|model|prompt|guardrail|stay on track|off track|not deviating|supposed to do|control via prompt)\b/i.test(
      s,
    );
  return hasHypotheticalCue && hasQuotedAskCue && hasGuardrailContext;
}

function isLikelyUserClarificationTurn(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  if (hasUserReadAloudPromptCue(s)) return false;
  if (isConversationManagementTurn(s)) return true;
  const stripped = stripQuestionNoisePrefix(stripInterviewerLeadIn(s) || s);
  if (!stripped) return false;
  if (
    /^(?:and\s+)?(?:do|did)\s+you\s+mean\b/i.test(stripped) ||
    /^(?:and\s+)?what\s+do\s+you\s+mean\b/i.test(stripped) ||
    /^(?:and\s+)?(?:can|could|would)\s+you\b/i.test(stripped) ||
    /^(?:and\s+)?(?:can|could|should|would|do|did|will)\s+i\b/i.test(
      stripped,
    ) ||
    /^(?:and\s+)?(?:am|are|is)\s+(?:i|we|this|that|it)\b/i.test(stripped) ||
    /^(?:and\s+)?(?:should|can|could|would|do)\s+we\b/i.test(stripped)
  ) {
    return true;
  }
  if (
    countWords(stripped) <= 14 &&
    /\b(?:do you mean|what do you mean|can i|could i|should i|would you like|do i|am i|is it okay if|should we|can we|could we)\b/i.test(
      stripped,
    )
  ) {
    return true;
  }
  return false;
}

function isLikelyTagQuestionWithoutAsk(text) {
  const s = normalizeOneLine(text);
  if (!s || !s.includes("?")) return false;
  if (!/(?:^|[\s,])(right|okay|ok|correct)\?\s*$/i.test(s)) return false;
  const lead = stripInterviewerLeadIn(s) || s;
  if (hasEmbeddedAskDirective(lead)) return false;
  if (
    /^(?:and\s+)?(?:what|why|how|who|which|when|where|can you|could you|would you|do you|have you|tell me|describe|explain|walk me through|share|give\b)/i.test(
      lead,
    )
  ) {
    return false;
  }
  return true;
}

function isLikelySelfDirectedInterviewerQuestion(text) {
  const s = normalizeOneLine(text);
  if (!s || !s.includes("?")) return false;
  const lead = stripInterviewerLeadIn(s) || s;
  if (
    /^(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what are your|why do you|how do you|how would you|can you|could you|would you|do you|have you)\b/i.test(
      lead,
    )
  ) {
    return false;
  }
  if (/\byou(?:'re| are| have| should| can| would| could)?\b/i.test(lead)) return false;

  const firstPersonCount =
    (lead.match(/\b(?:i|i'm|i’ve|i'd|i'll|my|me|we|we're|we’ve|we'd|we'll|our|us)\b/gi) || [])
      .length;
  if (firstPersonCount < 2) return false;
  const narrativeSignal =
    /\b(?:i(?:'m| am| have| use| used| work| worked)|we(?:'re| are| have| use| used| work| build| support| run| could| can)|our team)\b/i.test(
      lead,
    );
  if (!narrativeSignal) return false;
  const multiQuestionCount = (lead.match(/\?/g) || []).length;
  return multiQuestionCount >= 1;
}

function extractAskLikeSegment(text) {
  const original = normalizeOneLine(text);
  if (!original) return "";
  if (isBackchannelLike(normalizeText(original))) return "";
  if (isConversationManagementTurn(original)) return "";

  const stripped = stripInterviewerLeadIn(original);
  const source = normalizeTranscriptedImperativeAskCue(
    normalizeOneLine(stripped || original),
  );
  if (!source) return "";
  if (isBackchannelLike(normalizeText(source))) return "";
  if (isConversationManagementTurn(source)) return "";

  const recoveredReferentialQuestion = recoverReferentialQuestionWithContext(source);
  if (recoveredReferentialQuestion) return safeTrim(recoveredReferentialQuestion, 900, "end");

  const sentenceParts = source
    .split(/(?<=[?!.])\s+/g)
    .map((part) => normalizeOneLine(part))
    .filter(Boolean);
  const askParts = sentenceParts
    .filter((part) => {
      const candidate = stripQuestionNoisePrefix(part);
      if (!candidate) return false;
      if (isBackchannelLike(normalizeText(candidate))) return false;
      if (isConversationManagementTurn(candidate)) return false;
      if (isLikelyInterviewerPreamble(candidate) && !candidate.includes("?")) return false;
      if (isLikelyIncompleteQuestionFragment(candidate)) return false;
      if (isLikelyTagQuestionWithoutAsk(candidate)) return false;
      return (
        isQuestionLikeBoundaryText(candidate) ||
        hasEmbeddedAskDirective(candidate) ||
        candidate.includes("?")
      );
    })
    .map((part) => {
      const leadStripped = stripQuestionNoisePrefix(stripInterviewerLeadIn(part) || part);
      if (!leadStripped) return "";
      const sliced = sliceAskClauseFromText(leadStripped);
      return stripQuestionNoisePrefix(sliced || leadStripped);
    })
    .filter(Boolean);

  if (askParts.length > 0) {
    return safeTrim(askParts.join(" "), 900, "end");
  }

  const anchorRe =
    /(?:^|[.!?]\s+|,\s*)(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where|can you|could you|would you|do you|have you|implement|design|build|create|debug|write|given|problem|task)\b/i;
  const anchor = source.search(anchorRe);
  if (anchor >= 0) {
    return safeTrim(source.slice(anchor).trim(), 900, "end");
  }
  const startsAsAskCue =
    /^(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where|can you|could you|would you|do you|have you|implement|design|build|create|debug|write|given|problem|task)\b/i.test(
      source,
    );
  if (startsAsAskCue && !isConversationManagementTurn(source)) return source;
  if (hasEmbeddedAskDirective(source)) {
    const sliced = sliceAskClauseFromText(source);
    if (sliced && !isConversationManagementTurn(sliced)) return sliced;
  }
  return "";
}

function normalizeInterviewerQuestionTurn(text) {
  return stripQuestionNoisePrefix(extractAskLikeSegment(text));
}

function normalizeInterviewerPromptTurn(text) {
  const full = normalizeInterviewerQuestionTurn(text);
  if (full) return full;
  const raw = stripQuestionNoisePrefix(text);
  if (!raw) return "";
  const stripped = stripQuestionNoisePrefix(stripInterviewerLeadIn(raw) || raw);
  if (!stripped) return "";
  if (isLikelySelfDirectedWhStatement(stripped)) return "";
  if (isBackchannelLike(normalizeText(stripped))) return "";
  if (isConversationManagementTurn(stripped)) return "";
  if (isLikelyInterviewerPreamble(stripped) && !hasEmbeddedAskDirective(stripped)) return "";
  if (
    shouldConsiderInterviewerFragmentForIntent(stripped) ||
    isLikelyIncompleteQuestionFragment(stripped) ||
    looksMultipartQuestionText(stripped) ||
    hasEmbeddedAskDirective(stripped)
  ) {
    return stripped;
  }
  return "";
}

function normalizeStandaloneInterviewerProbe(text) {
  const raw = stripQuestionNoisePrefix(stripInterviewerLeadIn(text) || text);
  if (!raw) return "";
  if (isLikelySelfDirectedWhStatement(raw)) return "";
  if (isBackchannelLike(normalizeText(raw))) return "";
  if (isConversationManagementTurn(raw)) return "";
  if (isLikelyInterviewerPreamble(raw) && !raw.includes("?") && !hasEmbeddedAskDirective(raw)) {
    return "";
  }
  if (countWords(raw) < 5) return "";
  if (isLikelyIncompleteQuestionFragment(raw)) return "";
  if (
    isQuestionLikeBoundaryText(raw) ||
    hasEmbeddedAskDirective(raw) ||
    looksMultipartQuestionText(raw) ||
    raw.includes("?")
  ) {
    return raw;
  }
  return "";
}

function isStrongAskLikeTurn(text) {
  const s = normalizeInterviewerQuestionTurn(text);
  if (!s) return false;
  if (isBackchannelLike(normalizeText(s))) return false;
  if (isConversationManagementTurn(s)) return false;
  if (isLikelyIncompleteQuestionFragment(s)) return false;
  if (isLikelyInterviewerPreamble(s) && !s.includes("?") && !hasEmbeddedAskDirective(s)) return false;
  return isQuestionLikeBoundaryText(s);
}

function isQuestionLikeBoundaryText(text) {
  const original = normalizeOneLine(text);
  if (!original) return false;
  if (isBackchannelLike(normalizeText(original))) return false;
  const s = stripInterviewerLeadIn(original) || original;
  if (isLikelySelfDirectedWhStatement(s)) return false;
  if (
    !s.includes("?") &&
    /^what\s+you\s+need\s+to\b/i.test(s) &&
    !hasEmbeddedAskDirective(s)
  ) {
    return false;
  }
  const wc = countWords(s);
  if (isBackchannelLike(normalizeText(s))) return false;
  if (isLikelyTagQuestionWithoutAsk(s)) return false;
  if (isLikelyInterviewerPreamble(s) && !s.includes("?")) return false;
  if (isImplicitCareerChangeHypotheticalAsk(s)) return true;
  if (s.includes("?")) return true;
  if (wc < 4) return false;
  if (
    /^(?:and\s+)?(?:(?:let['’]?s\s+start\s+with\s+)?(?:tell me|describe|explain|walk me through|share|give an example|give a situation)|what|why|how|who|which|when|where|can you|could you|would you|do you|have you)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (
    /^(?:question\s+problem|problem|task|given|implement|write|design|build|create|debug)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/\bgiven\b[\s\S]{0,220}\breturn\b/i.test(s)) return true;
  if (
    /\b(?:implement|write|design|create|optimize|debug)\b[\s\S]{0,220}\b(?:function|algorithm|solution|class|api)\b/i.test(
      normalizeText(s),
    )
  ) {
    return true;
  }
  if (wc >= 6 && hasEmbeddedAskDirective(s)) return true;
  return false;
}

function isAskLikeSummaryText(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  const first = normalizeOneLine((s.match(/^[^.!?\n]+[.!?]?/u) || [s])[0] || "");
  const probe = first || s;
  if (!probe) return false;
  if (isLikelyTagQuestionWithoutAsk(probe)) return false;
  if (isQuestionLikeBoundaryText(probe)) return true;
  return /^(?:please\s+)?(?:describe|tell me|explain|walk me through|share|give|summarize|outline|discuss|identify|compare|what|why|how|who|which|when|where)\b/i.test(
    probe,
  );
}

function isLikelyIncompleteQuestionFragment(text) {
  const s = stripQuestionNoisePrefix(stripInterviewerLeadIn(text));
  if (!s) return false;
  if (isLikelySelfDirectedWhStatement(s)) return true;
  const wc = countWords(s);
  const fragments = s
    .split(/\?+/g)
    .map((part) => normalizeOneLine(part))
    .filter(Boolean);
  if (fragments.length >= 2 && fragments.every((part) => countWords(part) <= 2)) {
    return true;
  }
  if (wc <= 1 && (s.includes("?") || /^(?:what|why|how|who|which|when|where|is|are|do|did|does|can|could|would|should|will)\b/i.test(s))) {
    return true;
  }
  if (wc <= 4 && /^(?:is that|do you think about)\b/i.test(s)) return true;
  if (wc <= 6 && /^(?:what|why|how|who|which|when|where)\s+do\s+you\s+think\s+that\b/i.test(s)) {
    return true;
  }
  if (wc > 10) return false;
  if (!s.includes("?")) return false;
  if (
    /(?:can you|could you|would you|do you|have you|tell me|describe|explain|walk me through|share)\s*\??$/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/^(?:for|about|regarding)\b/i.test(s) && wc <= 5) return true;
  return false;
}

function isBackchannelLike(normalized) {
  const t = String(normalized || "").trim();
  if (!t) return false;
  const exact = new Set([
    "ok",
    "okay",
    "alright",
    "right",
    "yeah",
    "yep",
    "sure",
    "cool",
    "great",
    "awesome",
    "got it",
    "sounds good",
    "makes sense",
    "make sense",
  ]);
  if (exact.has(t)) return true;
  if (t === "does that make sense") return true;
  if (t === "is that clear") return true;
  if (t === "are you with me") return true;
  return false;
}

function safeTrim(text, maxChars, mode = "head") {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return "";
  if (s.length <= maxChars) return s;
  if (mode === "tail") return s.slice(-maxChars);
  if (mode === "both") {
    const head = Math.floor(maxChars * 0.6);
    const tail = maxChars - head;
    return `${s.slice(0, head)}\n…\n${s.slice(-tail)}`.trim();
  }
  return s.slice(0, maxChars);
}

function hashSignature(obj) {
  const raw = JSON.stringify(obj || {});
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function normalizeOneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function sanitizeCanonicalQuestion(value) {
  let s = stripQuestionNoisePrefix(value);
  if (!s) return "";
  s = s
    .replace(/\blatest turn\s*\(\s*speaker\s*=\s*[^)]+\)\s*:\s*/gi, "")
    .replace(/\b(?:current canonical draft|canonical question|interviewer question(?: \(raw\))?|raw interviewer question|recent transcript|candidate context)\s*:\s*/gi, "")
    .replace(/\blanguage\s*:\s*[a-z][a-z -]{1,20}\b/gi, "")
    .trim();
  if (!s) return "";
  // Hard cap to avoid transcript blobs.
  if (s.length > 220) return "";
  // "They asked" must not be in first person.
  if (/^(?:i|my|we|our)\b/i.test(s)) return "";
  return s;
}

function normalizeQuotedUserQuestionTurn(text) {
  const raw = stripQuestionNoisePrefix(text);
  if (!raw) return "";
  if (isConversationManagementTurn(raw) || isLikelyUserClarificationTurn(raw)) return "";
  const recoveredReferentialQuestion = recoverQuotedUserReferentialQuestion(raw);
  if (recoveredReferentialQuestion) return recoveredReferentialQuestion;
  const extracted = normalizeInterviewerQuestionTurn(raw);
  if (
    extracted &&
    (isQuestionLikeBoundaryText(extracted) ||
      shouldConsiderInterviewerFragmentForIntent(extracted) ||
      looksMultipartQuestionText(extracted))
  ) {
    return extracted;
  }
  if (
    isQuestionLikeBoundaryText(raw) ||
    shouldConsiderInterviewerFragmentForIntent(raw) ||
    looksMultipartQuestionText(raw)
  ) {
    return stripQuestionNoisePrefix(stripInterviewerLeadIn(raw) || raw);
  }
  return "";
}

function stripUserReadAloudLeadIn(text) {
  let s = normalizeOneLine(text);
  if (!s) return "";
  s = s
    .replace(
      /^(?:(?:the\s+)?question(?:\s+is|\s+problem)?|problem|task|prompt|it says)\s*[:,-]?\s*/i,
      "",
    )
    .replace(
      /^(?:let me|i(?:'m| am| will|'ll))(?:\s+just)?\s+(?:read|say|go through|walk through)\s*(?:it|the question|the prompt)?\s*[:,-]?\s*/i,
      "",
    )
    .trim();
  return s;
}

function normalizeQuotedUserPromptTurn(text) {
  const full = normalizeQuotedUserQuestionTurn(text);
  if (full) return full;
  const raw = stripQuestionNoisePrefix(text);
  if (!raw) return "";
  if (isConversationManagementTurn(raw) || isLikelyUserClarificationTurn(raw)) return "";
  const readAloudPrompt = hasUserReadAloudPromptCue(raw)
    ? stripUserReadAloudLeadIn(raw)
    : "";
  if (
    readAloudPrompt &&
    (isQuestionLikeBoundaryText(readAloudPrompt) ||
      shouldConsiderInterviewerFragmentForIntent(readAloudPrompt) ||
      looksMultipartQuestionText(readAloudPrompt) ||
      hasEmbeddedAskDirective(readAloudPrompt))
  ) {
    return readAloudPrompt;
  }
  const stripped = stripQuestionNoisePrefix(stripInterviewerLeadIn(raw) || raw);
  if (!stripped) return "";
  if (
    shouldConsiderInterviewerFragmentForIntent(stripped) ||
    isLikelyIncompleteQuestionFragment(stripped) ||
    looksMultipartQuestionText(stripped) ||
    hasEmbeddedAskDirective(stripped)
  ) {
    return stripped;
  }
  return "";
}

function hasUserReadAloudPromptCue(text) {
  const raw = normalizeOneLine(text);
  if (!raw) return false;
  if (
    /^(?:question(?:\s+problem)?|problem|task|prompt|given|the question is|it says|suppose|imagine|consider)\b/i.test(
      raw,
    )
  ) {
    return true;
  }
  if (
    /^(?:let me|i(?:'m| am| will|'ll))(?:\s+just)?\s+(?:read|say|go through|walk through)\b/i.test(
      raw,
    )
  ) {
    return true;
  }
  if (/\bgiven\b[\s\S]{0,220}\breturn\b/i.test(raw)) return true;
  if (
    /\b(?:implement|write|design|build|create|debug)\b[\s\S]{0,220}\b(?:function|algorithm|solution|class|api)\b/i.test(
      normalizeText(raw),
    )
  ) {
    return true;
  }
  return false;
}

function isStrongUserReadAloudPromptTurn(text) {
  const raw = normalizeOneLine(text);
  if (!raw) return false;
  if (isBackchannelLike(normalizeText(raw))) return false;
  if (isConversationManagementTurn(raw)) return false;
  if (isLikelyUserClarificationTurn(raw)) return false;
  const normalizedPrompt = normalizeQuotedUserPromptTurn(raw);
  if (!normalizedPrompt) return false;
  const hasReadAloudCue =
    hasUserReadAloudPromptCue(raw) || hasUserReadAloudPromptCue(normalizedPrompt);
  const prompt = normalizeInterviewerPromptTurn(normalizedPrompt) || normalizedPrompt;
  if (!prompt) return false;
  if (
    !hasReadAloudCue &&
    !/^(?:question(?:\s+problem)?|problem|task|given|implement|write|design|build|create|debug)\b/i.test(
      prompt,
    ) &&
    !/\bgiven\b[\s\S]{0,220}\breturn\b/i.test(prompt) &&
    !(
      looksMultipartQuestionText(prompt) &&
      /\b(?:part|first|second|follow-up|follow up)\b/i.test(raw)
    )
  ) {
    return false;
  }
  if (isStrongAskLikeTurn(prompt)) return true;
  if (hasEmbeddedAskDirective(prompt)) return true;
  if (looksMultipartQuestionText(prompt)) return true;
  if (isLikelyIncompleteQuestionFragment(prompt)) return true;
  if (
    /^(?:question\s+problem|problem|task|given|implement|write|design|build|create|debug)\b/i.test(
      prompt,
    )
  ) {
    return true;
  }
  return countWords(prompt) >= 7 && isQuestionLikeBoundaryText(prompt);
}

const KNOWN_LINUX_PROBE_TERMS = new Set([
  "awk",
  "bash",
  "cat",
  "cd",
  "chmod",
  "chown",
  "cron",
  "crontab",
  "curl",
  "df",
  "directory",
  "dnf",
  "docker",
  "du",
  "exec",
  "file",
  "filesystem",
  "find",
  "fork",
  "grep",
  "gzip",
  "head",
  "htop",
  "ifconfig",
  "inode",
  "init",
  "iptables",
  "journalctl",
  "jq",
  "kernel",
  "kubectl",
  "less",
  "linux",
  "lsof",
  "ls",
  "memory",
  "mount",
  "netstat",
  "nftables",
  "nice",
  "nohup",
  "pacman",
  "pipe",
  "process",
  "proc",
  "/proc",
  "ps",
  "pwd",
  "rsync",
  "scp",
  "sed",
  "shell",
  "signal",
  "ss",
  "ssh",
  "sudo",
  "su",
  "swap",
  "systemctl",
  "systemd",
  "tail",
  "tar",
  "tcp",
  "thread",
  "top",
  "udp",
  "umount",
  "wget",
  "xargs",
  "yum",
  "zsh",
]);

function extractSingleLinuxProbeTerm(text) {
  const raw = normalizeOneLine(text);
  if (!raw) return "";
  const normalized = raw
    .replace(/[?!.]+$/g, "")
    .replace(/\blinus\b/gi, "linux")
    .replace(/\s+/g, " ")
    .trim();
  const match =
    /^what\s+(?:is|does)\s+(?:the\s+)?(.+?)\s+(?:do\s+)?in\s+linux$/i.exec(normalized) ||
    /^what\s+(?:is|does)\s+(?:the\s+)?(.+?)\s+(?:do|used\s+for|mean)$/i.exec(normalized);
  if (!match) return "";
  let term = normalizeOneLine(match[1] || "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/\s+command$/i, "")
    .trim();
  if (!term) return "";
  const pieces = term.split(/\s+/g).filter(Boolean);
  if (pieces.length === 2 && pieces[0].toLowerCase() === pieces[1].toLowerCase()) {
    term = pieces[0];
  } else if (pieces.length > 1) {
    return "";
  }
  return term.toLowerCase();
}

function isLikelyNoisyMicLinuxProbe({ entry, rawText, canonicalQuestion }) {
  if (!entry || entry.speaker !== "User") return false;
  if (!/\bmic\b/i.test(entry.source || "")) return false;
  const original = normalizeOneLine(rawText || entry.text || "");
  if (!original || hasUserReadAloudPromptCue(original)) return false;
  if (countWords(original) > 9) return false;
  const term =
    extractSingleLinuxProbeTerm(original) ||
    extractSingleLinuxProbeTerm(canonicalQuestion || "");
  if (!term) return false;
  if (KNOWN_LINUX_PROBE_TERMS.has(term)) return false;
  // Without an explicit "command named X" cue, one-token unknown Linux probes from mic
  // are often ASR corrections in progress ("rock" -> "Brock" -> "/proc").
  return !/\b(?:command|called|named)\b/i.test(original);
}

function getLiveCoachSemanticSpeaker(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (entry.liveCoachSpeaker === "Interviewer" || entry.liveCoachSpeaker === "User") {
    return entry.liveCoachSpeaker;
  }
  return typeof entry.speaker === "string" ? entry.speaker : "";
}

function getLiveCoachSemanticText(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.liveCoachText === "string" && entry.liveCoachText.trim()) {
    return entry.liveCoachText.trim();
  }
  return typeof entry.text === "string" ? entry.text.trim() : "";
}

function shouldPreserveQuotedUserInterviewerPrompt(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.speaker !== "User") return false;
  if (entry.liveCoachSpeaker !== "Interviewer") return false;
  return typeof entry.liveCoachText === "string" && !!entry.liveCoachText.trim();
}

function normalizeInterviewerEntryPrompt(
  entry,
  { allowStandaloneProbe = false, fallbackToOneLine = false } = {},
) {
  if (!entry || typeof entry !== "object") return "";
  if (getLiveCoachSemanticSpeaker(entry) !== "Interviewer") return "";
  const semanticText = getLiveCoachSemanticText(entry);
  const sourceText = semanticText || entry.text || "";
  if (!sourceText) return "";
  if (shouldPreserveQuotedUserInterviewerPrompt(entry)) {
    return normalizeOneLine(sourceText);
  }
  const normalizedPrompt = normalizeInterviewerPromptTurn(sourceText);
  if (normalizedPrompt) return normalizedPrompt;
  if (allowStandaloneProbe) {
    const standaloneProbe = normalizeStandaloneInterviewerProbe(sourceText);
    if (standaloneProbe) return standaloneProbe;
  }
  return fallbackToOneLine ? normalizeOneLine(sourceText) : "";
}

const QUESTION_STOPWORDS = new Set([
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

function tokenSet(text) {
  const normalizeTokenForCoverage = (token) => {
    let t = String(token || "").trim().toLowerCase();
    if (!t) return "";
    if (t.length > 5 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
    if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
    if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
    if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
    if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
    return t;
  };
  return new Set(
    normalizeText(text)
      .split(" ")
      .map((t) => normalizeTokenForCoverage(t))
      .filter((t) => t && t.length >= 3 && !QUESTION_STOPWORDS.has(t)),
  );
}

function questionTokenLossRatio(previousQuestion, nextQuestion, rawQuestion) {
  const prevTokens = tokenSet(previousQuestion);
  const nextTokens = tokenSet(nextQuestion);
  const rawTokens = tokenSet(rawQuestion);
  if (prevTokens.size === 0 || rawTokens.size === 0) return 0;

  const prevInRaw = [];
  for (const t of prevTokens) {
    if (rawTokens.has(t)) prevInRaw.push(t);
  }
  if (prevInRaw.length === 0) return 0;

  let dropped = 0;
  for (const t of prevInRaw) {
    if (!nextTokens.has(t)) dropped += 1;
  }
  return dropped / prevInRaw.length;
}

function questionCoverageScore(question, rawQuestion) {
  const qTokens = tokenSet(question);
  const rawTokens = tokenSet(rawQuestion);
  if (rawTokens.size === 0) return Math.min(1, countWords(question) / 18);
  let overlap = 0;
  for (const t of qTokens) {
    if (rawTokens.has(t)) overlap += 1;
  }
  return overlap / rawTokens.size;
}

function questionSemanticOverlap(questionA, questionB) {
  const a = normalizeOneLine(questionA);
  const b = normalizeOneLine(questionB);
  if (!a || !b) return 0;
  const aOnB = questionCoverageScore(a, b);
  const bOnA = questionCoverageScore(b, a);
  return Math.min(aOnB, bOnA);
}

function tokenSetJaccard(textA, textB) {
  const a = tokenSet(textA);
  const b = tokenSet(textB);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function isLikelyCanonicalExtensionOfCurrentQuestion({
  currentQuestion,
  nextQuestion,
}) {
  const current = normalizeOneLine(currentQuestion);
  const next = normalizeOneLine(nextQuestion);
  if (!current || !next) return false;
  const currentTokens = tokenSet(current);
  const nextTokens = tokenSet(next);
  if (currentTokens.size === 0 || nextTokens.size === 0) return false;
  if (nextTokens.size <= currentTokens.size) return false;

  let shared = 0;
  let novel = 0;
  for (const token of nextTokens) {
    if (currentTokens.has(token)) shared += 1;
    else novel += 1;
  }

  const retainedRatio = shared / currentTokens.size;
  return retainedRatio >= 0.6 && novel >= 1 && novel <= 3;
}

function shouldIgnoreLowConfidenceDuplicateRefine({
  currentQuestion,
  rawQuestion,
  canonicalQuestion,
  confidence,
  readyCount,
}) {
  if (!(typeof confidence === "number" && confidence <= 0.15)) return false;
  if (!Number.isFinite(readyCount) || readyCount <= 0) return false;

  const current = normalizeOneLine(currentQuestion);
  const raw = normalizeOneLine(rawQuestion);
  const next = normalizeOneLine(canonicalQuestion || rawQuestion);
  if (!current || !raw || !next) return false;

  const referentialShortFollowup =
    countWords(raw) <= 10 &&
    (isLikelyAttachedFollowupSubquestion(raw) ||
      isLikelyShortFollowupSubquestion(raw) ||
      hasFollowupReferencePronoun(raw) ||
      /^and\b/i.test(raw));
  if (!referentialShortFollowup) return false;

  const currentTokens = tokenSet(current);
  const nextTokens = tokenSet(next);
  if (currentTokens.size === 0 || nextTokens.size === 0) return false;

  let sharedTokenCount = 0;
  let novelTokenCount = 0;
  for (const token of nextTokens) {
    if (currentTokens.has(token)) sharedTokenCount += 1;
    else novelTokenCount += 1;
  }

  const currentOnRaw = questionCoverageScore(current, raw);
  const overlap = questionSemanticOverlap(current, next);
  const jaccard = tokenSetJaccard(current, next);
  const retainedCurrentRatio = sharedTokenCount / currentTokens.size;
  const clearlyDegenerateCandidate =
    novelTokenCount <= 1 &&
    (retainedCurrentRatio <= 0.45 || overlap >= 0.5 || jaccard >= 0.35);

  return currentOnRaw >= 0.45 && clearlyDegenerateCandidate;
}

function cleanQuestionSurface(value) {
  let s = stripQuestionNoisePrefix(value);
  if (!s) return "";
  for (let i = 0; i < 3; i += 1) {
    const next = s
      .replace(/^(?:okay|ok|alright|all right|so|now|well|and so|and now)\b[\s,.:;!\-]*/i, "")
      .replace(
        /^(?:could|can|would)\s+you\s+(?:please\s+)?(?:just\s+)?(?:remind me(?: again)?|briefly|quickly)\s*[,:\-]*/i,
        "",
      )
      .replace(/^(?:please\s+)?(?:remind me(?: again)?|briefly|quickly)\s*[,:\-]*/i, "")
      .replace(/^(?:to start with|for starters|firstly|first)\s*[,:\-]*/i, "")
      .trim();
    if (!next || next === s) break;
    s = next;
  }
  s = s.replace(/\b(and|or)\s+\1\b/gi, "$1");
  s = s.replace(/\b(?:and\s+){2,}/gi, "and ");
  s = s
    .replace(
      /^(?:what|why|how|who|which|when|where)\s+do\s+you\s+think\s+that\s+(?:might|would|could|should|is|was)\b[\s.?!]*/i,
      "",
    )
    .replace(
      /^(?:what|why|how|who|which|when|where)\s+(?:would|could|should|can|will)\s+you\s+(?:like|want|mean)\b[\s.?!]*/i,
      "",
    );
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
    .replace(/^\s*what(?:'s| is)\s+difference between\b/gi, "what is the difference between")
    .replace(/^\s*what(?:'s| is)\s+different between\b/gi, "what is the difference between")
    .replace(/^\s*difference between\b/gi, "what is the difference between")
    .replace(/^\s*between\s+(.+)\s+and\s+(.+?)\s*$/i, "what is the difference between $1 and $2")
    .replace(/\bwhat a difference between\b/gi, "what is the difference between")
    .replace(/\btell me what a time when\b/i, "tell me about a time when")
    .replace(/\bwhat a time when\b/i, "about a time when")
    .replace(/\bwhich was the\b/gi, "what was the")
    .replace(/\bwhich was\b/gi, "what was")
    .replace(/\bwhat do you have identified as\b/i, "what have you identified as");
  s = s.replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
  if (s.includes("?")) {
    const parts = s
      .split(/\?+/g)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const head = parts[0].replace(/[?!.]+$/g, "").trim();
      const tail = parts
        .slice(1)
        .map((p) => p.replace(/[?!.]+$/g, "").trim())
        .filter(Boolean)
        .join(" and ");
      s = tail ? `${head} and ${tail}` : head;
    } else {
      s = s.replace(/\?/g, "");
    }
    s = s.replace(/\s+/g, " ").trim();
  }

  const lower = s.toLowerCase();
  const andIndex = lower.indexOf(" and ");
  if (andIndex > 0 && andIndex < s.length - 5) {
    const first = s.slice(0, andIndex).trim();
    const second = s.slice(andIndex + 5).trim();
    if (first && second) {
      const a = normalizeText(first).split(" ").filter(Boolean);
      const b = normalizeText(second).split(" ").filter(Boolean);
      let shared = 0;
      while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
        shared += 1;
      }
      if (shared >= 3) {
        const remainder = b.slice(shared).join(" ").trim();
        if (!remainder) {
          s = first;
        } else if (/^including\b/i.test(remainder)) {
          s = `${first}, ${remainder}`;
        } else {
          s = `${first} and ${remainder}`;
        }
      }
    }
  }

  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\b(?:and|or|but)\s*$/i, "").trim();
  const words = s.split(/\s+/g).filter(Boolean);
  if (words.length > 42) {
    const clipped = words.slice(0, 42);
    while (
      clipped.length > 12 &&
      /\b(?:and|or|but|to|for|with|a|an|the|of|in|on|at|by|from|if|what|when|where|which|who|why|how|did|was|were|is|are|do|does|have|has|would|could|should)\b/i.test(
        clipped[clipped.length - 1] || "",
      )
    ) {
      clipped.pop();
    }
    s = clipped.join(" ").trim();
    s = s.replace(/\b(?:and|or|but)\s*$/i, "").trim();
  }
  if (!s) return "";
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`.trim();
}

function shouldDropQuestionRegression({
  previousQuestion,
  previousRawQuestion,
  nextQuestion,
  nextRawQuestion,
}) {
  const prevQ = normalizeOneLine(previousQuestion);
  const nextQ = normalizeOneLine(nextQuestion);
  const prevRaw = normalizeText(previousRawQuestion);
  const nextRaw = normalizeText(nextRawQuestion);
  if (!prevQ || !nextQ) return false;
  const prevWords = countWords(prevQ);
  const nextWords = countWords(nextQ);

  // Same-source rewrite: block narrower replacements.
  if (prevRaw && nextRaw && prevRaw === nextRaw) {
    const prevScore = questionCoverageScore(prevQ, prevRaw);
    const nextScore = questionCoverageScore(nextQ, nextRaw);
    const tokenLoss = questionTokenLossRatio(prevQ, nextQ, nextRaw);
    return (
      nextScore + 0.08 < prevScore ||
      (nextScore <= prevScore && nextWords + 2 < prevWords) ||
      (nextScore <= prevScore + 0.03 && tokenLoss >= 0.25)
    );
  }

  // Multipart refine path: raw text may expand, but "They asked" should not shrink to the last subpart.
  if (nextRaw) {
    const prevScoreOnNextRaw = questionCoverageScore(prevQ, nextRaw);
    const nextScoreOnNextRaw = questionCoverageScore(nextQ, nextRaw);
    const tokenLoss = questionTokenLossRatio(prevQ, nextQ, nextRaw);
    return (
      nextScoreOnNextRaw + 0.08 < prevScoreOnNextRaw ||
      (nextScoreOnNextRaw <= prevScoreOnNextRaw && nextWords + 2 < prevWords) ||
      (nextScoreOnNextRaw <= prevScoreOnNextRaw + 0.03 && tokenLoss >= 0.25)
    );
  }
  return false;
}

function shouldRejectCanonicalRefineRegression({
  currentCanonical,
  nextCanonical,
  rawText,
}) {
  const current = normalizeOneLine(currentCanonical);
  const next = normalizeOneLine(nextCanonical);
  const raw = normalizeOneLine(rawText);
  if (!current || !next || !raw) return false;
  const currentScore = questionCoverageScore(current, raw);
  const nextScore = questionCoverageScore(next, raw);
  const currentWords = countWords(current);
  const nextWords = countWords(next);
  return nextScore + 0.08 < currentScore || (nextScore <= currentScore && nextWords + 2 < currentWords);
}

function flattenMergedQuestionForDisplay(value) {
  const s = normalizeOneLine(value);
  if (!s) return "";
  if (!s.includes(";")) return s;
  const parts = s
    .split(/\s*;\s*/g)
    .map((p) => normalizeOneLine(p))
    .filter(Boolean);
  if (parts.length <= 1) return s.replace(/;/g, " ");
  const head = parts[0].replace(/[?!.]+$/g, "").trim();
  const tailRaw = parts.slice(1).join(" and ").replace(/[?!.]+$/g, "").trim();
  if (!head || !tailRaw) return head || tailRaw || "";
  const tail =
    tailRaw.length >= 2
      ? `${tailRaw.charAt(0).toLowerCase()}${tailRaw.slice(1)}`
      : tailRaw.toLowerCase();
  const joined = `${head} and ${tail}`.replace(/\s+/g, " ").trim();
  if (!joined) return "";
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`.trim();
}

function looksMultipartQuestionText(text) {
  const s = normalizeOneLine(text);
  if (!s) return false;
  const qMarks = (s.match(/\?/g) || []).length;
  if (qMarks >= 2) return true;
  const whCount =
    (s.match(/\b(?:what|when|where|which|who|why|how)\b/gi) || []).length;
  return whCount >= 2 && /\band\b/i.test(s);
}

function buildMultipartQuestionFromRaw(rawQuestion) {
  const raw = normalizeOneLine(rawQuestion);
  if (!raw) return "";
  const splitByQuestion = raw
    .split(/\?/g)
    .map((p) => normalizeOneLine(p))
    .filter(Boolean);
  const segments = (
    splitByQuestion.length >= 2
      ? splitByQuestion
      : raw
          .split(/[.!]\s+/g)
          .map((p) => normalizeOneLine(p))
          .filter(Boolean)
  )
    .map((seg) =>
      seg
        .replace(/^(?:okay|ok|alright|all right|so|now|well|and then|then)\b[\s,.:;!-]*/i, "")
        .replace(/^(?:can you|could you|please)\s+/i, "")
        .trim(),
    )
    .filter(Boolean);
  if (segments.length === 0) return "";
  if (segments.length === 1) return cleanQuestionSurface(segments[0]);

  const head = segments[0].replace(/[?!.]+$/g, "").trim();
  const tail = segments
    .slice(1, 4)
    .map((seg) =>
      seg
        .replace(/^(?:and|also|then)\s+/i, "")
        .replace(/[?!.]+$/g, "")
        .trim(),
    )
    .filter(Boolean)
    .map((seg) =>
      seg.length >= 2 ? `${seg.charAt(0).toLowerCase()}${seg.slice(1)}` : seg.toLowerCase(),
    );
  if (!head || tail.length === 0) return cleanQuestionSurface(head || segments[0]);

  let combined = "";
  if (tail.length === 1) {
    combined = `${head} and ${tail[0]}`;
  } else {
    const rest = tail.slice(0, -1).join(", ");
    combined = `${head}, ${rest}, and ${tail[tail.length - 1]}`;
  }
  combined = combined.replace(/\s+/g, " ").trim();
  combined = combined
    .replace(/\b(?:and|or|but|for|with|of|in|on|at|by|from)\s*$/i, "")
    .trim();
  return cleanQuestionSurface(combined);
}

function combineRefineCanonical({ currentCanonical, nextCanonical, rawText }) {
  const current = normalizeOneLine(currentCanonical);
  const next = normalizeOneLine(nextCanonical);
  const raw = normalizeOneLine(rawText);
  if (!current) return next;
  if (!next) return current;
  if (current === next) return current;
  if (isLikelyVagueHandleFollowup(next)) return current;

  const rawMultipart = looksMultipartQuestionText(raw) ? buildMultipartQuestionFromRaw(raw) : "";
  if (rawMultipart) {
    const currentOnMultipart = questionCoverageScore(current, rawMultipart);
    const nextOnMultipart = questionCoverageScore(next, rawMultipart);
    const nextLooksFollowupFacet =
      isLikelyShortFollowupSubquestion(next) ||
      /^(?:what|when|where|which|how|why|who)\b/i.test(next);
    if (nextLooksFollowupFacet) {
      if (isReferentialFollowupAsk(next)) {
        return rawMultipart;
      }
      const mergedFollowup = mergeCanonicalWithShortFollowup({
        currentCanonical: current,
        followupRawTurn: next,
      });
      if (mergedFollowup) {
        const mergedScore = questionCoverageScore(mergedFollowup, rawMultipart);
        if (mergedScore + 0.02 >= Math.max(currentOnMultipart, nextOnMultipart)) {
          return mergedFollowup;
        }
      }
      if (currentOnMultipart + 0.03 >= nextOnMultipart) return current;
    }
    if (
      currentOnMultipart >= nextOnMultipart + 0.1 &&
      countWords(current) >= countWords(next)
    ) {
      return current;
    }
    if (
      nextOnMultipart >= currentOnMultipart + 0.14 &&
      countWords(next) >= countWords(current) + 3
    ) {
      return next;
    }
  }

  const currentNormTokens = normalizeText(current).split(" ").filter(Boolean);
  const nextNormTokens = normalizeText(next).split(" ").filter(Boolean);
  let sharedPrefix = 0;
  while (
    sharedPrefix < currentNormTokens.length &&
    sharedPrefix < nextNormTokens.length &&
    currentNormTokens[sharedPrefix] === nextNormTokens[sharedPrefix]
  ) {
    sharedPrefix += 1;
  }
  if (sharedPrefix >= 4) {
    return countWords(next) >= countWords(current) ? next : current;
  }

  if (isLikelyShortFollowupSubquestion(next)) {
    if (isReferentialFollowupAsk(next)) return current;
    const overlapFollowup = questionSemanticOverlap(current, next);
    if (overlapFollowup >= 0.82) return current;
    const leftFollowup = current.replace(/[?!.]+$/g, "").trim();
    const rightFollowupRaw = next.replace(/[?!.]+$/g, "").trim();
    if (!leftFollowup || !rightFollowupRaw) return current;
    const rightFollowup =
      rightFollowupRaw.length >= 2
        ? `${rightFollowupRaw.charAt(0).toLowerCase()}${rightFollowupRaw.slice(1)}`
        : rightFollowupRaw.toLowerCase();
    const mergedFollowup = `${leftFollowup} and ${rightFollowup}`
      .replace(/\s+/g, " ")
      .trim();
    if (mergedFollowup && mergedFollowup.length <= 220) return mergedFollowup;
    return current;
  }

  const overlap = questionSemanticOverlap(current, next);
  const jaccard = tokenSetJaccard(current, next);
  const currentScore = raw ? questionCoverageScore(current, raw) : 0;
  const nextScore = raw ? questionCoverageScore(next, raw) : 0;

  if (overlap >= 0.45 || jaccard >= 0.38) {
    return nextScore >= currentScore ? next : current;
  }
  if (nextScore + 0.08 < currentScore) return current;
  if (currentScore + 0.08 < nextScore) return next;

  const left = current.replace(/[?!.]+$/g, "").trim();
  const rightRaw = next.replace(/[?!.]+$/g, "").trim();
  if (!left || !rightRaw) return currentScore >= nextScore ? current : next;
  const right =
    rightRaw.length >= 2
      ? `${rightRaw.charAt(0).toLowerCase()}${rightRaw.slice(1)}`
      : rightRaw.toLowerCase();
  const merged = `${left} and ${right}`.replace(/\s+/g, " ").trim();
  if (merged && merged.length <= 220) return merged;
  return currentScore >= nextScore ? current : next;
}

function chooseStablePayloadQuestion({ modelQuestion, canonicalQuestion, rawQuestion }) {
  const model = cleanQuestionSurface(modelQuestion);
  const canonical = cleanQuestionSurface(canonicalQuestion);
  const raw = cleanQuestionSurface(rawQuestion);
  const rawMultipart = looksMultipartQuestionText(rawQuestion)
    ? buildMultipartQuestionFromRaw(rawQuestion)
    : "";
  const modelAskLike = isAskLikeSummaryText(model);
  const canonicalAskLike = isAskLikeSummaryText(canonical);
  const rawAskLike = isAskLikeSummaryText(rawMultipart || raw);
  const invitationPromptRe =
    /\b(?:do you have any questions(?: for me| for us| for the interviewer)?|what questions do you have|any questions for me|any questions for us)\b/i;
  const canonicalIsInvitation = invitationPromptRe.test(canonical);
  const rawIsInvitation = invitationPromptRe.test(rawMultipart || raw);
  const modelIsInvitation = invitationPromptRe.test(model);

  if ((canonicalIsInvitation || rawIsInvitation) && !modelIsInvitation) {
    if (canonicalIsInvitation) {
      return {
        question: canonical,
        source: "canonical_invitation_guard",
        temporary: false,
      };
    }
    return {
      question: rawMultipart || raw,
      source: "raw_invitation_guard",
      temporary: true,
    };
  }

  if (model) {
    if (!modelAskLike) {
      if (canonicalAskLike) {
        return {
          question: canonical,
          source: "canonical_nonask_model_guard",
          temporary: false,
        };
      }
      if (rawAskLike) {
        return {
          question: rawMultipart || raw,
          source: "raw_nonask_model_guard",
          temporary: true,
        };
      }
    }
    // Model-first semantics for UI text, with multipart retention guard.
    if (canonical && raw && looksMultipartQuestionText(raw)) {
      const modelScore = questionCoverageScore(model, raw);
      const canonicalScore = questionCoverageScore(canonical, raw);
      const modelWords = countWords(model);
      const canonicalWords = countWords(canonical);
      const canonicalLooksBroader =
        canonicalWords >= modelWords + 5 && canonicalScore >= modelScore + 0.05;
      if (canonicalScore >= modelScore + 0.1 || canonicalLooksBroader) {
        const mergedLike = canonical.includes(";");
        return {
          question: mergedLike ? flattenMergedQuestionForDisplay(canonical) : canonical,
          source: mergedLike
            ? "canonical_merged_multipart_guard"
            : "canonical_multipart_guard",
          temporary: mergedLike,
        };
      }
    }
    if (!canonical && rawMultipart) {
      const modelScore = questionCoverageScore(model, rawQuestion || rawMultipart);
      const rawScore = questionCoverageScore(rawMultipart, rawQuestion || rawMultipart);
      if (
        modelScore < 0.45 &&
        rawScore >= modelScore + 0.18 &&
        countWords(model) <= 9
      ) {
        return {
          question: rawMultipart,
          source: "raw_multipart_guard",
          temporary: true,
        };
      }
    }
    return { question: model, source: "model", temporary: false };
  }

  if (canonical) {
    const mergedLike = canonical.includes(";");
    return {
      question: mergedLike ? cleanQuestionSurface(flattenMergedQuestionForDisplay(canonical)) : canonical,
      source: mergedLike ? "canonical_merged_fallback" : "canonical_fallback",
      temporary: mergedLike,
    };
  }

  if (!raw) return { question: "", source: "none", temporary: false };
  return {
    question: rawMultipart || cleanQuestionSurface(flattenMergedQuestionForDisplay(raw)),
    source: "raw_fallback",
    temporary: true,
  };
}

function coerceInterviewerCanonicalAgainstRaw({ canonicalQuestion, rawQuestion }) {
  const canonical = cleanQuestionSurface(canonicalQuestion);
  if (!canonical) return "";
  if (!isAskLikeSummaryText(canonical)) return "";

  const raw = cleanQuestionSurface(rawQuestion);
  if (!raw) return canonical;
  if (isReferentialFollowupAsk(canonical)) {
    const preferredRaw = buildMultipartQuestionFromRaw(rawQuestion) || raw;
    if (preferredRaw && normalizeText(preferredRaw) !== normalizeText(canonical)) {
      return preferredRaw;
    }
  }
  if (!isAskLikeSummaryText(raw)) return canonical;

  const overlap = questionSemanticOverlap(canonical, raw);
  const jaccard = tokenSetJaccard(canonical, raw);
  const canonicalOnRaw = questionCoverageScore(canonical, raw);
  const rawOnCanonical = questionCoverageScore(raw, canonical);
  const severeMismatch =
    overlap <= 0.12 &&
    jaccard <= 0.18 &&
    canonicalOnRaw <= 0.16 &&
    rawOnCanonical <= 0.16 &&
    countWords(raw) >= 5 &&
    countWords(canonical) >= 4;
  if (severeMismatch) return raw;
  return canonical;
}

function mergeCanonicalWithShortFollowup({ currentCanonical, followupRawTurn }) {
  const current = normalizeOneLine(currentCanonical);
  const followup = normalizeOneLine(followupRawTurn);
  if (!current || !followup) return "";
  const startsAsWhFollowup = /^(?:and\s+)?(?:when|what|which|how|where|who|why)\b/i.test(followup);
  if (!followup.includes("?") && !startsAsWhFollowup) return "";
  if (countWords(followup) > 16) return "";
  if (isReferentialFollowupAsk(followup)) return "";

  const currentTokens = tokenSet(current);
  const followupTokens = tokenSet(followup);
  let novelTokenCount = 0;
  for (const token of followupTokens) {
    if (!currentTokens.has(token)) novelTokenCount += 1;
  }
  const followupOnCurrent = questionCoverageScore(followup, current);
  if (!startsAsWhFollowup && followupOnCurrent >= 0.75 && novelTokenCount === 0) return "";
  if (followupOnCurrent >= 0.9 && novelTokenCount === 0) return "";

  const left = current.replace(/[?!.]+$/g, "").trim();
  const right = followup.replace(/[?!.]+$/g, "").trim();
  if (!left || !right) return "";
  if (normalizeText(left).includes(normalizeText(right))) return "";

  const rightNormalized =
    right.length >= 2 ? `${right.charAt(0).toLowerCase()}${right.slice(1)}` : right.toLowerCase();
  const merged = `${left} and ${rightNormalized}`.replace(/\s+/g, " ").trim();
  if (!merged || merged.length > 220) return "";
  return merged;
}

function stabilizeQuestionText({ previousQuestion, nextQuestion, rawQuestion }) {
  const prev = normalizeOneLine(previousQuestion);
  const next = normalizeOneLine(nextQuestion);
  const raw = normalizeOneLine(rawQuestion);
  if (!next) return prev;
  if (!prev || !raw) return next;
  if (isAskLikeSummaryText(prev) && !isAskLikeSummaryText(next)) return prev;

  const prevScore = questionCoverageScore(prev, raw);
  const nextScore = questionCoverageScore(next, raw);
  const prevWords = countWords(prev);
  const nextWords = countWords(next);
  const tokenLoss = questionTokenLossRatio(prev, next, raw);
  const overlap = questionSemanticOverlap(prev, next);

  if (nextScore + 0.04 < prevScore) return prev;
  if (nextScore <= prevScore + 0.02 && nextWords + 1 < prevWords) return prev;
  if (overlap >= 0.88 && nextWords < prevWords && nextScore <= prevScore + 0.03) return prev;
  if (nextScore <= prevScore + 0.03 && tokenLoss >= 0.25) return prev;
  return next;
}

function shouldSkipNonImprovingReadyUpdate({
  previousReady,
  nextReady,
}) {
  const prev = previousReady && typeof previousReady === "object" ? previousReady : null;
  const next = nextReady && typeof nextReady === "object" ? nextReady : null;
  if (!prev || !next) return false;

  const prevQuestion = normalizeOneLine(prev.question);
  const nextQuestion = normalizeOneLine(next.question);
  if (!prevQuestion || !nextQuestion) return false;

  const prevOutline = Array.isArray(prev.outline) ? prev.outline.filter(Boolean) : [];
  const nextOutline = Array.isArray(next.outline) ? next.outline.filter(Boolean) : [];
  const prevDontMiss = Array.isArray(prev.dontMiss) ? prev.dontMiss.filter(Boolean) : [];
  const nextDontMiss = Array.isArray(next.dontMiss) ? next.dontMiss.filter(Boolean) : [];

  const rawReference = normalizeOneLine(next.rawQuestion || prev.rawQuestion || "");
  const prevCoverage = rawReference ? questionCoverageScore(prevQuestion, rawReference) : 0;
  const nextCoverage = rawReference ? questionCoverageScore(nextQuestion, rawReference) : 0;
  const overlap = questionSemanticOverlap(prevQuestion, nextQuestion);

  const outlineDelta = nextOutline.length - prevOutline.length;
  const dontMissDelta = nextDontMiss.length - prevDontMiss.length;
  const temporaryUpgrade = !!prev.temporaryQuestion && !next.temporaryQuestion;
  const prevFirst = normalizeOneLine(prev.firstSentence);
  const nextFirst = normalizeOneLine(next.firstSentence);
  const prevWords = countWords(prevQuestion);
  const nextWords = countWords(nextQuestion);
  const questionExpanded =
    nextCoverage >= prevCoverage + 0.03 ||
    (nextWords >= prevWords + 3 && nextCoverage + 0.01 >= prevCoverage);

  const clearlyImproved =
    outlineDelta > 0 ||
    dontMissDelta > 0 ||
    temporaryUpgrade ||
    questionExpanded ||
    (!prevFirst && !!nextFirst);
  if (clearlyImproved) return false;

  // Same-question semantic rewrite: allow if meaning moved enough.
  if (overlap < 0.65) return false;

  const clearlyWorse =
    outlineDelta < 0 ||
    dontMissDelta < 0 ||
    nextCoverage + 0.08 < prevCoverage ||
    (!!prevFirst && !nextFirst);
  if (clearlyWorse) return true;

  // Block textual churn that doesn't materially improve quality.
  const mostlyEquivalent =
    outlineDelta === 0 &&
    dontMissDelta === 0 &&
    Math.abs(nextCoverage - prevCoverage) < 0.03 &&
    overlap >= 0.92 &&
    nextWords <= prevWords + 1;
  return mostlyEquivalent;
}

function stripBulletPrefix(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  return s
    .replace(/^\s*(?:[-*•\u2022]|→|–|—)+\s*/g, "")
    .replace(/^\s*\d+[.)]\s+/g, "")
    .trim();
}

function isLiveCoachUnsupportedLanguageError(errOrMessage) {
  const message =
    typeof errOrMessage === "string"
      ? errOrMessage
      : errOrMessage?.message || String(errOrMessage || "");
  return /live_coach_language_unsupported|language_unsupported|available\s+in\s+english\s+only/i.test(
    message,
  );
}

function isLiveCoachSupportedAnswerLanguage(answerLanguage) {
  const raw = typeof answerLanguage === "string" ? answerLanguage.trim().toLowerCase() : "";
  if (!raw) return true;
  return raw === "english" || raw === "en" || raw === "en-us" || raw === "en-gb";
}

function buildLocalCardsErrorFallbackPayload({ question, questionId, now, errorMessage }) {
  const rawQuestion = normalizeOneLine(question?.canonicalQuestion || question?.rawText || "");
  const stableQuestionChoice = chooseStablePayloadQuestion({
    modelQuestion: "",
    canonicalQuestion: question?.canonicalQuestion || "",
    rawQuestion: question?.rawText || "",
  });
  const stableQuestion = cleanQuestionSurface(
    stableQuestionChoice?.question || rawQuestion || "Current interviewer ask",
  );
  const inferredQuestionType =
    resolveQuestionTypeFromAsk({
      parsedQuestionType:
        typeof question?.questionType === "string" ? question.questionType : "",
      askText: stableQuestion || rawQuestion || "",
      fallbackQuestionType: inferQuestionTypeFromAskText(stableQuestion || rawQuestion || ""),
    }) || inferQuestionTypeFromAskText(stableQuestion || rawQuestion || "");
  return {
    status: "ready",
    questionId,
    rawQuestion: rawQuestion || question?.rawText || "",
    question: stableQuestion || rawQuestion || "Current interviewer ask",
    firstSentence: "",
    firstSentenceIsFallback: false,
    outline: buildGenericFallbackOutline(inferredQuestionType, stableQuestion || rawQuestion || ""),
    dontMiss: buildGenericFallbackDontMiss(
      inferredQuestionType,
      stableQuestion || rawQuestion || "",
    ),
    questionType: inferredQuestionType,
    confidence:
      typeof question?.confidence === "number" ? question.confidence : null,
    cardsSource: "local_error_fallback",
    cardsFinishReason: "local_error_fallback",
    cardsProvider: "local",
    cardsSalvaged: "",
    cardsFallbackReason:
      typeof errorMessage === "string" && errorMessage
        ? safeTrim(errorMessage, 160)
        : "generation_failed",
    cardsWinner: "fallback",
    cardsLatencyMs: "",
    cardsTotalLatencyMs: "",
    cardsAreFallback: true,
    updatedAt: typeof now === "function" ? now() : Date.now(),
  };
}

class LiveCoachEngine {
  /**
   * @param {Object} deps
   * @param {(channel: string, payload?: any) => void} deps.sendIpc
   * @param {(input: {questionText: string, canonicalQuestion?: string, recentTurns: Array<{speaker:string,text:string}>, brief: string, answerLanguage: string}) => Promise<any>} deps.generateCards
   * @param {(input: {candidateText: string, candidateSpeaker?: string, recentTurns: Array<{speaker:string,text:string}>, currentQuestionText: string, currentQuestionType: string, answerLanguage: string}) => Promise<any>} [deps.classifyTurn]
   * @param {boolean} [deps.debug]
   * @param {() => number} [deps.now]
   */
  constructor({ sendIpc, generateCards, classifyTurn = null, debug = false, now = () => Date.now() }) {
    this._sendIpc = sendIpc;
    this._generateCards = generateCards;
    this._classifyTurn = typeof classifyTurn === "function" ? classifyTurn : null;
    this._debug = !!debug;
    this._now = now;

    this._enabled = false;
    this._active = false;
    this._paused = false;

    this._sessionId = null;
    this._sessionStartedAt = 0;
    this._brief = "";
    this._answerLanguage = "English";
    this._unsupportedAnswerLanguage = false;
    this._contextMeta = null;

    this._fullTranscript = [];
    this._recentTurns = [];

    this._questionSeq = 0;
    this._currentQuestion = null; // {id, rawParts, rawPartsSeen, rawText, canonicalQuestion, questionType, confidence, createdAt, lastUpdatedAt, answerStartedAt, coachConfidence, coachQuestion, coachQuestionUpdatedAt, reason}

    this._intentInFlight = false;
    this._intentQueued = [];
    this._intentDrainTimer = null;
    this._intentCache = new Map(); // key -> { at, result }
    this._lastIntentAt = 0;
    this._pendingIntentTurn = null; // recovery slot for transient intent failures

    this._cardsInFlightByQuestionId = new Set();
    this._cardsAbortControllerByQuestionId = new Map();
    this._queuedCardsByQuestionId = new Map();
    this._cardsRequestSeq = 0;
    this._readyCountByQuestionId = new Map();
    this._lastReadyByQuestionId = new Map();
    this._generationAttemptByQuestionId = new Map(); // qId -> { count, lastAt }
    this._pendingFailureTimersByQuestionId = new Map();
    this._pendingFailureMetaByQuestionId = new Map();
    this._pauseAbortedQuestionIds = new Set();

    this._cardsDebounceTimer = null;
    this._lastReadySignature = null; // { questionId, signature }
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (!this._enabled) this.stopSession();
  }

  setPracticeModeEnabled(enabled) {
    // Still used by main.js gating; semantics are model-first now.
    this._practiceModeEnabled = !!enabled;
  }

  isActive() {
    return this._active;
  }

  isPaused() {
    return this._active && this._paused;
  }

  getCurrentQuestionSnapshot() {
    if (!this._enabled || !this._active) return null;
    const q = this._currentQuestion;
    if (!q) return null;

    const displayText =
      typeof q.canonicalQuestion === "string" && q.canonicalQuestion.trim()
        ? q.canonicalQuestion.trim()
        : (q.rawText || "").trim();

    const confidence =
      typeof q.coachConfidence === "number"
        ? q.coachConfidence
        : typeof q.confidence === "number"
          ? q.confidence
          : null;

    const questionType = typeof q.questionType === "string" ? q.questionType : "";
    const shouldExposeCoachQuestion = questionType !== "coding" && questionType !== "system_design";
    const coachQuestion = shouldExposeCoachQuestion
      ? typeof q.coachQuestion === "string"
        ? q.coachQuestion.trim()
        : ""
      : "";

    return {
      questionId: q.id,
      displayText,
      coachQuestion,
      confidence,
      phase: q.phase || "",
      questionType: q.questionType || "",
      anchorStartMs: typeof q.anchorStartMs === "number" ? q.anchorStartMs : null,
      anchorEndMs: typeof q.anchorEndMs === "number" ? q.anchorEndMs : null,
      anchorAtMs: typeof q.anchorAtMs === "number" ? q.anchorAtMs : null,
      createdAt: typeof q.createdAt === "number" ? q.createdAt : null,
      lastUpdatedAt: typeof q.lastUpdatedAt === "number" ? q.lastUpdatedAt : null,
      coachQuestionUpdatedAt:
        typeof q.coachQuestionUpdatedAt === "number" ? q.coachQuestionUpdatedAt : null,
      reason: typeof q.reason === "string" ? q.reason : "",
    };
  }

  startSession({ brief, answerLanguage, contextMeta } = {}) {
    if (!this._enabled) return;
    this.stopSession();

    this._active = true;
    this._paused = false;
    this._sessionId = crypto.randomUUID();
    this._sessionStartedAt = this._now();
    this._brief = safeTrim(brief || "", 8000, "both");
    this._answerLanguage = answerLanguage || "English";
    this._unsupportedAnswerLanguage = !isLiveCoachSupportedAnswerLanguage(this._answerLanguage);
    this._contextMeta = contextMeta && typeof contextMeta === "object" ? contextMeta : null;

    this._fullTranscript = [];
    this._recentTurns = [];
    this._questionSeq = 0;
    this._currentQuestion = null;

    this._intentInFlight = false;
    this._intentQueued = [];
    this._intentDrainTimer = null;
    this._intentCache = new Map();
    this._lastIntentAt = 0;
    this._pendingIntentTurn = null;

    this._cardsInFlightByQuestionId = new Set();
    this._cardsAbortControllerByQuestionId = new Map();
    this._queuedCardsByQuestionId = new Map();
    this._cardsRequestSeq = 0;
    this._generationAttemptByQuestionId = new Map();
    this._readyCountByQuestionId = new Map();
    this._lastReadyByQuestionId = new Map();
    this._pendingFailureTimersByQuestionId = new Map();
    this._pendingFailureMetaByQuestionId = new Map();
    this._pauseAbortedQuestionIds = new Set();

    if (this._cardsDebounceTimer) {
      clearTimeout(this._cardsDebounceTimer);
      this._cardsDebounceTimer = null;
    }

    this._lastReadySignature = null;

    this._sendIpc("live-coach-session-started", {
      sessionId: this._sessionId,
      contextMeta: this._contextMeta,
    });
    this._sendIpc("live-coach-update", { status: "idle" });
    if (this._unsupportedAnswerLanguage) {
      console.warn(
        `[LiveCoach] Live Coach is disabled for unsupported answer language: ${safeTrim(
          this._answerLanguage,
          60,
        )}`,
      );
    }
    console.log("[LiveCoach] Session started");
  }

  updateSessionConfig({ brief, answerLanguage, contextMeta } = {}) {
    if (typeof brief === "string") {
      this._brief = safeTrim(brief || "", 8000, "both");
    }
    if (answerLanguage) {
      this._answerLanguage = answerLanguage || "English";
      this._unsupportedAnswerLanguage = !isLiveCoachSupportedAnswerLanguage(
        this._answerLanguage
      );
    }
    if (contextMeta && typeof contextMeta === "object") {
      this._contextMeta = contextMeta;
    }
    if (!this._active) return;
    this._sendIpc("live-coach-context-updated", {
      sessionId: this._sessionId,
      contextMeta: this._contextMeta,
    });
  }

  stopSession() {
    if (this._cardsDebounceTimer) {
      clearTimeout(this._cardsDebounceTimer);
      this._cardsDebounceTimer = null;
    }

    if (this._active) {
      this._sendIpc("live-coach-session-stopped", { sessionId: this._sessionId });
      if (this._pendingFailureMetaByQuestionId instanceof Map) {
        for (const questionId of this._pendingFailureMetaByQuestionId.keys()) {
          this._flushPendingGenerationFailure(questionId);
        }
      }
    }

    this._active = false;
    this._paused = false;
    this._sessionId = null;
    this._sessionStartedAt = 0;
    this._brief = "";
    this._answerLanguage = "English";
    this._unsupportedAnswerLanguage = false;
    this._contextMeta = null;
    this._fullTranscript = [];
    this._recentTurns = [];
    this._currentQuestion = null;
    this._lastReadySignature = null;
    this._intentInFlight = false;
    this._intentQueued = [];
    if (this._intentDrainTimer) {
      clearTimeout(this._intentDrainTimer);
      this._intentDrainTimer = null;
    }
    this._intentCache = new Map();
    this._lastIntentAt = 0;
    this._pendingIntentTurn = null;
    this._cardsInFlightByQuestionId = new Set();
    if (this._cardsAbortControllerByQuestionId instanceof Map) {
      for (const controller of this._cardsAbortControllerByQuestionId.values()) {
        try {
          controller.abort();
        } catch (_) {}
      }
    }
    this._cardsAbortControllerByQuestionId = new Map();
    this._queuedCardsByQuestionId = new Map();
    this._generationAttemptByQuestionId = new Map();
    this._readyCountByQuestionId = new Map();
    this._lastReadyByQuestionId = new Map();
    this._pauseAbortedQuestionIds = new Set();
    if (this._pendingFailureTimersByQuestionId instanceof Map) {
      for (const timer of this._pendingFailureTimersByQuestionId.values()) {
        try {
          clearTimeout(timer);
        } catch (_) {}
      }
    }
    this._pendingFailureTimersByQuestionId = new Map();
    this._pendingFailureMetaByQuestionId = new Map();
  }

  pauseSession() {
    if (!this._active) return false;
    this._paused = true;
    if (this._cardsDebounceTimer) {
      clearTimeout(this._cardsDebounceTimer);
      this._cardsDebounceTimer = null;
    }
    if (this._intentDrainTimer) {
      clearTimeout(this._intentDrainTimer);
      this._intentDrainTimer = null;
    }
    this._intentQueued = [];
    this._pendingIntentTurn = null;
    this._queuedCardsByQuestionId = new Map();
    this._pauseAbortedQuestionIds = new Set();
    if (this._cardsAbortControllerByQuestionId instanceof Map) {
      for (const [questionId, controller] of this._cardsAbortControllerByQuestionId.entries()) {
        if (questionId) this._pauseAbortedQuestionIds.add(questionId);
        try {
          controller.abort();
        } catch (_) {}
      }
    }
    if (this._pendingFailureTimersByQuestionId instanceof Map) {
      for (const timer of this._pendingFailureTimersByQuestionId.values()) {
        try {
          clearTimeout(timer);
        } catch (_) {}
      }
    }
    this._pendingFailureTimersByQuestionId = new Map();
    this._pendingFailureMetaByQuestionId = new Map();
    return true;
  }

  resumeSession() {
    if (!this._active) return false;
    this._paused = false;
    return true;
  }

  _scheduleIntentQueueDrain(waitMs = 0) {
    if (!this._enabled || !this._active || this._paused) return;
    if (this._intentInFlight) return;
    if (!Array.isArray(this._intentQueued) || this._intentQueued.length === 0) return;
    if (this._intentDrainTimer) return;
    const delay = Number.isFinite(Number(waitMs))
      ? Math.max(0, Math.floor(Number(waitMs)))
      : 0;
    this._intentDrainTimer = setTimeout(() => {
      this._intentDrainTimer = null;
      if (!this._enabled || !this._active || this._paused) return;
      if (this._intentInFlight) return;
      const queue = Array.isArray(this._intentQueued) ? this._intentQueued : [];
      const queued = queue.shift() || null;
      this._intentQueued = queue;
      if (queued) this._maybeClassifyTurn(queued.entry);
    }, delay);
  }

  /**
   * Should the main process forward mic (User) turns into Live Coach in mic+system mode?
   * Keep this conservative but generic: once system audio is authoritative, only allow
   * clear prompt read-aloud turns from mic.
   */
  shouldConsumeUserTurn(turn, options = {}) {
    if (!this._enabled || !this._active) {
      return { consume: false, reason: "inactive" };
    }
    if (this._paused) return { consume: false, reason: "paused" };
    if (!turn || turn.speaker !== "User" || typeof turn.text !== "string") {
      return { consume: false, reason: "invalid_turn" };
    }
    const raw = turn.text.trim();
    if (!raw) return { consume: false, reason: "empty" };
    const normalized = normalizeText(raw);
    if (!normalized) return { consume: false, reason: "empty_normalized" };
    if (isBackchannelLike(normalized)) {
      return { consume: false, reason: "backchannel" };
    }
    const systemHasAuthority = options && options.systemHasAuthority === true;
    if (systemHasAuthority) {
      if (isLikelyUserClarificationTurn(raw)) {
        return {
          consume: false,
          reason: "clarification_under_system_audio",
        };
      }
      if (!isStrongUserReadAloudPromptTurn(raw)) {
        return {
          consume: false,
          reason: "not_read_aloud_prompt_under_system_audio",
        };
      }
      return {
        consume: true,
        reason: "read_aloud_prompt_under_system_audio",
      };
    }
    if (normalizeQuotedUserPromptTurn(raw)) {
      return { consume: true, reason: "quoted_prompt" };
    }
    const wc = countWords(raw);
    if (wc < 4 && !raw.includes("?")) {
      return { consume: false, reason: "too_short" };
    }
    return { consume: true, reason: "meaningful_user_turn" };
  }

  onPartialTurn(_turn) {
    // Opener prefetch has been removed to avoid churn and template fallbacks.
  }

  /**
   * @param {Object} turn
   * @param {"Interviewer"|"User"} turn.speaker
   * @param {string} turn.text
   * @param {number} [turn.start]
   * @param {number} [turn.end]
   */
  onFinalTurn(turn) {
    if (!this._enabled || !this._active) return;
    if (this._paused) return;
    if (this._unsupportedAnswerLanguage) return;
    if (!turn || typeof turn.text !== "string") return;
    const text = turn.text.trim();
    if (!text) return;

    const entry = {
      speaker: turn.speaker,
      text,
      start: typeof turn.start === "number" ? turn.start : null,
      end: typeof turn.end === "number" ? turn.end : null,
      source: typeof turn.source === "string" ? turn.source : "",
      at: this._now(),
    };
    const semanticPromptText =
      entry.speaker === "Interviewer"
        ? normalizeInterviewerPromptTurn(entry.text)
        : entry.speaker === "User"
          ? normalizeQuotedUserPromptTurn(entry.text)
          : "";
    entry.liveCoachSpeaker = semanticPromptText ? "Interviewer" : entry.speaker;
    entry.liveCoachText = semanticPromptText || entry.text;
    this._fullTranscript.push(entry);

    this._recentTurns.push({
      speaker: entry.liveCoachSpeaker,
      text: entry.liveCoachText,
    });
    if (this._recentTurns.length > 12) this._recentTurns.shift();

    // Basic deterministic guards only (avoid flooding the classifier).
    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    const normalized = normalizeText(semanticText);
    if (!normalized) return;
    if (isBackchannelLike(normalized)) return;
    if (
      semanticSpeaker === "Interviewer" &&
      (isConversationManagementTurn(semanticText) ||
        isLikelyHypotheticalEmbeddedAskNarration(entry.text))
    ) {
      return;
    }
    if (countWords(semanticText) < 2 && !semanticText.includes("?")) return;
    if (semanticSpeaker === "Interviewer") {
      const normalizedAsk = normalizeInterviewerPromptTurn(semanticText || "");
      const interviewerLooksAskLike =
        isStrongAskLikeTurn(normalizedAsk) ||
        isLikelyIncompleteQuestionFragment(normalizedAsk);
      const interviewerLooksFragment = shouldConsiderInterviewerFragmentForIntent(
        semanticText || normalizedAsk,
      );
      const interviewerLooksContextPreamble = shouldHoldInterviewerContextPreambleForRecovery(
        semanticText || normalizedAsk,
      );
      if (entry.speaker === "Interviewer" && isLikelySelfDirectedInterviewerQuestion(entry.text || "")) {
        this._pendingIntentTurn = null;
        return;
      }
      if (!interviewerLooksAskLike && !interviewerLooksFragment) {
        this._pendingIntentTurn = interviewerLooksContextPreamble
          ? {
              speaker: "Interviewer",
              text: safeTrim(semanticText || entry.text, 900, "end"),
              start: entry.start,
              end: entry.end,
              at: this._now(),
              source: "interviewer_context_preamble",
            }
          : null;
        return;
      }
    }

    // Mark answer started to reduce churn in practice sessions and for analytics.
    if (entry.speaker === "User" && semanticSpeaker !== "Interviewer" && this._currentQuestion) {
      const wc = countWords(semanticText);
      if (wc >= 4 && typeof this._currentQuestion.answerStartedAt !== "number") {
        this._currentQuestion.answerStartedAt = this._now();
      }
    }
    if (semanticSpeaker !== "Interviewer") {
      this._pendingIntentTurn = null;
    }

    // Recovery path: if the previous interviewer turn was dropped (transient failure or
    // low-confidence ignore), merge it with this new interviewer turn and classify once.
    const pending = this._pendingIntentTurn;
    if (semanticSpeaker === "Interviewer" && pending && pending.speaker === "Interviewer") {
      const ageMs = this._now() - (pending.at || 0);
      this._pendingIntentTurn = null;
      const pendingNormalized = normalizeInterviewerQuestionTurn(pending.text || "");
      const entryNormalized = normalizeInterviewerQuestionTurn(semanticText || "");
      const pendingFragmentText = normalizeOneLine(stripInterviewerLeadIn(pending.text || ""));
      const entryFragmentText = normalizeOneLine(stripInterviewerLeadIn(semanticText || ""));
      const pendingAskLike = isStrongAskLikeTurn(pendingNormalized);
      const entryAskLike = isStrongAskLikeTurn(entryNormalized);
      const pendingIncomplete = isLikelyIncompleteQuestionFragment(pendingNormalized);
      const entryIncomplete = isLikelyIncompleteQuestionFragment(entryNormalized);
      const pendingFragment = shouldConsiderInterviewerFragmentForIntent(
        pending.text || pendingNormalized,
      );
      const entryFragment = shouldConsiderInterviewerFragmentForIntent(
        entry.text || entryNormalized,
      );
      const pendingFollowupish =
        isLikelyAttachedFollowupSubquestion(pendingNormalized) ||
        isLikelyShortFollowupSubquestion(pendingNormalized) ||
        pendingIncomplete;
      const entryFollowupish =
        isLikelyAttachedFollowupSubquestion(entryNormalized) ||
        isLikelyShortFollowupSubquestion(entryNormalized) ||
        entryIncomplete;
      const shouldMerge = true;
      const pendingStandalone =
        pending.source === "intent_failure" && isStandaloneQuestionForRecovery(pending.text);
      const entryStandalone = isStandaloneQuestionForRecovery(entry.text);
      const shouldSkipStandaloneFailureMerge = pendingStandalone && entryStandalone;
      const pendingLooksPreamble = isLikelyInterviewerPreamble(pending.text);
      const entryLooksQuestionish =
        isQuestionLikeBoundaryText(entryNormalized) || isStandaloneQuestionForRecovery(entry.text);
      const shouldSkipPreambleMerge = pendingLooksPreamble && entryLooksQuestionish;
      const pendingHeldContextPreamble =
        pending.source === "interviewer_context_preamble" &&
        shouldHoldInterviewerContextPreambleForRecovery(pending.text || "");
      const maxRecoveryAgeMs = pendingHeldContextPreamble ? 22000 : 6500;
      const shouldMergeRecovered =
        shouldMerge &&
        !shouldSkipStandaloneFailureMerge &&
        !shouldSkipPreambleMerge &&
        ((pendingAskLike &&
          entryAskLike &&
          (pendingFollowupish ||
            entryFollowupish ||
            countWords(pendingNormalized) <= 14 ||
            countWords(entryNormalized) <= 14)) ||
          (pendingFragment && entryFragment) ||
          (pendingFragment && (entryAskLike || entryIncomplete)) ||
          (entryFragment && (pendingAskLike || pendingIncomplete)) ||
          (pendingIncomplete && entryAskLike) ||
          (entryIncomplete && pendingAskLike) ||
          (pendingHeldContextPreamble && entryFragment));
      if (ageMs <= maxRecoveryAgeMs && shouldMergeRecovered) {
        const mergedParts = [];
        if (pendingHeldContextPreamble) {
          const pendingPreambleText = normalizeOneLine(
            stripInterviewerLeadIn(pending.text || "") || pending.text || "",
          );
          if (pendingPreambleText) mergedParts.push(pendingPreambleText);
        } else if ((pendingAskLike || pendingIncomplete) && pendingNormalized) {
          mergedParts.push(pendingNormalized);
        } else if (pendingFragment && pendingFragmentText) {
          mergedParts.push(pendingFragmentText);
        }
        const entryTextForMerge =
          (entryAskLike || entryIncomplete) && entryNormalized
            ? entryNormalized
            : entryFragment && entryFragmentText
              ? entryFragmentText
              : "";
        if (entryTextForMerge) {
          const duplicate = mergedParts.some(
            (part) => normalizeText(part) === normalizeText(entryTextForMerge),
          );
          if (!duplicate) mergedParts.push(entryTextForMerge);
        }
        const mergedText = safeTrim(mergedParts.join(" ").trim(), 900, "end");
        if (mergedText) {
          const mergedEntry = {
            speaker: entry.speaker,
            liveCoachSpeaker: "Interviewer",
            text: mergedText,
            liveCoachText: mergedText,
            start:
              typeof pending.start === "number"
                ? pending.start
                : typeof entry.start === "number"
                  ? entry.start
                  : null,
            end:
              typeof entry.end === "number"
                ? entry.end
                : typeof pending.end === "number"
                  ? pending.end
                  : null,
            at: entry.at,
            _recoveredMerge: true,
          };
          if (this._debug) {
            console.log(
              `[LiveCoach] Recovering dropped intent with merged interviewer turn (age=${ageMs}ms)`,
            );
          }
          this._maybeClassifyTurn(mergedEntry);
          return;
        }
      } else if (ageMs <= maxRecoveryAgeMs && shouldSkipPreambleMerge) {
        if (this._debug) {
          console.log(
            `[LiveCoach] Skipping recovery merge for interviewer preamble + new question (age=${ageMs}ms)`,
          );
        }
        this._maybeClassifyTurn(entry);
        return;
      } else if (ageMs <= maxRecoveryAgeMs && shouldSkipStandaloneFailureMerge && this._debug) {
        console.log(
          `[LiveCoach] Keeping standalone interviewer turns separate after intent failure (age=${ageMs}ms)`,
        );
      }
    }

    this._maybeClassifyTurn(entry);
  }

  _maybeClassifyTurn(entry) {
    if (!this._classifyTurn) return;
    if (!this._enabled || !this._active || this._paused) return;
    if (this._unsupportedAnswerLanguage) return;

    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    const normalizedEntryText =
      semanticSpeaker === "Interviewer"
        ? normalizeInterviewerEntryPrompt(entry, { fallbackToOneLine: true })
        : normalizeOneLine(semanticText || entry?.text || "");
    const now = this._now();
    const currentId = this._currentQuestion?.id || "";
    const cacheKey = `${currentId}::${semanticSpeaker || "?"}::${normalizeText(normalizedEntryText)}`;
    const cached = this._intentCache.get(cacheKey);
    if (cached && now - cached.at < 60000) {
      this._applyIntentResult({ entry, result: cached.result, source: "cache" });
      return;
    }

    // Throttle + single in-flight request to prevent spam.
    const throttleMs = 350;
    if (this._intentInFlight || now - (this._lastIntentAt || 0) < throttleMs) {
      const queue = Array.isArray(this._intentQueued) ? this._intentQueued : [];
      const dedupeKey = cacheKey;
      const hasQueuedSame = queue.some((item) => item && item.dedupeKey === dedupeKey);
      if (!hasQueuedSame) {
        queue.push({ entry, at: now, dedupeKey });
        while (queue.length > 16) queue.shift();
      }
      this._intentQueued = queue;
      const waitMs = this._intentInFlight
        ? 0
        : Math.max(0, throttleMs - (now - (this._lastIntentAt || 0)));
      this._scheduleIntentQueueDrain(waitMs);
      return;
    }

    this._intentInFlight = true;
    this._lastIntentAt = now;
    const sessionId = this._sessionId;
    const baseQuestionId = this._currentQuestion?.id || "";

    const candidateText = safeTrim(normalizedEntryText || entry.text, 900, "end");
    const candidateSpeaker = semanticSpeaker;
    const recentTurns = this._recentTurns.slice();
    const currentQuestionText =
      this._currentQuestion?.canonicalQuestion || this._currentQuestion?.rawText || "";
    const currentQuestionType = this._currentQuestion?.questionType || "";
    const answerLanguage = this._answerLanguage;

    if (this._debug) {
      console.log(
        `[LiveCoach] Intent classify start speaker=${candidateSpeaker || "?"} wc=${countWords(
          candidateText,
        )} current=${baseQuestionId || "<none>"}`,
      );
    }

    (async () => {
      try {
        const maxIntentAttempts = 3;
        let attempt = 0;
        let lastErr = null;
        let result = null;
        while (attempt < maxIntentAttempts) {
          attempt += 1;
          try {
            result = await this._classifyTurn({
              candidateText,
              candidateSpeaker,
              recentTurns,
              currentQuestionText,
              currentQuestionType,
              answerLanguage,
            });
            break;
          } catch (err) {
            lastErr = err;
            if (isLiveCoachUnsupportedLanguageError(err)) break;
            if (attempt >= maxIntentAttempts) break;
            const retryDelayMs = attempt === 1 ? 320 : 900;
            await sleep(retryDelayMs);
            if (!this._enabled || !this._active || this._paused) return;
            if (this._sessionId !== sessionId) return;
          }
        }
        if (!result) throw lastErr || new Error("Intent classifier failed");

        if (!this._enabled || !this._active || this._paused) return;
        if (this._sessionId !== sessionId) return;

        let resultAction = typeof result?.action === "string" ? result.action : "ignore";
        let resultConfidence =
          typeof result?.confidence === "number" ? result.confidence : null;
        const askLikeInterviewerTurn =
          candidateSpeaker === "Interviewer" &&
          isStrongAskLikeTurn(candidateText) &&
          shouldHoldInterviewerTurnForRecovery(candidateText);
        const lowConfidenceInterviewerIgnore =
          askLikeInterviewerTurn &&
          resultAction === "ignore" &&
          (resultConfidence === null || resultConfidence <= 0.45);
        if (lowConfidenceInterviewerIgnore) {
          try {
            const forced = await this._classifyTurn({
              candidateText,
              candidateSpeaker,
              recentTurns,
              currentQuestionText,
              currentQuestionType,
              answerLanguage,
              forceDecision: true,
            });
            if (
              forced &&
              (forced.action === "start_new_question" || forced.action === "refine_current")
            ) {
              result = forced;
              resultAction = forced.action;
              resultConfidence =
                typeof forced.confidence === "number" ? forced.confidence : resultConfidence;
            }
          } catch (_) {}
        }
        const stillLowConfidenceInterviewerIgnore =
          askLikeInterviewerTurn &&
          resultAction === "ignore" &&
          (resultConfidence === null || resultConfidence <= 0.45);
        if (!stillLowConfidenceInterviewerIgnore) {
          // Cache per-(currentQuestionId, speaker, text) so replay/ASR duplicates don't resubmit.
          this._intentCache.set(cacheKey, { at: this._now(), result });
          if (this._intentCache.size > 200) {
            const firstKey = this._intentCache.keys().next().value;
            if (firstKey) this._intentCache.delete(firstKey);
          }
        }

        this._applyIntentResult({ entry, result, source: "model", baseQuestionId });
      } catch (err) {
        const unsupportedLanguage = isLiveCoachUnsupportedLanguageError(err);
        console.warn(
          `[LiveCoach] Intent classifier failed${
            unsupportedLanguage ? " (unsupported language)" : ""
          }: ${err?.message || String(err)}`,
        );
        if (unsupportedLanguage) {
          this._pendingIntentTurn = null;
          return;
        }
        // Keep the failed interviewer turn for one-shot recovery on the next interviewer turn.
        if (semanticSpeaker === "Interviewer" && countWords(semanticText || entry.text) >= 4) {
          this._pendingIntentTurn = {
            speaker: "Interviewer",
            text: safeTrim(semanticText || entry.text, 900, "end"),
            start: entry.start,
            end: entry.end,
            at: this._now(),
            source: "intent_failure",
          };
        }
      } finally {
        this._intentInFlight = false;
        if (this._intentDrainTimer) {
          clearTimeout(this._intentDrainTimer);
          this._intentDrainTimer = null;
        }
        const queue = Array.isArray(this._intentQueued) ? this._intentQueued : [];
        const queued = queue.shift() || null;
        this._intentQueued = queue;
        if (queued && this._enabled && this._active && !this._paused) {
          this._maybeClassifyTurn(queued.entry);
        } else {
          this._scheduleIntentQueueDrain(0);
        }
      }
    })();
  }

  _applyIntentResult({ entry, result, source, baseQuestionId = "" }) {
    if (!this._enabled || !this._active || this._paused) return;

    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    const action = typeof result?.action === "string" ? result.action : "ignore";
    const questionType = typeof result?.questionType === "string" ? result.questionType : "";
    const canonicalQuestionRaw =
      typeof result?.canonicalQuestion === "string" ? result.canonicalQuestion : "";
    let canonicalQuestion = sanitizeCanonicalQuestion(canonicalQuestionRaw);
    if (semanticSpeaker === "Interviewer") {
      const rawAsk = normalizeInterviewerEntryPrompt(entry);
      canonicalQuestion = coerceInterviewerCanonicalAgainstRaw({
        canonicalQuestion,
        rawQuestion: rawAsk,
      });
    }
    const confidence = typeof result?.confidence === "number" ? result.confidence : null;

    if (this._debug) {
      console.log(
        `[LiveCoach] Intent classify result source=${source || "?"} speaker=${
          semanticSpeaker || entry.speaker || "?"
        } action=${action || "?"} type=${questionType || "?"} conf=${
          typeof confidence === "number" ? confidence.toFixed(2) : "?"
        } cq="${safeTrim(canonicalQuestion, 120)}"`,
      );
    }

    if (action === "ignore") {
      if (semanticSpeaker === "Interviewer") {
        const interviewerAskText = normalizeInterviewerEntryPrompt(entry);
        const interviewerFragment =
          shouldConsiderInterviewerFragmentForIntent(semanticText || interviewerAskText);
        const uncertainAskIgnore =
          ((isStrongAskLikeTurn(interviewerAskText) &&
            shouldHoldInterviewerTurnForRecovery(interviewerAskText) &&
            (typeof confidence !== "number" || confidence <= 0.45)) ||
            (interviewerFragment &&
              (typeof confidence !== "number" || confidence <= 0.55)));
        this._pendingIntentTurn = uncertainAskIgnore
          ? {
              speaker: "Interviewer",
              text: safeTrim(interviewerAskText || semanticText || entry.text, 900, "end"),
              start: entry.start,
              end: entry.end,
              at: this._now(),
              source: "intent_uncertain_ignore",
            }
          : null;
      }
      return;
    }

    if (action !== "start_new_question" && action !== "refine_current") return;

    if (
      this._shouldBlockBoundaryAction({
        entry,
        action,
        canonicalQuestion,
        questionType,
        confidence,
      })
    ) {
      if (this._debug) {
        console.log(
          `[LiveCoach] Blocked boundary action=${action} for non-question/preamble turn`,
        );
      }
      return;
    }

    // If the current question changed since the request started, treat refine as start.
    const current = this._currentQuestion;
    const currentMatchesBase = !!current && (!baseQuestionId || current.id === baseQuestionId);

    if (
      action === "start_new_question" &&
      current &&
      this._shouldDowngradeStartNewToRefine({ entry, canonicalQuestion, confidence })
    ) {
      if (this._debug) {
        console.log(
          `[LiveCoach] Downgrading start_new_question to refine_current (attached follow-up) for ${current.id}`,
        );
      }
      this._refineCurrentQuestion({
        entry,
        canonicalQuestion,
        questionType,
        confidence,
        reason: `intent_${source || "model"}_downgraded`,
      });
      return;
    }

    if (action === "start_new_question" || !current || !currentMatchesBase) {
      this._startNewQuestion({
        entry,
        canonicalQuestion,
        questionType,
        confidence,
        reason: `intent_${source || "model"}`,
      });
      return;
    }

    if (
      action === "refine_current" &&
      current &&
      semanticSpeaker === "Interviewer" &&
      shouldIgnoreLowConfidenceDuplicateRefine({
        currentQuestion: current.canonicalQuestion || current.rawText,
        rawQuestion:
          normalizeInterviewerEntryPrompt(entry, {
            allowStandaloneProbe: true,
            fallbackToOneLine: true,
          }) ||
          semanticText ||
          entry.text,
        canonicalQuestion,
        confidence,
        readyCount: this._readyCountByQuestionId.get(current.id) || 0,
      })
    ) {
      if (this._debug) {
        console.log(
          `[LiveCoach] Ignoring low-confidence duplicate refine for ${current.id}`,
        );
      }
      return;
    }

    if (
      action === "refine_current" &&
      this._shouldPromoteRefineToNewQuestionAfterReady({
        entry,
        canonicalQuestion,
        confidence,
      })
    ) {
      const promotedCanonical =
        sanitizeCanonicalQuestion(normalizeInterviewerQuestionTurn(entry.text)) || canonicalQuestion;
      const promotedQuestionType = inferQuestionTypeFromAskText(
        promotedCanonical || normalizeInterviewerQuestionTurn(entry.text) || entry.text || "",
      );
      if (this._debug) {
        console.log(
          `[LiveCoach] Promoting refine_current to start_new_question (post-ready interviewer follow-up) for ${current.id}`,
        );
      }
      this._startNewQuestion({
        entry,
        canonicalQuestion: promotedCanonical,
        questionType: promotedQuestionType || questionType,
        confidence,
        reason: `intent_${source || "model"}_post_ready_promoted`,
      });
      return;
    }

    if (
      this._shouldPromoteRefineToNewQuestion({
        entry,
        canonicalQuestion,
        confidence,
      })
    ) {
      const promotedCanonical =
        sanitizeCanonicalQuestion(normalizeInterviewerQuestionTurn(entry.text)) || canonicalQuestion;
      const promotedQuestionType = inferQuestionTypeFromAskText(
        promotedCanonical || normalizeInterviewerQuestionTurn(entry.text) || entry.text || "",
      );
      if (this._debug) {
        console.log(
          `[LiveCoach] Promoting refine_current to start_new_question (clear topic shift) for ${current.id}`,
        );
      }
      this._startNewQuestion({
        entry,
        canonicalQuestion: promotedCanonical,
        questionType: promotedQuestionType || questionType,
        confidence,
        reason: `intent_${source || "model"}_promoted`,
      });
      return;
    }

    // refine_current
    this._refineCurrentQuestion({
      entry,
      canonicalQuestion,
      questionType,
      confidence,
      reason: `intent_${source || "model"}`,
    });
  }

  _shouldBlockBoundaryAction({
    entry,
    action,
    canonicalQuestion,
    questionType,
    confidence,
  }) {
    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    if (!entry || semanticSpeaker !== "Interviewer") return false;
    if (action !== "start_new_question" && action !== "refine_current") return false;

    const rawOriginal = normalizeOneLine(semanticText || entry.text);
    const sourceOriginal = normalizeOneLine(entry.text);
    const originalSpeaker =
      entry && typeof entry.speaker === "string" ? entry.speaker : "";
    const turnSource =
      entry && typeof entry.source === "string" ? entry.source : "";
    if (isLikelyHypotheticalEmbeddedAskNarration(sourceOriginal)) {
      return true;
    }
    if (
      originalSpeaker === "User" &&
      /\bmic\b/i.test(turnSource) &&
      isLikelyUserClarificationTurn(rawOriginal)
    ) {
      return true;
    }
    if (
      isLikelyNoisyMicLinuxProbe({
        entry,
        rawText: rawOriginal,
        canonicalQuestion,
      })
    ) {
      return true;
    }
    const raw = normalizeInterviewerEntryPrompt(entry);
    const canonical = normalizeOneLine(canonicalQuestion);
    if (!raw && !canonical) return true;
    if (isConversationManagementTurn(rawOriginal) || isConversationManagementTurn(raw)) return true;
    if (
      action === "start_new_question" &&
      this._currentQuestion &&
      questionType === "other" &&
      (typeof confidence !== "number" || confidence < 0.45)
    ) {
      return true;
    }
    if (isLikelyIncompleteQuestionFragment(raw)) return true;
    if (isBackchannelLike(normalizeText(raw))) return true;

    const rawQuestionish = isQuestionLikeBoundaryText(raw);
    const canonicalQuestionish = isQuestionLikeBoundaryText(canonical);
    const coordinatedRefineAllow =
      action === "refine_current" &&
      !!this._currentQuestion &&
      typeof confidence === "number" &&
      confidence >= 0.9 &&
      !!canonical &&
      canonicalQuestionish &&
      isLikelyCoordinatedQuestionTail(rawOriginal) &&
      isLikelyCanonicalExtensionOfCurrentQuestion({
        currentQuestion:
          this._currentQuestion.canonicalQuestion || this._currentQuestion.rawText,
        nextQuestion: canonical,
      });
    const highConfidenceTechnicalRefine =
      action === "refine_current" &&
      !!this._currentQuestion &&
      (questionType === "coding" || questionType === "system_design") &&
      typeof confidence === "number" &&
      confidence >= 0.9 &&
      !!canonical &&
      !isLikelyInterviewerPreamble(rawOriginal);
    const highConfidenceTechnicalStart =
      action === "start_new_question" &&
      !this._currentQuestion &&
      (questionType === "coding" || questionType === "system_design") &&
      typeof confidence === "number" &&
      confidence >= 0.9 &&
      /^(?:question\s+problem|problem|task|given|implement|write|design|build|create|debug)\b/i.test(
        canonical || rawOriginal,
      );
    const technicalConstraintRefine =
      action === "refine_current" &&
      !!this._currentQuestion &&
      (questionType === "coding" ||
        questionType === "system_design" ||
        this._currentQuestion.questionType === "coding" ||
        this._currentQuestion.questionType === "system_design") &&
      typeof confidence === "number" &&
      confidence >= 0.45 &&
      !!canonical &&
      countWords(canonical) >= 6 &&
      !isLikelyInterviewerPreamble(rawOriginal) &&
      !isConversationManagementTurn(rawOriginal) &&
      !isBackchannelLike(normalizeText(rawOriginal));
    if (
      highConfidenceTechnicalRefine ||
      highConfidenceTechnicalStart ||
      technicalConstraintRefine ||
      coordinatedRefineAllow
    ) {
      if (this._debug && coordinatedRefineAllow) {
        console.log(
          `[LiveCoach] Allowing coordinated refine tail for ${this._currentQuestion?.id || "?"}: "${safeTrim(
            rawOriginal,
            80,
          )}" -> "${safeTrim(canonical, 120)}"`,
        );
      }
      return false;
    }
    if (!rawQuestionish && !canonicalQuestionish) return true;

    // If only the model canonical looks question-like but raw turn has no ask directive,
    // block this boundary to prevent statement/preamble drift from becoming "They asked".
    if (!rawQuestionish && canonicalQuestionish && !hasEmbeddedAskDirective(rawOriginal)) {
      return true;
    }

    if (
      action === "start_new_question" &&
      this._currentQuestion &&
      typeof confidence === "number" &&
      confidence < 0.5 &&
      (!isStrongAskLikeTurn(raw) || countWords(raw) < 4 || isLikelyIncompleteQuestionFragment(raw))
    ) {
      return true;
    }

    if (action === "start_new_question" && questionType === "other") {
      const lowConfidenceOther = typeof confidence !== "number" || confidence < 0.75;
      const hasCanonical = !!canonical && countWords(canonical) >= 4;
      const rawTokens = tokenSet(raw);
      const directiveStart =
        /^(?:tell me|describe|explain|walk me through|share|give|implement|design|build|debug|write)\b/i.test(
          raw,
        );
      const shortWeakRaw =
        countWords(raw) < 7 && rawTokens.size < 4 && !directiveStart;
      const referentialWeakRaw =
        hasFollowupReferencePronoun(raw) && rawTokens.size < 4 && !directiveStart;
      const lowConfidenceStatementLikeRaw =
        !raw.includes("?") &&
        !hasEmbeddedAskDirective(rawOriginal) &&
        countWords(raw) < 8 &&
        rawTokens.size < 5;
      if (lowConfidenceOther && !hasCanonical && (shortWeakRaw || referentialWeakRaw)) {
        return true;
      }
      if (lowConfidenceOther && lowConfidenceStatementLikeRaw) {
        return true;
      }
    }

    // Generic setup/preamble guard: long setup text without a direct ask should not become
    // "They asked" even if model intent drifts once.
    if (
      isLikelyInterviewerPreamble(rawOriginal) &&
      !rawOriginal.includes("?") &&
      countWords(rawOriginal) >= 10 &&
      !isQuestionLikeBoundaryText(raw) &&
      !isLikelyAttachedFollowupSubquestion(canonical)
    ) {
      return true;
    }

    return false;
  }

  _shouldDowngradeStartNewToRefine({ entry, canonicalQuestion, confidence }) {
    const q = this._currentQuestion;
    if (!q) return false;
    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    if (!entry || semanticSpeaker !== "Interviewer") return false;

    const incomingTurnAtMs =
      typeof entry.start === "number"
        ? entry.start
        : typeof entry.end === "number"
          ? entry.end
          : null;
    const priorTurnAtMs =
      typeof q.lastInterviewerTurnAtMs === "number" ? q.lastInterviewerTurnAtMs : null;
    const sourceGapMs =
      Number.isFinite(incomingTurnAtMs) && Number.isFinite(priorTurnAtMs)
        ? Math.max(0, incomingTurnAtMs - priorTurnAtMs)
        : null;
    const raw =
      normalizeInterviewerEntryPrompt(entry, { allowStandaloneProbe: true });
    const next = normalizeOneLine(canonicalQuestion || raw);
    if (!raw || !next) return false;
    const vagueHandleFollowup =
      isLikelyVagueHandleFollowup(raw) || isLikelyVagueHandleFollowup(next);

    const readyCount = this._readyCountByQuestionId.get(q.id) || 0;
    if (readyCount > 0) {
      const now = this._now();
      const lastReadyAt =
        typeof q.coachQuestionUpdatedAt === "number"
          ? q.coachQuestionUpdatedAt
          : typeof q.lastUpdatedAt === "number"
            ? q.lastUpdatedAt
            : typeof q.createdAt === "number"
              ? q.createdAt
              : now;
      const idleAfterReadyMs = Math.max(0, now - lastReadyAt);
      const answered =
        typeof q.answerStartedAt === "number" &&
        typeof q.createdAt === "number" &&
        q.answerStartedAt >= q.createdAt;
      if (
        !vagueHandleFollowup &&
        (answered ||
          idleAfterReadyMs >= 14000 ||
          (Number.isFinite(sourceGapMs) && sourceGapMs >= 12000))
      ) {
        return false;
      }
    }

    const rawHasReference = hasFollowupReferencePronoun(raw);
    if (vagueHandleFollowup) {
      return true;
    }
    if (isLikelyAttachedFollowupSubquestion(raw) || (rawHasReference && isLikelyAttachedFollowupSubquestion(next))) {
      return true;
    }
    if (/^and\b/i.test(raw) && (rawHasReference || countWords(raw) <= 8)) return true;
    if (typeof confidence === "number" && confidence < 0.55) return false;

    const currentText = normalizeOneLine(q.canonicalQuestion || q.rawText);
    if (!currentText) return false;
    const referentialContext = splitReferentialQuestionContext(raw);
    if (referentialContext) {
      const contextOverlap = questionSemanticOverlap(currentText, referentialContext.context);
      const contextJaccard = tokenSetJaccard(currentText, referentialContext.context);
      if (contextOverlap <= 0.2 && contextJaccard <= 0.24) {
        return false;
      }
    }
    const currentTokens = tokenSet(currentText);
    const rawTokens = tokenSet(raw);
    let novelTokenCount = 0;
    for (const token of rawTokens) {
      if (!currentTokens.has(token)) novelTokenCount += 1;
    }
    const standaloneShiftOverlap = questionSemanticOverlap(currentText, raw);
    const standaloneShiftJaccard = tokenSetJaccard(currentText, raw);
    const currentOnRaw = questionCoverageScore(currentText, raw);
    const nextOnRaw = questionCoverageScore(next, raw);
    const standaloneTopicShift =
      isStrongAskLikeTurn(raw) &&
      countWords(raw) >= 10 &&
      standaloneShiftOverlap <= 0.2 &&
      standaloneShiftJaccard <= 0.24 &&
      currentOnRaw <= 0.22 &&
      nextOnRaw >= 0.32;
    if (standaloneTopicShift) return false;
    const standaloneAskWithNewTopic =
      isStrongAskLikeTurn(raw) &&
      countWords(raw) >= 8 &&
      novelTokenCount >= 2 &&
      currentOnRaw <= 0.38 &&
      standaloneShiftJaccard <= 0.34;
    if (standaloneAskWithNewTopic) return false;
    const sharedTopicWhFollowup =
      /^(?:what|when|where|which|how|why|who)\b/i.test(raw) &&
      countWords(raw) <= 14 &&
      (standaloneShiftOverlap >= 0.28 || standaloneShiftJaccard >= 0.22);
    if (sharedTopicWhFollowup) return true;
    if (!rawHasReference) return false;

    const shortWhFollowup =
      countWords(raw) <= 14 &&
      /^(?:and\s+)?(?:what|when|where|which|how|why|who)\b/i.test(raw);
    if (shortWhFollowup) return true;

    const overlap = questionSemanticOverlap(currentText, next);
    const jaccard = tokenSetJaccard(currentText, next);
    return overlap >= 0.28 || jaccard >= 0.24;
  }

  _shouldPromoteRefineToNewQuestion({ entry, canonicalQuestion, confidence }) {
    const q = this._currentQuestion;
    if (!q) return false;
    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    if (!entry || semanticSpeaker !== "Interviewer") return false;
    const raw =
      normalizeInterviewerEntryPrompt(entry, { allowStandaloneProbe: true });
    if (!raw || !isQuestionLikeBoundaryText(raw)) return false;
    if (isConversationManagementTurn(raw)) return false;
    if (countWords(raw) < 5) return false;
    if (isLikelyShortFollowupSubquestion(raw)) return false;
    if (isLikelyAttachedFollowupSubquestion(raw)) return false;
    if (
      hasFollowupReferencePronoun(raw) &&
      countWords(raw) <= 8 &&
      /^(?:and\s+)?(?:what|when|where|which|how|why|who)\b/i.test(raw)
    ) {
      return false;
    }

    const currentQuestion = normalizeOneLine(q.canonicalQuestion || q.rawText);
    const nextCanonical = normalizeOneLine(canonicalQuestion);
    const nextQuestion = normalizeOneLine(raw || nextCanonical);
    if (!currentQuestion || !nextQuestion) return false;
    if (countWords(nextQuestion) < 5) return false;
    if (
      (!nextCanonical || countWords(nextCanonical) < 4) &&
      typeof confidence === "number" &&
      confidence <= 0.15 &&
      countWords(currentQuestion) <= 8
    ) {
      return false;
    }

    if (isSelfIntroductionExpansion(currentQuestion, raw)) return false;

    const rawShiftOverlap = questionSemanticOverlap(currentQuestion, raw);
    const rawShiftJaccard = tokenSetJaccard(currentQuestion, raw);
    const rawShiftCoverage = questionCoverageScore(currentQuestion, raw);
    const currentTokens = tokenSet(currentQuestion);
    const rawTokens = tokenSet(raw);
    let novelTokenCount = 0;
    let sharedTokenCount = 0;
    for (const token of rawTokens) {
      if (currentTokens.has(token)) sharedTokenCount += 1;
      if (!currentTokens.has(token)) novelTokenCount += 1;
    }
    const rawStrongStandaloneShift =
      countWords(raw) >= 6 &&
      rawShiftOverlap <= 0.16 &&
      rawShiftJaccard <= 0.22 &&
      rawShiftCoverage <= 0.18;
    const rawLooksStandaloneAsk =
      raw.includes("?") ||
      /^(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where)\b/i.test(
        raw,
      );
    const lowConfidenceStandaloneAskShift =
      rawLooksStandaloneAsk &&
      (typeof confidence !== "number" || confidence <= 0.62) &&
      countWords(raw) >= 5 &&
      rawShiftOverlap <= 0.24 &&
      rawShiftJaccard <= 0.3 &&
      rawShiftCoverage <= 0.24 &&
      rawTokens.size >= 2 &&
      novelTokenCount >= 2 &&
      sharedTokenCount === 0;
    if (lowConfidenceStandaloneAskShift) {
      return true;
    }
    if (
      rawStrongStandaloneShift &&
      rawLooksStandaloneAsk &&
      rawTokens.size >= 2 &&
      novelTokenCount >= 2 &&
      sharedTokenCount === 0
    ) {
      return true;
    }

    if (nextCanonical) {
      const canonicalOverlap = questionSemanticOverlap(currentQuestion, nextCanonical);
      const canonicalJaccard = tokenSetJaccard(currentQuestion, nextCanonical);
      const currentRetainedInCanonical = questionCoverageScore(currentQuestion, nextCanonical);
      if (
        (canonicalOverlap >= 0.24 ||
          canonicalJaccard >= 0.2 ||
          currentRetainedInCanonical >= 0.36) &&
        !rawStrongStandaloneShift
      ) {
        // Refine safety: if the model canonical still overlaps the current ask,
        // treat this as same-question expansion rather than a topic shift.
        return false;
      }
    }

    const overlap = questionSemanticOverlap(currentQuestion, nextQuestion);
    const currentOnRaw = questionCoverageScore(currentQuestion, raw);
    const nextOnRaw = questionCoverageScore(nextQuestion, raw);
    const jaccard = tokenSetJaccard(currentQuestion, nextQuestion);

    const strongTopicShift =
      overlap <= 0.16 &&
      jaccard <= 0.22 &&
      currentOnRaw <= 0.16 &&
      nextOnRaw >= 0.3 &&
      sharedTokenCount === 0;
    if (!strongTopicShift) return false;

    // Respect high-confidence model promotions directly.
    if (typeof confidence === "number" && confidence >= 0.78) return true;

    // For low-confidence refine results, still promote when the interviewer turn is a
    // stand-alone ask that clearly shifts topic from the current question.
    if (raw.includes("?") && countWords(raw) >= 5) return true;
    return /^(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where)\b/i.test(
      raw,
    );
  }

  _shouldPromoteRefineToNewQuestionAfterReady({ entry, canonicalQuestion, confidence }) {
    const q = this._currentQuestion;
    if (!q) return false;
    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    if (!entry || semanticSpeaker !== "Interviewer") return false;

    const incomingTurnAtMs =
      typeof entry.start === "number"
        ? entry.start
        : typeof entry.end === "number"
          ? entry.end
          : null;
    const priorTurnAtMs =
      typeof q.lastInterviewerTurnAtMs === "number" ? q.lastInterviewerTurnAtMs : null;
    const sourceGapMs =
      Number.isFinite(incomingTurnAtMs) && Number.isFinite(priorTurnAtMs)
        ? Math.max(0, incomingTurnAtMs - priorTurnAtMs)
        : null;

    const raw = normalizeInterviewerEntryPrompt(entry);
    if (!raw || !isQuestionLikeBoundaryText(raw)) return false;
    if (isConversationManagementTurn(raw)) return false;
    if (
      entry &&
      typeof entry.source === "string" &&
      /\bmic\b/i.test(entry.source) &&
      !isStrongUserReadAloudPromptTurn(entry.text || semanticText || raw)
    ) {
      return false;
    }
    if (countWords(raw) < 6) return false;

    const readyCount = this._readyCountByQuestionId.get(q.id) || 0;
    if (readyCount <= 0) return false;

    const now = this._now();
    const lastReadyAt =
      typeof q.coachQuestionUpdatedAt === "number"
        ? q.coachQuestionUpdatedAt
        : typeof q.lastUpdatedAt === "number"
          ? q.lastUpdatedAt
          : typeof q.createdAt === "number"
            ? q.createdAt
            : now;
    const idleAfterReadyMs = Math.max(0, now - lastReadyAt);
    const answered =
      typeof q.answerStartedAt === "number" &&
      typeof q.createdAt === "number" &&
      q.answerStartedAt >= q.createdAt;
    const longIdle =
      idleAfterReadyMs >= 14000 ||
      (Number.isFinite(sourceGapMs) && sourceGapMs >= 12000);
    if (!answered && !longIdle) return false;

    // Timing alone is not enough. Require the same semantic topic-shift evidence we use for
    // ordinary refine->new promotions so answer follow-ups stay attached to the current ask.
    return this._shouldPromoteRefineToNewQuestion({
      entry,
      canonicalQuestion,
      confidence,
    });
  }

  _shouldForceStandaloneRefineSplit({ rawQuestion, canonicalQuestion, confidence }) {
    const q = this._currentQuestion;
    if (!q) return false;

    const raw = normalizeInterviewerPromptTurn(rawQuestion) || normalizeOneLine(rawQuestion);
    if (!raw || !isQuestionLikeBoundaryText(raw)) return false;
    if (isConversationManagementTurn(raw) || isLikelyIncompleteQuestionFragment(raw)) return false;
    if (countWords(raw) < 5) return false;
    if (isLikelyShortFollowupSubquestion(raw) || isLikelyAttachedFollowupSubquestion(raw)) {
      return false;
    }
    if (hasFollowupReferencePronoun(raw) && countWords(raw) <= 12) return false;

    const currentQuestion = normalizeOneLine(q.canonicalQuestion || q.rawText);
    const nextQuestion = normalizeOneLine(canonicalQuestion || raw);
    if (!currentQuestion || !nextQuestion) return false;
    if (isSelfIntroductionExpansion(currentQuestion, raw)) return false;

    const rawLooksStandaloneAsk =
      raw.includes("?") ||
      /^(?:and\s+)?(?:tell me|describe|explain|walk me through|share|give (?:me )?(?:an )?example|what|why|how|who|which|when|where)\b/i.test(
        raw,
      );
    if (!rawLooksStandaloneAsk) return false;

    const overlap = questionSemanticOverlap(currentQuestion, raw);
    const jaccard = tokenSetJaccard(currentQuestion, raw);
    const currentOnRaw = questionCoverageScore(currentQuestion, raw);
    const currentTokens = tokenSet(currentQuestion);
    const rawTokens = tokenSet(raw);
    let novelTokenCount = 0;
    let sharedTokenCount = 0;
    for (const token of rawTokens) {
      if (currentTokens.has(token)) sharedTokenCount += 1;
      if (!currentTokens.has(token)) novelTokenCount += 1;
    }
    if (rawTokens.size < 2 || novelTokenCount < 2) return false;
    if (
      (!canonicalQuestion || countWords(canonicalQuestion) < 4) &&
      (typeof confidence !== "number" || confidence <= 0.15) &&
      countWords(currentQuestion) <= 8
    ) {
      return false;
    }

    const clearStandaloneShift =
      overlap <= 0.22 &&
      jaccard <= 0.28 &&
      currentOnRaw <= 0.24 &&
      sharedTokenCount === 0;
    if (clearStandaloneShift) return true;

    const lowConfidenceStandaloneShift =
      (typeof confidence !== "number" || confidence <= 0.65) &&
      overlap <= 0.3 &&
      jaccard <= 0.36 &&
      currentOnRaw <= 0.32 &&
      novelTokenCount >= 3 &&
      sharedTokenCount === 0;
    return lowConfidenceStandaloneShift;
  }

  _startNewQuestion({ entry, canonicalQuestion, questionType, confidence, reason }) {
    if (!entry || typeof entry.text !== "string") return;

    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    const rawOriginal = entry.text.trim();
    if (!rawOriginal) return;
    const interviewerNormalizedRaw =
      semanticSpeaker === "Interviewer"
        ? normalizeInterviewerEntryPrompt(entry)
        : "";
    const userNormalizedRaw =
      entry.speaker === "User" ? normalizeQuotedUserPromptTurn(rawOriginal) : "";
    const raw = semanticSpeaker === "Interviewer" ? interviewerNormalizedRaw : userNormalizedRaw || rawOriginal;
    if (!raw) return;
    const canonicalSanitized = sanitizeCanonicalQuestion(canonicalQuestion || "");
    const canonicalForState =
      semanticSpeaker === "Interviewer" &&
      canonicalSanitized &&
      !isAskLikeSummaryText(canonicalSanitized)
        ? ""
        : canonicalSanitized;

    if (entry.speaker === "User" && semanticSpeaker !== "Interviewer" && !userNormalizedRaw) {
      if (this._debug) {
        console.log("[LiveCoach] Dropping start_new_question for non-quoted user turn");
      }
      return;
    }

    if (semanticSpeaker === "Interviewer") {
      const rawQuestionish = isQuestionLikeBoundaryText(raw);
      const canonicalQuestionish = isQuestionLikeBoundaryText(canonicalForState || "");
      const incompleteFragment = isLikelyIncompleteQuestionFragment(raw);
      const conversationMgmt =
        isConversationManagementTurn(rawOriginal) || isConversationManagementTurn(raw);
      const setupOnly =
        isLikelyInterviewerPreamble(rawOriginal) &&
        !rawOriginal.includes("?") &&
        !hasEmbeddedAskDirective(rawOriginal);
      const dropReasons = [];
      if (!rawQuestionish && !canonicalQuestionish) dropReasons.push("not_question_like");
      if (setupOnly) dropReasons.push("setup_only");
      if (incompleteFragment) dropReasons.push("incomplete_fragment");
      if (conversationMgmt) dropReasons.push("conversation_mgmt");
      if (
        (!rawQuestionish && !canonicalQuestionish) ||
        setupOnly ||
        incompleteFragment ||
        conversationMgmt
      ) {
        if (this._debug) {
          console.log(
            `[LiveCoach] Dropping start_new_question (${dropReasons.join(",") || "filtered"}) raw="${safeTrim(
              rawOriginal || raw,
              140,
            )}" canonical="${safeTrim(canonicalForState || "", 140)}"`,
          );
        }
        return;
      }
    }

    const cleanedRaw = cleanQuestionSurface(raw);
    const rawForState =
      canonicalForState &&
      (isLikelyIncompleteQuestionFragment(raw) ||
        !isAskLikeSummaryText(raw) ||
        questionCoverageScore(raw, canonicalForState) <= 0.16 ||
        (!!cleanedRaw &&
          normalizeText(cleanedRaw) === normalizeText(canonicalForState) &&
          normalizeText(raw) !== normalizeText(cleanedRaw)))
        ? canonicalForState
        : raw;
    const normalized = normalizeText(raw);
    const normalizedState = normalizeText(rawForState);
    const now = this._now();

    if (this._currentQuestion && this._currentQuestion.id) {
      // Advancing to a different question should discard any pending failure warning for
      // the previous one. Surfacing it here produces false "Generation failed" logs even
      // when the user has already moved on.
      this._clearPendingGenerationFailure(this._currentQuestion.id);
    }
    this._abortStaleCardsRequests();
    this._queuedCardsByQuestionId = new Map();

    const q = {
      id: `q${++this._questionSeq}`,
      rawParts: [rawForState],
      rawPartsSeen: new Set([normalizedState, normalized].filter(Boolean)),
      rawText: rawForState,
      canonicalQuestion: canonicalForState,
      questionType: questionType || "",
      confidence,
      createdAt: now,
      lastUpdatedAt: now,
      phase: "active",
      promptSource: semanticSpeaker === "Interviewer" ? "Interviewer" : "User",
      anchorStartMs: typeof entry.start === "number" ? entry.start : null,
      anchorEndMs: typeof entry.end === "number" ? entry.end : null,
      anchorAtMs: typeof entry.at === "number" ? entry.at : null,
      contextStartedAt: typeof entry.at === "number" ? entry.at : now,
      lastInterviewerTurnAtMs:
        semanticSpeaker === "Interviewer" &&
        typeof entry.end === "number"
          ? entry.end
          : semanticSpeaker === "Interviewer" && typeof entry.start === "number"
            ? entry.start
            : null,
      answerStartedAt: null,
      coachQuestion: "",
      coachQuestionUpdatedAt: null,
      coachConfidence: null,
      reason: reason || "intent_model",
    };

    this._currentQuestion = q;

    console.log(
      `[LiveCoach] Confirmed question (${q.id}, reason=${q.reason}${
        typeof confidence === "number" ? `, conf=${confidence.toFixed(2)}` : ""
      }): ${q.rawText.length > 140 ? `${q.rawText.slice(0, 140)}…` : q.rawText}`,
    );

    this._sendIpc("live-coach-update", {
      status: "generating",
      rawQuestion: q.canonicalQuestion || q.rawText,
      questionId: q.id,
      confidence,
    });

    this._scheduleCardsGeneration({ question: q, reason: "start_new" });
  }

  _refineCurrentQuestion({ entry, canonicalQuestion, questionType, confidence, reason }) {
    const q = this._currentQuestion;
    if (!q) {
      this._startNewQuestion({ entry, canonicalQuestion, questionType, confidence, reason });
      return;
    }

    const semanticSpeaker = getLiveCoachSemanticSpeaker(entry);
    const semanticText = getLiveCoachSemanticText(entry);
    const rawOriginal = typeof entry?.text === "string" ? entry.text.trim() : "";
    let raw =
      semanticSpeaker === "Interviewer"
        ? normalizeInterviewerEntryPrompt(entry, { allowStandaloneProbe: true })
        : rawOriginal;
    if (
      semanticSpeaker === "Interviewer" &&
      !raw &&
      shouldConsiderInterviewerFragmentForIntent(rawOriginal)
    ) {
      raw = normalizeOneLine(stripInterviewerLeadIn(rawOriginal) || rawOriginal);
    }
    const vagueHandleFollowup =
      semanticSpeaker === "Interviewer" &&
      (isLikelyVagueHandleFollowup(rawOriginal) ||
        isLikelyVagueHandleFollowup(raw) ||
        isLikelyVagueHandleFollowup(canonicalQuestion));
    const cq = canonicalQuestion || "";
    const canonicalizedVagueHandleFollowup =
      vagueHandleFollowup &&
      cq &&
      isUsefulCanonicalizedVagueHandleFollowup({
        currentQuestion: q.canonicalQuestion || q.rawText,
        canonicalQuestion: cq,
      });
    if (semanticSpeaker === "Interviewer" && raw) {
      const allowRawAppend =
        !vagueHandleFollowup &&
        (isStrongAskLikeTurn(raw) ||
          isLikelyAttachedFollowupSubquestion(raw) ||
          isLikelyShortFollowupSubquestion(raw) ||
          shouldConsiderInterviewerFragmentForIntent(rawOriginal));
      if (!allowRawAppend || isConversationManagementTurn(rawOriginal) || isConversationManagementTurn(raw)) {
        raw = "";
      }
    }
    let didAppendRaw = false;
    if (raw) {
      const norm = normalizeText(raw);
      if (norm && !q.rawPartsSeen.has(norm)) {
        q.rawPartsSeen.add(norm);
        q.rawParts.push(raw);
        didAppendRaw = true;
        // Hard cap to avoid accidentally capturing large transcript swaths.
        while (q.rawParts.length > 8) q.rawParts.shift();
        q.rawText = q.rawParts.join(" ").trim();
        if (q.rawText.length > 2200) {
          q.rawText = q.rawText.slice(0, 2199) + "…";
        }
      }
    }

    let didUpdateCanonical = false;
    let canonicalRejected = false;
    if (cq && (!vagueHandleFollowup || canonicalizedVagueHandleFollowup)) {
      if (semanticSpeaker === "Interviewer" && !isAskLikeSummaryText(cq)) {
        canonicalRejected = true;
      }
      const currentCanonical = q.canonicalQuestion || q.rawText;
      const rawTextForCanonical =
        canonicalizedVagueHandleFollowup && currentCanonical
          ? `${currentCanonical}? ${cq}?`
          : q.rawText;
      if (
        !canonicalRejected &&
        (canonicalizedVagueHandleFollowup ||
          !shouldRejectCanonicalRefineRegression({
            currentCanonical,
            nextCanonical: cq,
            rawText: q.rawText,
          }))
      ) {
        q.canonicalQuestion = combineRefineCanonical({
          currentCanonical,
          nextCanonical: cq,
          rawText: rawTextForCanonical,
        });
        didUpdateCanonical = true;
      } else {
        const merged = mergeCanonicalWithShortFollowup({
          currentCanonical,
          followupRawTurn: raw,
        });
        if (merged) {
          q.canonicalQuestion = merged;
          didUpdateCanonical = true;
        } else if (this._debug) {
          canonicalRejected = true;
          console.log(
            `[LiveCoach] Kept broader canonical for ${q.id}; dropped refine "${safeTrim(cq, 120)}"`,
          );
        } else {
          canonicalRejected = true;
        }
      }
    } else if (cq && vagueHandleFollowup) {
      canonicalRejected = true;
    }
    const previousType = q.questionType || "";
    if (questionType) q.questionType = questionType;
    const questionTypeChanged = (q.questionType || "") !== previousType;
    const previousConfidence = typeof q.confidence === "number" ? q.confidence : null;
    if (typeof confidence === "number") q.confidence = confidence;
    if (semanticSpeaker === "Interviewer") {
      q.lastInterviewerTurnAtMs =
        typeof entry.end === "number"
          ? entry.end
          : typeof entry.start === "number"
            ? entry.start
            : q.lastInterviewerTurnAtMs;
    }
    q.lastUpdatedAt = this._now();
    q.reason = reason || q.reason;

    const confidenceJump =
      typeof confidence === "number" &&
      (previousConfidence === null || confidence > previousConfidence + 0.15);

    if (canonicalRejected && raw) {
      const readyCount = this._readyCountByQuestionId.get(q.id) || 0;
      const currentCanonical = normalizeOneLine(q.canonicalQuestion || q.rawText);
      const rawQuestion = normalizeOneLine(raw);
      const rawOverlap = questionSemanticOverlap(currentCanonical, rawQuestion);
      const rawJaccard = tokenSetJaccard(currentCanonical, rawQuestion);
      const shouldPromoteRejectedRefine =
        readyCount === 0 &&
        rawQuestion.includes("?") &&
        countWords(rawQuestion) >= 8 &&
        !isLikelyAttachedFollowupSubquestion(rawQuestion) &&
        rawOverlap <= 0.16 &&
        rawJaccard <= 0.2;
      if (shouldPromoteRejectedRefine) {
        if (this._debug) {
          console.log(
            `[LiveCoach] Promoting rejected refine to start_new_question for ${q.id}`,
          );
        }
        this._startNewQuestion({
          entry,
          canonicalQuestion: sanitizeCanonicalQuestion(rawQuestion) || canonicalQuestion,
          questionType,
          confidence,
          reason: `${reason || q.reason}_rejected_promoted`,
        });
        return;
      }
    }
    if (
      canonicalRejected &&
      !didUpdateCanonical &&
      !didAppendRaw &&
      !questionTypeChanged &&
      !confidenceJump
    ) {
      // Stability guard: when a refine is rejected as semantically narrower, avoid forcing
      // a cards regen for the same question. This prevents churn and transient empty errors.
      return;
    }
    if (!didUpdateCanonical && !didAppendRaw && !questionTypeChanged && !confidenceJump) return;

    this._scheduleCardsGeneration({ question: q, reason: "refine" });
  }

  _clearPendingGenerationFailure(questionId) {
    if (!questionId || !(this._pendingFailureTimersByQuestionId instanceof Map)) return;
    const timer = this._pendingFailureTimersByQuestionId.get(questionId);
    if (timer) {
      try {
        clearTimeout(timer);
      } catch (_) {}
    }
    this._pendingFailureTimersByQuestionId.delete(questionId);
    if (this._pendingFailureMetaByQuestionId instanceof Map) {
      this._pendingFailureMetaByQuestionId.delete(questionId);
    }
  }

  _flushPendingGenerationFailure(questionId) {
    if (!questionId || !(this._pendingFailureMetaByQuestionId instanceof Map)) return;
    const pending = this._pendingFailureMetaByQuestionId.get(questionId);
    if (!pending || typeof pending.message !== "string" || !pending.message) {
      this._clearPendingGenerationFailure(questionId);
      return;
    }
    this._clearPendingGenerationFailure(questionId);
    if (!this._active || !this._enabled || this._paused) return;
    if ((this._readyCountByQuestionId.get(questionId) || 0) > 0) return;
    if (this._currentQuestion && this._currentQuestion.id !== questionId) return;
    const stillQueued = this._queuedCardsByQuestionId.has(questionId);
    const stillInFlight = this._cardsInFlightByQuestionId.has(questionId);
    if (stillQueued || stillInFlight) return;
    console.warn(
      `[LiveCoach] Generation failed for ${questionId}: ${pending.message}`,
    );
  }

  _scheduleGenerationFailureWarning({ questionId, message }) {
    if (!questionId) return;
    this._clearPendingGenerationFailure(questionId);
    const scheduledAttemptCount =
      this._generationAttemptByQuestionId.get(questionId)?.count || 0;
    const timer = setTimeout(() => {
      this._pendingFailureTimersByQuestionId.delete(questionId);
      if (!this._active || !this._enabled || this._paused) return;
      if ((this._readyCountByQuestionId.get(questionId) || 0) > 0) return;
      const latestAttemptCount =
        this._generationAttemptByQuestionId.get(questionId)?.count || 0;
      if (latestAttemptCount > scheduledAttemptCount) return;
      this._flushPendingGenerationFailure(questionId);
    }, 30000);
    if (this._pendingFailureMetaByQuestionId instanceof Map) {
      this._pendingFailureMetaByQuestionId.set(questionId, {
        message,
        scheduledAttemptCount,
      });
    }
    this._pendingFailureTimersByQuestionId.set(questionId, timer);
  }

  _scheduleCardsGeneration({ question, reason }) {
    if (!question || !this._active || !this._enabled || this._paused) return;

    const now = this._now();
    const qid = question.id;
    const attempts = this._generationAttemptByQuestionId.get(qid) || { count: 0, lastAt: 0 };
    const questionType = question.questionType || "";
    const isTechnicalQuestion =
      questionType === "coding" || questionType === "system_design";
    const readyCount = this._readyCountByQuestionId.get(qid) || 0;
    const isPostReadyRefine = reason === "refine" && readyCount > 0;
    const inFlightAgeMs = now - (attempts.lastAt || 0);
    const shouldPreemptRefine =
      readyCount === 0 && Number.isFinite(inFlightAgeMs) && inFlightAgeMs >= 1200;

    if (
      isPostReadyRefine &&
      this._cardsInFlightByQuestionId.has(qid)
    ) {
      if (this._debug) {
        console.log(
          `[LiveCoach] Preempting in-flight cards for ${qid} (post-ready refine)`,
        );
      }
      this._queuedCardsByQuestionId.set(qid, {
        at: now,
        questionId: qid,
        requestSeq: this._cardsRequestSeq + 1,
      });
      this._abortCardsRequest(qid);
      return;
    }

    if (
      reason === "refine" &&
      !isTechnicalQuestion &&
      shouldPreemptRefine &&
      this._cardsInFlightByQuestionId.has(qid)
    ) {
      this._queuedCardsByQuestionId.set(qid, {
        at: now,
        questionId: qid,
        requestSeq: this._cardsRequestSeq + 1,
      });
      this._abortCardsRequest(qid);
      return;
    }

    if (this._cardsDebounceTimer) clearTimeout(this._cardsDebounceTimer);

    // Keep first-pass multipart collapse conservative, but refresh faster once cards are already
    // on screen and the interviewer appends the rest of the same ask.
    const debounceMs =
      reason === "start_new" ? 80 : isPostReadyRefine ? 120 : 260;

    // Rate-limit: if we just called cards for this question very recently, wait a bit longer.
    const minGapMs = isPostReadyRefine ? 220 : 450;
    const sinceLast = now - (attempts.lastAt || 0);
    const extraDelay = sinceLast < minGapMs ? minGapMs - sinceLast : 0;
    const scheduledDelayMs = Math.max(0, debounceMs + extraDelay);

    if (this._debug && isPostReadyRefine) {
      console.log(
        `[LiveCoach] Scheduling post-ready refine for ${qid} in ${scheduledDelayMs}ms (sinceLast=${Math.max(
          0,
          Math.round(sinceLast),
        )}ms, inFlight=${this._cardsInFlightByQuestionId.has(qid) ? "yes" : "no"})`,
      );
    }

    this._cardsDebounceTimer = setTimeout(() => {
      this._cardsDebounceTimer = null;
      if (!this._enabled || !this._active || this._paused) return;
      if (!this._currentQuestion || this._currentQuestion.id !== qid) return;
      if (
        reason === "refine" &&
        (this._intentInFlight ||
          (Array.isArray(this._intentQueued) && this._intentQueued.length > 0))
      ) {
        // Let pending intent refinements settle before generating cards.
        this._cardsDebounceTimer = setTimeout(() => {
          this._cardsDebounceTimer = null;
          if (!this._enabled || !this._active || this._paused) return;
          if (!this._currentQuestion || this._currentQuestion.id !== qid) return;
          this._triggerGeneration(this._currentQuestion);
        }, 120);
        return;
      }
      this._triggerGeneration(this._currentQuestion);
    }, scheduledDelayMs);
  }

  _abortCardsRequest(questionId) {
    const controller =
      this._cardsAbortControllerByQuestionId instanceof Map
        ? this._cardsAbortControllerByQuestionId.get(questionId)
        : null;
    if (!controller) return false;
    try {
      controller.abort();
      return true;
    } catch (_) {
      return false;
    }
  }

  _abortStaleCardsRequests({ keepQuestionId = "" } = {}) {
    if (!(this._cardsAbortControllerByQuestionId instanceof Map)) return;
    for (const [questionId, controller] of this._cardsAbortControllerByQuestionId.entries()) {
      if (keepQuestionId && questionId === keepQuestionId) continue;
      try {
        controller.abort();
      } catch (_) {}
    }
  }

  _recentTurnsForQuestion(question) {
    if (!question || !Array.isArray(this._fullTranscript) || this._fullTranscript.length === 0) {
      return this._recentTurns.slice();
    }
    const cutoffAt =
      typeof question.contextStartedAt === "number"
        ? question.contextStartedAt
        : typeof question.createdAt === "number"
          ? question.createdAt
          : 0;
    const filtered = this._fullTranscript
      .filter((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const at = typeof entry.at === "number" ? entry.at : 0;
        return !cutoffAt || at >= cutoffAt;
      })
      .map((entry) => ({
        speaker: getLiveCoachSemanticSpeaker(entry) || entry.speaker,
        text: getLiveCoachSemanticText(entry) || entry.text,
      }))
      .filter((entry) => entry.speaker && entry.text)
      .slice(-10);
    return filtered.length > 0 ? filtered : this._recentTurns.slice();
  }

  async _triggerGeneration(question) {
    if (!question) return;
    if (this._paused) return;
    if (this._unsupportedAnswerLanguage) return;
    const qid = question.id;
    if (this._cardsInFlightByQuestionId.has(qid)) {
      this._queuedCardsByQuestionId.set(qid, {
        at: this._now(),
        questionId: qid,
        requestSeq: this._cardsRequestSeq + 1,
      });
      return;
    }
    this._cardsInFlightByQuestionId.add(qid);

    const requestSeq = ++this._cardsRequestSeq;
    question._lastCardsRequestSeq = requestSeq;
    const abortController =
      typeof AbortController === "function" ? new AbortController() : null;
    if (abortController) {
      this._cardsAbortControllerByQuestionId.set(qid, abortController);
    }

    const startedAt = this._now();
    const attemptInfo = this._generationAttemptByQuestionId.get(qid) || { count: 0, lastAt: 0 };
    attemptInfo.count = (attemptInfo.count || 0) + 1;
    attemptInfo.lastAt = startedAt;
    this._generationAttemptByQuestionId.set(qid, attemptInfo);

    try {
      console.log(`[LiveCoach] Generating cards for ${qid}...`);
      const promptQuestionText = normalizeOneLine(
        question.canonicalQuestion || question.rawText,
      );

      const result = await this._generateCards({
        questionText: promptQuestionText || question.rawText,
        canonicalQuestion: question.canonicalQuestion,
        questionType: question.questionType || "",
        recentTurns: this._recentTurnsForQuestion(question),
        brief: this._brief,
        answerLanguage: this._answerLanguage,
        signal: abortController ? abortController.signal : undefined,
      });

      if (!this._active || !this._enabled || this._paused) return;
      if (!this._currentQuestion || this._currentQuestion.id !== qid) return;
      if (this._currentQuestion._lastCardsRequestSeq !== requestSeq) {
        // Stale cards response (question refined again while request in-flight).
        return;
      }

      const outline = Array.isArray(result?.outline) ? result.outline : [];
      const dontMiss = Array.isArray(result?.dontMiss) ? result.dontMiss : [];
      const resultQuestion =
        typeof result?.question === "string" ? result.question.trim() : "";
      let payloadQuestionChoice = chooseStablePayloadQuestion({
        modelQuestion: resultQuestion,
        canonicalQuestion: question.canonicalQuestion,
        rawQuestion: question.rawText,
      });

      const payload = {
        status: "ready",
        questionId: qid,
        rawQuestion: promptQuestionText || question.rawText,
        question:
          payloadQuestionChoice.question ||
          question.canonicalQuestion ||
          question.rawText,
        firstSentence:
          typeof result?.firstSentence === "string" ? result.firstSentence.trim() : "",
        firstSentenceIsFallback: false,
        outline,
        dontMiss,
        questionType:
          (typeof result?.questionType === "string" && result.questionType) ||
          question.questionType ||
          "",
        confidence:
          typeof question.confidence === "number"
            ? question.confidence
            : typeof result?.confidence === "number"
              ? result.confidence
              : null,
        cardsSource:
          typeof result?.debug?.source === "string" ? result.debug.source : "",
        cardsFinishReason:
          typeof result?.debug?.finishReason === "string"
            ? result.debug.finishReason
            : "",
        cardsProvider:
          typeof result?.debug?.provider === "string" ? result.debug.provider : "",
        cardsSalvaged:
          typeof result?.debug?.salvaged === "string" ? result.debug.salvaged : "",
        cardsFallbackReason:
          typeof result?.cardsFallbackReason === "string" && result.cardsFallbackReason
            ? result.cardsFallbackReason
            : typeof result?.debug?.fallbackReason === "string"
              ? result.debug.fallbackReason
              : "",
        cardsWinner:
          typeof result?.debug?.winner === "string" ? result.debug.winner : "",
        cardsLatencyMs:
          typeof result?.debug?.latencyMs === "string" ? result.debug.latencyMs : "",
        cardsTotalLatencyMs:
          typeof result?.debug?.totalLatencyMs === "string"
            ? result.debug.totalLatencyMs
            : "",
        cardsAreFallback: result?.cardsAreFallback === true,
        updatedAt: this._now(),
      };

      if (looksMultipartQuestionText(payload.rawQuestion || "")) {
        const multipartQuestion = buildMultipartQuestionFromRaw(payload.rawQuestion || "");
        if (multipartQuestion) {
          const payloadCoverage = questionCoverageScore(
            payload.question || "",
            payload.rawQuestion || "",
          );
          const multipartCoverage = questionCoverageScore(
            multipartQuestion,
            payload.rawQuestion || "",
          );
          const payloadWords = countWords(payload.question || "");
          const multipartWords = countWords(multipartQuestion);
          const shouldUseMultipartQuestion =
            multipartWords <= 36 &&
            multipartCoverage >= Math.max(0.52, payloadCoverage + 0.14) &&
            (payloadWords <= 12 || multipartCoverage >= payloadCoverage + 0.2);
          if (shouldUseMultipartQuestion) {
            payload.question = multipartQuestion;
            payloadQuestionChoice = {
              question: multipartQuestion,
              source: "raw_multipart_retention",
              temporary: true,
            };
          }
        }
      }
      payload.question = cleanQuestionSurface(payload.question || "");

      const lastReady = this._lastReadyByQuestionId.get(qid);
      const previousWasTemporary = !!lastReady?.temporaryQuestion;
      if (lastReady && lastReady.question && !previousWasTemporary) {
        payload.question = stabilizeQuestionText({
          previousQuestion: lastReady.question,
          nextQuestion: payload.question,
          rawQuestion: payload.rawQuestion,
        });
      }
      if (
        lastReady &&
        !previousWasTemporary &&
        shouldDropQuestionRegression({
          previousQuestion: lastReady.question,
          previousRawQuestion: lastReady.rawQuestion,
          nextQuestion: payload.question,
          nextRawQuestion: payload.rawQuestion,
        })
      ) {
        if (this._debug) {
          console.log(
            `[LiveCoach] Skipped question regression for ${qid}: "${safeTrim(payload.question, 120)}"`,
          );
        }
        return;
      }

      if (
        shouldSkipNonImprovingReadyUpdate({
          previousReady: lastReady,
          nextReady: {
            question: payload.question || "",
            rawQuestion: payload.rawQuestion || "",
            outline: Array.isArray(payload.outline) ? payload.outline : [],
            dontMiss: Array.isArray(payload.dontMiss) ? payload.dontMiss : [],
            firstSentence: payload.firstSentence || "",
            temporaryQuestion: !!payloadQuestionChoice.temporary,
          },
        })
      ) {
        if (this._debug) {
          console.log(
            `[LiveCoach] Skipped non-improving ready update for ${qid}`,
          );
        }
        return;
      }

      const rawTokenCount = tokenSet(payload.rawQuestion || "").size;
      const relevanceToRaw =
        rawTokenCount > 0 ? questionCoverageScore(payload.question, payload.rawQuestion) : 1;
      if (rawTokenCount >= 3 && relevanceToRaw < 0.22) {
        const attemptCount = this._generationAttemptByQuestionId.get(qid)?.count || 1;
        const fallbackChoice = chooseStablePayloadQuestion({
          modelQuestion: "",
          canonicalQuestion: question.canonicalQuestion,
          rawQuestion: question.rawText,
        });
        const fallbackQuestion = normalizeOneLine(fallbackChoice?.question || "");
        const fallbackRelevance =
          fallbackQuestion && payload.rawQuestion
            ? questionCoverageScore(fallbackQuestion, payload.rawQuestion)
            : 0;
        const shouldAcceptFallbackQuestion =
          !!fallbackQuestion &&
          (isAskLikeSummaryText(fallbackQuestion) ||
            fallbackRelevance >= 0.14 ||
            attemptCount >= 2);
        if (shouldAcceptFallbackQuestion) {
          if (this._debug) {
            console.log(
              `[LiveCoach] Replacing off-topic question for ${qid} with ${fallbackChoice.source || "fallback"} (coverage=${fallbackRelevance.toFixed(
                2,
              )}, attempt=${attemptCount})`,
            );
          }
          payload.question = fallbackQuestion;
          payloadQuestionChoice = {
            question: fallbackQuestion,
            source: fallbackChoice.source || "off_topic_fallback",
            temporary: true,
          };
        } else {
          if (this._debug) {
            console.log(
              `[LiveCoach] Rejected off-topic question for ${qid} (coverage=${relevanceToRaw.toFixed(
                2,
              )}, attempt=${attemptCount})`,
            );
          }
          if (attemptCount < 2) {
            setTimeout(() => {
              if (!this._active || !this._enabled || this._paused) return;
              if (!this._currentQuestion || this._currentQuestion.id !== qid) return;
              this._triggerGeneration(this._currentQuestion);
            }, 500);
          }
          return;
        }
      }
      // Persist distilled question + confidence for downstream uses.
      if (payload.question) {
        this._currentQuestion.coachQuestion = payload.question;
        this._currentQuestion.coachQuestionUpdatedAt = payload.updatedAt;
      }
      if (typeof payload.confidence === "number") {
        this._currentQuestion.coachConfidence = payload.confidence;
      }
      if (payload.questionType) {
        this._currentQuestion.questionType = payload.questionType;
      }

      const signature = hashSignature({
        questionType: payload.questionType || "",
        question: payload.question || "",
        outline: Array.isArray(payload.outline) ? payload.outline : [],
        dontMiss: Array.isArray(payload.dontMiss) ? payload.dontMiss : [],
      });
      if (
        this._lastReadySignature &&
        this._lastReadySignature.questionId === payload.questionId &&
        this._lastReadySignature.signature === signature
      ) {
        if (this._debug) {
          console.log(
            `[LiveCoach] Skipped UI update for ${payload.questionId} (no material change)`,
          );
        }
        return;
      }
      this._lastReadySignature = { questionId: payload.questionId, signature };
      this._clearPendingGenerationFailure(qid);

      this._sendIpc("live-coach-update", payload);
      this._readyCountByQuestionId.set(qid, (this._readyCountByQuestionId.get(qid) || 0) + 1);
      this._lastReadyByQuestionId.set(qid, {
        question: payload.question || "",
        rawQuestion: payload.rawQuestion || "",
        outline: Array.isArray(payload.outline) ? payload.outline.slice(0, 4) : [],
        dontMiss: Array.isArray(payload.dontMiss) ? payload.dontMiss.slice(0, 2) : [],
        firstSentence:
          typeof payload.firstSentence === "string" ? payload.firstSentence : "",
        temporaryQuestion: !!payloadQuestionChoice.temporary,
      });
    } catch (err) {
      const current = this._currentQuestion;
      const isStaleQuestion = !current || current.id !== qid;
      const isStaleRequest = !!current && current._lastCardsRequestSeq !== requestSeq;
      const aborted = /aborted|aborterror/i.test(err?.message || String(err));
      const immediateMessage = err?.message || String(err);
      const unsupportedLanguage = isLiveCoachUnsupportedLanguageError(immediateMessage);
      if (isStaleQuestion || isStaleRequest) {
        // Expected race: question moved on while request was in-flight.
        return;
      }
      if (aborted && this._queuedCardsByQuestionId.has(qid)) {
        return;
      }
      const pauseAborted =
        aborted &&
        this._pauseAbortedQuestionIds instanceof Set &&
        this._pauseAbortedQuestionIds.has(qid);
      if (pauseAborted) {
        this._pauseAbortedQuestionIds.delete(qid);
        return;
      }
      if (unsupportedLanguage) {
        console.warn(
          `[LiveCoach] Ignoring unsupported-language cards result qId=${qid} question="${safeTrim(
            question?.canonicalQuestion || question?.rawText || "",
            140,
          )}" message="${safeTrim(immediateMessage, 220)}"`,
        );
        this._clearPendingGenerationFailure(qid);
        if ((this._readyCountByQuestionId.get(qid) || 0) <= 0) {
          this._currentQuestion = null;
          this._sendIpc("live-coach-update", { status: "idle" });
        }
        return;
      }

      // Retry a couple times with backoff before emitting an empty "ready" (keeps replay runs from
      // having zero ready events, but avoids templated fallbacks).
      const attempt = this._generationAttemptByQuestionId.get(qid)?.count || 1;
      const hadReady = (this._readyCountByQuestionId.get(qid) || 0) > 0;
      const shouldRetry = hadReady ? false : attempt <= 1;
      console.warn(
        `[LiveCoach] Cards generation issue qId=${qid} attempt=${attempt} hadReady=${
          hadReady ? "yes" : "no"
        } willRetry=${shouldRetry ? "yes" : "no"} aborted=${aborted ? "yes" : "no"} question="${safeTrim(
          question?.canonicalQuestion || question?.rawText || "",
          140,
        )}" message="${safeTrim(immediateMessage, 220)}"`,
      );
      if (shouldRetry && this._active && this._enabled && this._currentQuestion?.id === qid) {
        const delayMs = attempt <= 1 ? 350 : 800;
        setTimeout(() => {
          if (!this._active || !this._enabled || this._paused) return;
          if (!this._currentQuestion || this._currentQuestion.id !== qid) return;
          this._triggerGeneration(this._currentQuestion);
        }, delayMs);
        return;
      }

      if (!this._active || !this._enabled || this._paused) return;
      if (!this._currentQuestion || this._currentQuestion.id !== qid) return;

      if (hadReady) {
        const lastReady = this._lastReadyByQuestionId.get(qid) || null;
        const fallbackChoice = chooseStablePayloadQuestion({
          modelQuestion: "",
          canonicalQuestion: current?.canonicalQuestion || "",
          rawQuestion: current?.rawText || "",
        });
        const fallbackQuestion = cleanQuestionSurface(fallbackChoice?.question || "");
        const previousReadyQuestion = normalizeOneLine(lastReady?.question || "");
        const nextReadyQuestion = normalizeOneLine(fallbackQuestion);
        if (
          lastReady &&
          nextReadyQuestion &&
          nextReadyQuestion !== previousReadyQuestion
        ) {
          const payload = {
            status: "ready",
            questionId: qid,
            rawQuestion: current?.rawText || lastReady.rawQuestion || "",
            question: fallbackQuestion,
            firstSentence:
              typeof lastReady.firstSentence === "string" ? lastReady.firstSentence : "",
            firstSentenceIsFallback: false,
            outline: Array.isArray(lastReady.outline) ? lastReady.outline.slice(0, 4) : [],
            dontMiss: Array.isArray(lastReady.dontMiss) ? lastReady.dontMiss.slice(0, 2) : [],
            questionType: current?.questionType || "",
            confidence:
              typeof current?.confidence === "number" ? current.confidence : null,
            updatedAt: this._now(),
          };
          const signature = hashSignature({
            questionType: payload.questionType || "",
            question: payload.question || "",
            outline: Array.isArray(payload.outline) ? payload.outline : [],
            dontMiss: Array.isArray(payload.dontMiss) ? payload.dontMiss : [],
          });
          if (
            !this._lastReadySignature ||
            this._lastReadySignature.questionId !== payload.questionId ||
            this._lastReadySignature.signature !== signature
          ) {
            this._lastReadySignature = { questionId: payload.questionId, signature };
            this._sendIpc("live-coach-update", payload);
            this._readyCountByQuestionId.set(
              qid,
              (this._readyCountByQuestionId.get(qid) || 0) + 1,
            );
            this._lastReadyByQuestionId.set(qid, {
              question: payload.question || "",
              rawQuestion: payload.rawQuestion || "",
              outline: Array.isArray(payload.outline) ? payload.outline.slice(0, 4) : [],
              dontMiss: Array.isArray(payload.dontMiss) ? payload.dontMiss.slice(0, 2) : [],
              firstSentence:
                typeof payload.firstSentence === "string" ? payload.firstSentence : "",
              temporaryQuestion: false,
            });
          }
        }
        // Preserve monotonic UI behavior: if we already showed cards for this question, do not
        // replace them with an empty payload on late transient failures.
        return;
      }

      this._clearPendingGenerationFailure(qid);
      console.warn(
        `[LiveCoach] Suppressing local fallback cards for ${qid}: reason="${safeTrim(
          immediateMessage,
          180,
        )}" question="${safeTrim(current?.canonicalQuestion || current?.rawText || "", 140)}"`,
      );
      this._currentQuestion = null;
      this._sendIpc("live-coach-update", { status: "idle" });
      return;
    } finally {
      this._cardsInFlightByQuestionId.delete(qid);
      if (
        this._cardsAbortControllerByQuestionId instanceof Map &&
        this._cardsAbortControllerByQuestionId.get(qid) === abortController
      ) {
        this._cardsAbortControllerByQuestionId.delete(qid);
      }
      if (this._pauseAbortedQuestionIds instanceof Set) {
        this._pauseAbortedQuestionIds.delete(qid);
      }
      const queued = this._queuedCardsByQuestionId.get(qid) || null;
      this._queuedCardsByQuestionId.delete(qid);
      if (
        queued &&
        this._active &&
        this._enabled &&
        this._currentQuestion &&
        queued.questionId === this._currentQuestion.id
      ) {
        // A refinement queued while in-flight; re-run once.
        this._triggerGeneration(this._currentQuestion);
      }
    }
  }
}

module.exports = { LiveCoachEngine, safeTrim };
