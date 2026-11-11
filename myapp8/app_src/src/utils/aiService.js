const config = require('./config');
const liveCoachRuntime = require('./liveCoachRuntime');
const remoteConfig = require('./remoteConfig');
const { readSessionToken } = require('./sessionToken');
const { clientHeaders } = require('./clientInfo');

// Backend host/port are derived from the single source of truth (remoteConfig.API_BASE)
// rather than hardcoded, so pointing the app at a different domain (or a staging
// host) never leaves one request path stranded on the old domain.
const { API_HOST, API_PORT } = (() => {
  try {
    const u = new URL(remoteConfig.API_BASE);
    return { API_HOST: u.hostname, API_PORT: u.port ? Number(u.port) : 443 };
  } catch (_) {
    return { API_HOST: 'solvro.in', API_PORT: 443 };
  }
})();

// Most recent chat messages sent as context (user+assistant pairs). Bounds the
// request size so a long conversation doesn't keep slowing every new reply.
const MAX_HISTORY_MESSAGES = 12;

// Single source of truth for the selectable languages/models. Order here is the
// order the UI lists them in and the order the cycle shortcuts walk through.
// Ordered by how often each language actually shows up in coding assessments:
// C++/Java/Python carry the vast majority, then the mainstream web/systems
// languages, then the SQL dialects, with shell last.
const LANGUAGE_INFOS = {
  'cpp': { name: 'C++', icon: '⚡' },
  'java': { name: 'Java', icon: '☕' },
  'python': { name: 'Python', icon: '🐍' },
  'javascript': { name: 'JavaScript', icon: '📜' },
  'csharp': { name: 'C#', icon: '🎯' },
  'typescript': { name: 'TypeScript', icon: '📘' },
  'go': { name: 'Go', icon: '🐹' },
  'rust': { name: 'Rust', icon: '🦀' },
  'ruby': { name: 'Ruby', icon: '💎' },
  'php': { name: 'PHP', icon: '🐘' },
  'mysql': { name: 'MySQL', icon: '🐬' },
  'postgresql': { name: 'PostgreSQL', icon: '🐘' },
  'oracle': { name: 'Oracle', icon: '🔴' },
  'bash': { name: 'Bash', icon: '🐚' }
};

// The model catalogue is no longer a literal here. It is served by the website
// (see remoteConfig) because a build that hardcodes it can only be corrected by
// an update, and most users never install one. remoteConfig falls back to the
// old hardcoded list when the server is unreachable.

// The server rolls daily quotas over at midnight where the user actually is, so
// every request reports this machine's zone. Falls back to UTC on the rare
// system where Intl cannot resolve one.
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

// The backend reports quota, plan and provider failures as a JSON envelope:
// {"error": "...", "code": "daily_limit_reached", ...}. Surface that sentence
// instead of the raw JSON, and keep the structured fields on the error so the
// UI can render a proper card for it rather than a generic failure.
function buildApiError(provider, statusCode, rawBody) {
  let details = null;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') details = parsed;
  } catch (_) {
    // Not JSON — fall through to the raw body.
  }

  const message =
    details && typeof details.error === 'string'
      ? details.error
      : `${provider} API error ${statusCode}: ${rawBody}`;

  const error = new Error(message);
  error.details = { ...(details || {}), status: statusCode };
  return error;
}

class AIService {
  constructor() {
    // Initialize arrays first to prevent undefined errors
    this.currentMode = config.app.defaultMode; // Use config default mode
    this.currentLanguage = 'cpp'; // Default programming language

    // Model catalogue, per-mode pinning and per-mode whitelists all come from
    // the server now. syncFromRemoteConfig() refills these three fields; the
    // rest of this class reads them exactly as it did when they were literals.
    this.syncFromRemoteConfig();
    this.currentModel = remoteConfig.getDefaultModel();

    // A config refresh mid-session must not leave the app sitting on a model the
    // server has just withdrawn.
    remoteConfig.onChange(() => {
      this.syncFromRemoteConfig();
      const resolved = this.resolveModelForMode(this.currentMode);
      if (resolved && resolved !== this.currentModel) {
        console.log(`Model ${this.currentModel} no longer offered — switched to: ${resolved}`);
        this.currentModel = resolved;
      }
    });

    this.conversationHistory = [];
    this.screenshotQueue = [];

    // Interview Mode: 3-Tier Context Storage
    // TIER 1 (Static): Resume, JD, extra instructions — fetched from website DB
    // These will be populated via setInterviewContext() when the website API is ready
    this.interviewContext = {
      interviewTopic: '',    // Role being interviewed for (fetched from DB)
      resumeText: '',        // User's resume text (fetched from DB)
      jobDescription: '',    // Job description (fetched from DB)
      extraInstructions: '', // Extra instructions from user (fetched from DB)
    };
    // TIER 2 (Summary): Rolling summary of older transcript (built client-side)
    this.interviewSummary = '';
    // Interview conversation turns (separate from main conversationHistory)
    this.interviewTurnCount = 0;

    console.log('AI service initialized');
  }

  // Pulls the server-controlled model catalogue into the fields the rest of this
  // class reads. Called at construction and again whenever remoteConfig
  // refreshes, so a model added or retired on the website reaches a running app
  // within one config TTL — no reinstall, no restart.
  syncFromRemoteConfig() {
    this.modelInfos = {};
    for (const model of remoteConfig.getModels()) {
      this.modelInfos[model.id] = { name: model.name, icon: model.icon, tier: model.tier };
    }
    this.models = Object.keys(this.modelInfos);

    // Modes that always run on a fixed model — the user cannot switch models here
    this.fixedModelModes = {};
    // Modes that only offer a subset of the models — anything outside the list is
    // never cycled to and never shown in the UI for that mode
    this.modeModels = {};
    for (const modeId of Object.keys(remoteConfig.get().modes || {})) {
      const fixed = remoteConfig.getFixedModelForMode(modeId);
      if (fixed) this.fixedModelModes[modeId] = fixed;
      const allowed = remoteConfig.getModeModels(modeId);
      if (allowed) this.modeModels[modeId] = allowed;
    }
  }

  normalizeLanguage(language) {
    const value = String(language || '').trim().toLowerCase();

    if (Object.prototype.hasOwnProperty.call(LANGUAGE_INFOS, value)) return value;

    if (value === 'jaava') return 'java';
    if (value === 'py') return 'python';
    if (value === 'c++' || value === 'cxx') return 'cpp';
    if (value === 'sql') return 'mysql';
    if (value === 'postgres') return 'postgresql';
    if (value === 'oraclesql') return 'oracle';
    if (value === 'sh' || value === 'shell' || value === 'zsh') return 'bash';

    return 'cpp';
  }

  // Set user key and initialize (mocked)
  async setUserKey(userKey) {
    console.log('User key validation bypassed (direct mode)');
    return true;
  }

  // Get user key (JWT token).
  //
  // This read used to be a bare readFileSync with no .trim(), unlike every other
  // token reader in the app. The installer writes this file from PowerShell,
  // which leaves a trailing CRLF (and can add a UTF-8 BOM), so the token went
  // into the Cookie header with a newline in it — Node rejects that with
  // ERR_INVALID_CHAR, so every single AI request threw before it left the
  // machine and the user appeared to be signed out with no way to fix it.
  // readSessionToken() is the one sanitising reader; see sessionToken.js.
  getUserKey() {
    return readSessionToken();
  }

  // Check if user key is set (always true in direct mode)
  hasUserKey() {
    return true;
  }

  setMode(mode) {
    this.currentMode = mode;
    console.log(`AI mode switched to: ${mode}`);
    // The model carried over from the previous mode may not be offered here.
    // Pinned modes (interview/mcq) force their model at request time instead, so the
    // user's own choice survives a round trip through them.
    if (this.isModelLocked(mode)) return;
    const resolved = this.resolveModelForMode(mode);
    if (resolved && resolved !== this.currentModel) {
      this.currentModel = resolved;
      console.log(`Model not available in ${mode} mode — switched to: ${resolved}`);
    }
  }

  getCurrentMode() {
    return this.currentMode;
  }

  setLanguage(language) {
    this.currentLanguage = this.normalizeLanguage(language);
    console.log(`Programming language switched to: ${this.currentLanguage}`);
  }

  getCurrentLanguage() {
    return this.currentLanguage;
  }

  getLanguageInfo(language) {
    const id = language || this.currentLanguage;
    return LANGUAGE_INFOS[id] || LANGUAGE_INFOS['cpp'];
  }

  // Every language the UI can offer, in display order
  getLanguageOptions() {
    return Object.entries(LANGUAGE_INFOS).map(([id, info]) => ({
      id,
      name: info.name,
      icon: info.icon,
      current: id === this.currentLanguage
    }));
  }

  getModeInfo() {
    const modes = {};
    if (config.app && config.app.modes) {
      for (const [key, value] of Object.entries(config.app.modes)) {
        modes[key] = { name: value.name, icon: value.icon };
      }
    }
    // Fallback if config fails
    if (Object.keys(modes).length === 0) {
      return { name: 'Coding', icon: '💻' };
    }
    return modes[this.currentMode] || modes[config.app.defaultMode];
  }

  // Returns the pinned model for a mode, or null when the mode allows switching
  getFixedModelForMode(mode) {
    const modeId = mode || this.currentMode;
    return Object.prototype.hasOwnProperty.call(this.fixedModelModes, modeId)
      ? this.fixedModelModes[modeId]
      : null;
  }

  isModelLocked(mode) {
    return !!this.getFixedModelForMode(mode);
  }

  // Models the user can switch between in a mode. Pinned modes expose only their
  // fixed model; restricted modes (e.g. query) expose their whitelist.
  getAvailableModels(mode) {
    const modeId = mode || this.currentMode;
    const fixedModel = this.getFixedModelForMode(modeId);
    if (fixedModel) return [fixedModel];
    const allowed = this.modeModels[modeId];
    return allowed ? allowed.filter(m => this.models.includes(m)) : this.models;
  }

  isModelAllowedForMode(model, mode) {
    return this.getAvailableModels(mode).includes(model);
  }

  // Falls back to the first available model when the current one isn't offered in this mode
  resolveModelForMode(mode) {
    const modeId = mode || this.currentMode;
    const available = this.getAvailableModels(modeId);
    return available.includes(this.currentModel) ? this.currentModel : available[0];
  }

  setModel(model) {
    if (this.models.includes(model) && this.isModelAllowedForMode(model)) {
      this.currentModel = model;
      console.log(`AI model switched to: ${model}`);
    }
  }

  getCurrentModel() {
    return this.currentModel;
  }

  getModelInfo(model) {
    const id = model || this.currentModel;
    return this.modelInfos[id] || remoteConfig.getModelInfo(id);
  }

  // The models the UI should list for a mode (already filtered by pin/whitelist)
  getModelOptions(mode) {
    const modeId = mode || this.currentMode;
    return this.getAvailableModels(modeId).map(id => ({
      id,
      name: this.getModelInfo(id).name,
      icon: this.getModelInfo(id).icon,
      // Plan tier the server requires for this model, so the UI can grey out
      // what the user cannot use without knowing the model in advance.
      tier: this.getModelInfo(id).tier,
      current: id === this.currentModel
    }));
  }

  // Every mode the UI can offer, in config order
  getModeOptions() {
    const modes = (config.app && config.app.modes) || {};
    return Object.entries(modes).map(([id, info]) => ({
      id,
      name: info.name,
      icon: info.icon,
      current: id === this.currentMode
    }));
  }

  // Screenshot cap for the current mode, or null when the mode is uncapped.
  getMaxScreenshots() {
    return remoteConfig.getMaxScreenshots(this.currentMode);
  }

  isQueueFull() {
    const max = this.getMaxScreenshots();
    return max !== null && this.screenshotQueue.length >= max;
  }

  // Add screenshot to queue for direct analysis. Returns null (and queues
  // nothing) when the current mode's screenshot cap is already reached.
  addScreenshotToQueue(base64Image, extractedData, timestamp) {
    if (this.isQueueFull()) {
      console.log(`Screenshot rejected: queue full (${this.screenshotQueue.length}/${this.getMaxScreenshots()})`);
      return null;
    }
    const screenshot = {
      id: Date.now() + Math.random(),
      image: base64Image,
      timestamp: timestamp || new Date().toISOString(),
      addedAt: new Date().toLocaleTimeString(),
      mode: this.currentMode,
      language: this.currentLanguage
    };
    this.screenshotQueue.push(screenshot);
    console.log(`Screenshot added to queue. Queue size: ${this.screenshotQueue.length}`);
    return screenshot;
  }

  // Get current queue
  getQueue() {
    return this.screenshotQueue;
  }

  // Clear conversation and queue (reset)
  resetConversation() {
    this.conversationHistory = [];
    this.screenshotQueue = [];
    this.interviewSummary = '';
    this.interviewTurnCount = 0;
    console.log('Conversation and queue reset');
  }

  // Remove a single screenshot from the queue (e.g. user removed an attachment chip)
  removeScreenshotFromQueue(id) {
    this.screenshotQueue = this.screenshotQueue.filter(item => item.id !== id);
    return this.screenshotQueue;
  }

  // Clear only the screenshot queue, keep conversation
  clearQueue() {
    this.screenshotQueue = [];
    console.log('Screenshot queue cleared, conversation history preserved');
  }

  // ─── Interview Context Management (Tier 1: Static) ──────────────────────
  // These methods will be called when the website API is ready to fetch
  // resume, JD, and extra instructions from the database.

  /** Set interview context data (resume, JD, extra instructions) */
  setInterviewContext({ interviewTopic, resumeText, jobDescription, extraInstructions }) {
    if (interviewTopic !== undefined) this.interviewContext.interviewTopic = interviewTopic;
    if (resumeText !== undefined) this.interviewContext.resumeText = resumeText;
    if (jobDescription !== undefined) this.interviewContext.jobDescription = jobDescription;
    if (extraInstructions !== undefined) this.interviewContext.extraInstructions = extraInstructions;
    console.log('Interview context updated:', {
      hasTopic: !!this.interviewContext.interviewTopic,
      hasResume: !!this.interviewContext.resumeText,
      hasJD: !!this.interviewContext.jobDescription,
      hasExtra: !!this.interviewContext.extraInstructions
    });
  }

  /** Get current interview context */
  getInterviewContext() {
    return this.interviewContext;
  }

  /** Update interview summary (Tier 2) */
  setInterviewSummary(summary) {
    this.interviewSummary = summary;
  }

  /** Build the full interview prompt using Live Coach structured JSON format */
  _buildInterviewPrompt(basePrompt, transcriptText) {
    // System prompt is the base prompt from config (Live Coach JSON schema)
    let systemPrompt = basePrompt;

    // Build the user prompt with context, transcript, and question
    const blocks = [];

    // Candidate context (topic, resume, JD, extra instructions)
    const contextParts = [];
    if (this.interviewContext.interviewTopic) {
      contextParts.push(`Interview Role: Interviewing for the role of ${this.interviewContext.interviewTopic}`);
    }
    if (this.interviewContext.resumeText) {
      contextParts.push(`Resume:\n${this.interviewContext.resumeText}`);
    }
    if (this.interviewContext.jobDescription) {
      contextParts.push(`Job Description:\n${this.interviewContext.jobDescription}`);
    }
    if (this.interviewContext.extraInstructions) {
      contextParts.push(`Additional Instructions:\n${this.interviewContext.extraInstructions}`);
    }
    if (contextParts.length > 0) {
      blocks.push(`Candidate context:\n${contextParts.join('\n\n')}`);
    }

    // Interview summary (older context)
    if (this.interviewSummary) {
      blocks.push(`Interview summary:\n${this.interviewSummary}`);
    }

    // Recent transcript
    if (transcriptText) {
      blocks.push(`Recent transcript:\n${transcriptText}`);
    }

    blocks.push('Respond with the final JSON object only.');
    blocks.push('No explanation text. No markdown. No extra keys.');

    const userPrompt = blocks.join('\n\n');

    // Combine system prompt + user prompt for the single-turn interview call
    return systemPrompt + '\n\n' + userPrompt;
  }

  /** Parse interview AI response into structured cards using liveCoachRuntime */
  _parseInterviewCards(rawText) {
    try {
      // Try to extract JSON object from the response
      const parsed = liveCoachRuntime.extractFirstJsonObject(rawText);
      if (parsed && typeof parsed === 'object') {
        // Sanitize each field using the runtime's sanitization pipeline
        const firstSentence = liveCoachRuntime.sanitizeFirstSentence(
          parsed.firstSentence || parsed.first_sentence || '', 24
        );
        
        const outlineRaw = liveCoachRuntime.coerceBulletList(
          parsed.outline || parsed.plan || parsed.steps || parsed.skeleton || []
        );
        const outline = outlineRaw
          .map(item => liveCoachRuntime.sanitizeTalkingPointBullet(String(item || '')))
          .filter(Boolean)
          .slice(0, 4);

        const dontMissRaw = liveCoachRuntime.coerceBulletList(parsed.dontMiss || []);
        const dontMiss = liveCoachRuntime.normalizeDontMissBullets(
          dontMissRaw.map(item => String(item || ''))
        ).slice(0, 2);

        const questionType = liveCoachRuntime.normalizeQuestionType(
          parsed.questionType || parsed.question_type || 'other'
        );

        const question = liveCoachRuntime.sanitizeQuestionLine(
          parsed.question || parsed.canonicalQuestion || '', 20
        );

        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

        return {
          success: true,
          firstSentence,
          outline,
          dontMiss,
          questionType,
          question,
          confidence,
          raw: rawText
        };
      }
    } catch (e) {
      console.warn('[Interview] Failed to parse structured cards:', e.message);
    }

    // Fallback: return raw text as a single outline point
    return {
      success: false,
      firstSentence: '',
      outline: [rawText.substring(0, 300)],
      dontMiss: [],
      questionType: 'other',
      question: '',
      confidence: 0,
      raw: rawText
    };
  }

  // Analyze multiple images using server endpoint
  async analyzeMultipleImages(queue, additionalText = '', onChunk = null) {
    console.log('=== analyzeMultipleImages called (Server Mode) ===');
    console.log('Queue length:', queue.length);
    console.log('Additional text:', additionalText);

    try {
      // Determine the primary mode and language
      const modes = queue.map(item => item.mode);
      const primaryMode = modes.length > 0 ? modes[0] : this.currentMode || config.app.defaultMode;

      const languages = queue.map(item => this.normalizeLanguage(item.language)).filter(lang => lang);
      const primaryLanguage = this.normalizeLanguage(this.currentLanguage) || (languages.length > 0 ? languages[0] : 'java');

      console.log(`Using mode: ${primaryMode}, language: ${primaryLanguage}`);

      // Prepare request payload
      // In Query mode with no screenshots, send minimal queue structure
      const requestBody = {
        mode: primaryMode,
        language: primaryLanguage,
        queue: queue.length > 0 ? queue : (primaryMode === 'query' ? [] : queue),
        additionalText: additionalText || '',
        textOnly: primaryMode === 'query' && queue.length === 0 // Flag for text-only analysis
      };

      console.log('Sending request to Gemini API...');
      console.log(`Request language: ${requestBody.language}`);

      // Send request to server
      const response = await this.sendToServer(requestBody, onChunk);

      console.log('Server response received, analysis length:', response.analysis.length);

      // Add to conversation history
      const screenshotCount = queue.length > 0 ? queue.length : 0;
      let contextDescription;
      if (primaryMode === 'query') {
        // Chat mode: keep the user's actual words so follow-ups read like a real conversation
        const attachmentNote = screenshotCount > 0 ? `[Attached ${screenshotCount} screenshot(s)]` : '';
        contextDescription = [attachmentNote, additionalText].filter(Boolean).join('\n');
      } else {
        contextDescription = screenshotCount > 0
          ? `Analyzed ${screenshotCount} screenshot(s) in ${primaryMode} mode${additionalText ? ` with context: ${additionalText}` : ''}`
          : `Query in ${primaryMode} mode: ${additionalText}`;
      }

      // For interview mode, DON'T accumulate conversation history (prevents quadratic growth)
      // Each question gets fresh context with the full transcript instead
      if (primaryMode !== 'interview') {
        this.conversationHistory.push({
          role: 'user',
          content: contextDescription
        });
        this.conversationHistory.push({
          role: 'assistant',
          content: response.analysis
        });
      } else {
        this.interviewTurnCount++;
      }

      return response.analysis;

    } catch (error) {
      console.error('Error in analyzeMultipleImages:', error);
      throw error;
    }
  }

  async sendToServer(requestBody, onChunk = null) {
    // Interview and MCQ modes ALWAYS use Gemini 3.7 Flash (no model switching)
    const fixedModel = this.getFixedModelForMode(requestBody.mode);
    if (fixedModel) {
      return this.sendToGemini({ ...requestBody, forceModel: fixedModel }, onChunk);
    }
    // Guard against a model that isn't offered in this mode (e.g. a Claude model in query mode)
    const model = this.resolveModelForMode(requestBody.mode);
    if (model.startsWith('claude')) {
      return this.sendToClaude(requestBody, onChunk);
    }
    return this.sendToGemini({ ...requestBody, forceModel: model }, onChunk);
  }

  // Send request to Claude / Anthropic compatible API
  async sendToClaude(requestBody, onChunk = null) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      // API key is handled securely by the Netlify backend, no local check needed.

      const modeConfig = config.app.modes[requestBody.mode];
      let promptText = '';

      if (requestBody.mode === 'coding') {
        // Per-language, plagiarism-resistant prompt (C++ uses its real samples,
        // every other language gets written human-style guidance).
        promptText = config.buildCodingPrompt(requestBody.language);
      } else {
        promptText = modeConfig ? modeConfig.prompt : `Please analyze this according to mode: ${requestBody.mode}.`;
      }

      // Exclude language injection for behavioral and conceptual modes
      if (!['mcq', 'query'].includes(requestBody.mode)) {
        promptText += `\nCRITICAL REQUIREMENT: Your output MUST be in ${requestBody.language.toUpperCase()}.`;
      }
      if (requestBody.mode === 'mcq' && requestBody.queue && requestBody.queue.length > 1) {
        promptText += `\nYou are given ${requestBody.queue.length} screenshots. Answer every question from all of them.`;
      }
      if (requestBody.additionalText) {
        promptText += `\nAdditional instructions: ${requestBody.additionalText}`;
      }

      let contentArray = [];
      if (requestBody.queue && requestBody.queue.length > 0) {
        for (const item of requestBody.queue) {
          if (item.image) {
            let base64Data = item.image;
            let mimeType = 'image/png';
            if (base64Data.startsWith('data:image')) {
              mimeType = base64Data.split(';')[0].split(':')[1];
              base64Data = base64Data.split(',')[1];
            }
            contentArray.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Data
              }
            });
          }
        }
      }

      const messages = [];

      // History only for Query (chat); coding/mcq are one-shot — see the note in
      // sendToGemini. Capped recent exchanges keep follow-ups coherent.
      if (requestBody.mode === 'query' && this.conversationHistory && this.conversationHistory.length > 0) {
        for (const msg of this.conversationHistory.slice(-MAX_HISTORY_MESSAGES)) {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          });
        }
      }

      contentArray.push({ type: 'text', text: promptText });
      messages.push({ role: 'user', content: contentArray });

      const payload = {
        model: this.currentModel,
        max_tokens: 4096,
        messages: messages
      };

      const postData = JSON.stringify(payload);

      // Read the token once — both cookie names must carry the same value, and
      // re-reading mid-expression could pick up a token that changed underneath.
      const sessionToken = this.getUserKey();

      const options = {
        hostname: API_HOST,
        path: '/api/ai/claude',
        port: API_PORT,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'claude-code/0.2.29',
          'anthropic-version': '2023-06-01',
          'Cookie': `next-auth.session-token=${sessionToken}; __Secure-next-auth.session-token=${sessionToken}`,
          'x-timezone': localTimeZone(),
          ...clientHeaders(),
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let analysisText = '';
        let dataBuffer = '';

        if (res.statusCode !== 200) {
           let errData = '';
           res.on('data', chunk => { errData += chunk; });
           res.on('end', () => reject(buildApiError('Claude', res.statusCode, errData)));
           return;
        }

        res.on('data', (chunk) => {
          dataBuffer += chunk.toString('utf8');
          
          let lines = dataBuffer.split('\n');
          dataBuffer = lines.pop(); // keep the last incomplete line in buffer

          for (let line of lines) {
            if (line.startsWith('data:')) {
              const dataStr = line.startsWith('data: ') ? line.slice(6).trim() : line.slice(5).trim();
              if (dataStr === '[DONE]' || !dataStr) continue;
              
              try {
                const dataObj = JSON.parse(dataStr);
                let textChunk = '';
                
                if (dataObj.type === 'content_block_delta' && dataObj.delta && dataObj.delta.text) {
                  textChunk = dataObj.delta.text;
                } else if (dataObj.type === 'message' && dataObj.content && dataObj.content[0] && dataObj.content[0].text) {
                  textChunk = dataObj.content[0].text;
                } else if (dataObj.error) {
                  textChunk = `Error: ${JSON.stringify(dataObj.error)}`;
                }
                
                if (textChunk) {
                  analysisText += textChunk;
                  if (onChunk) onChunk(textChunk);
                }
              } catch (e) {
                // ignore incomplete JSON or parse errors on chunks
              }
            }
          }
        });

        res.on('end', () => {
          resolve({ success: true, analysis: analysisText });
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`));
      });

      const claudeTimeoutMs = remoteConfig.getTimeoutMs(this.currentModel);
      req.setTimeout(claudeTimeoutMs, () => {
        req.destroy();
        reject(new Error(`AI request timed out after ${claudeTimeoutMs / 1000} seconds. Please try again.`));
      });

      req.write(postData);
      req.end();
    });
  }

  // Send request directly to Gemini API
  async sendToGemini(requestBody, onChunk = null) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      // API key is handled securely by the Netlify backend, no local check needed.

      // The backend handles the Gemini URL now

      const modelToUse = requestBody.forceModel || this.currentModel;

      const modeConfig = config.app.modes[requestBody.mode];
      let promptText = '';

      if (requestBody.mode === 'coding') {
        // Per-language, plagiarism-resistant prompt (C++ uses its real samples,
        // every other language gets written human-style guidance).
        promptText = config.buildCodingPrompt(requestBody.language);
      } else {
        promptText = modeConfig ? modeConfig.prompt : `Please analyze this according to mode: ${requestBody.mode}.`;
      }

      // Exclude language injection for behavioral and conceptual modes
      if (!['mcq', 'query', 'interview'].includes(requestBody.mode)) {
        promptText += `\nCRITICAL REQUIREMENT: Your output MUST be in ${requestBody.language.toUpperCase()}.`;
      }

      // Gemini 3.1 Pro is a reasoning model and tends to over-explain in chat.
      // Keep query (chat) answers short and fast by default; it still gives
      // depth when the user explicitly asks (the per-mode token cap is a
      // backstop). This instruction, not a tiny token cap, is what actually
      // keeps answers — and token use — small without truncating mid-sentence.
      if (requestBody.mode === 'query' && modelToUse === 'gemini-3.1-pro') {
        promptText += `\nRESPONSE LENGTH: Keep your answer concise and to the point by default — a few sentences or a short list. Only give a long, detailed response when the user explicitly asks for more detail, depth, or length.`;
      }

      if (requestBody.mode === 'mcq' && requestBody.queue && requestBody.queue.length > 1) {
        promptText += `\nYou are given ${requestBody.queue.length} screenshots. Answer every question from all of them.`;
      }

      if (requestBody.additionalText) {
        promptText += `\nAdditional instructions: ${requestBody.additionalText}`;
      }

      // If they ask a general query, provide their background context so the AI knows who they are.
      if (requestBody.mode === 'query' && this.interviewContext && (this.interviewContext.resumeText || this.interviewContext.jobDescription || this.interviewContext.interviewTopic)) {
        promptText += `\n\n--- User Context ---\n`;
        if (this.interviewContext.interviewTopic) {
          promptText += `Interviewing for: ${this.interviewContext.interviewTopic}\n\n`;
        }
        if (this.interviewContext.resumeText) {
          promptText += `Resume / Professional Background:\n${this.interviewContext.resumeText}\n\n`;
        }
        if (this.interviewContext.jobDescription) {
          promptText += `Target Job Description:\n${this.interviewContext.jobDescription}\n\n`;
        }
      }

      const parts = [{ text: promptText }];

      if (requestBody.queue && requestBody.queue.length > 0) {
        for (const item of requestBody.queue) {
          if (item.image) {
            let base64Data = item.image;
            // Strip data URL prefix if present
            if (base64Data.startsWith('data:image')) {
              base64Data = base64Data.split(',')[1];
            }
            parts.push({
              inlineData: {
                mimeType: 'image/png',
                data: base64Data
              }
            });
          }
        }
      }

      const contents = [];

      // ── Interview Mode: 3-Tier Context, Fresh per Question ──
      if (requestBody.mode === 'interview') {
        const transcriptText = requestBody.additionalText
          ? requestBody.additionalText.replace(/^TRANSCRIPT_TRIGGER:\s*/i, '')
          : '';
        const interviewPrompt = this._buildInterviewPrompt(promptText, transcriptText);

        require('fs').writeFileSync(require('path').join(require('electron').app.getPath('userData'), 'debug_prompt.txt'), interviewPrompt);
        
        // Interview mode: single turn, no conversation history accumulation
        contents.push({
          role: 'user',
          parts: [{ text: interviewPrompt }]
        });
      } else {
        // Conversation history is only useful for Query (chat), where follow-ups
        // refer back to earlier turns. Coding and MCQ are one-shot per screenshot,
        // so replaying prior Q&A there just inflates every request (slower the more
        // you've asked) and can bias a fresh problem with an unrelated earlier one.
        // Capped even for chat so a long conversation doesn't grow unbounded.
        if (requestBody.mode === 'query' && this.conversationHistory && this.conversationHistory.length > 0) {
          for (const msg of this.conversationHistory.slice(-MAX_HISTORY_MESSAGES)) {
            contents.push({
              role: msg.role === 'user' ? 'user' : 'model',
              parts: [{ text: msg.content }]
            });
          }
        }

        contents.push({
          role: 'user',
          parts: parts
        });
      }

      // Per-model settings (thinking budget for the reasoning models, etc.) come
      // from the server. The backend applies its own copy over whatever we send,
      // so this is really just a hint — which is what lets an old build keep
      // working after a model is re-pointed. Mode is passed so a model can use a
      // different output cap / thinking budget per app mode (short in query,
      // generous in coding).
      const generationConfig = remoteConfig.getGenerationConfig(modelToUse, requestBody.mode);

      const geminiPayload = {
        model: modelToUse,
        contents: contents,
        ...(generationConfig && { generationConfig })
      };

      const postData = JSON.stringify(geminiPayload);

      // Diagnostic: shows exactly what config the client is sending. If this
      // prints thinkingBudget 32768 (the old value) for gemini-3.1-pro, the
      // served /api/app-config (or a cached copy) is overriding the baked one;
      // if it prints the new low value but the answer is still empty, the
      // /api/ai/gemini backend proxy is overriding generationConfig.
      console.log('[Gemini] request →', JSON.stringify({ model: modelToUse, mode: requestBody.mode, generationConfig }));

      const sessionToken = this.getUserKey();

      const options = {
        hostname: API_HOST,
        port: API_PORT,
        path: '/api/ai/gemini',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `next-auth.session-token=${sessionToken}; __Secure-next-auth.session-token=${sessionToken}`,
          'x-timezone': localTimeZone(),
          ...clientHeaders(),
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      // Model selection and API keys are handled securely by the Netlify backend.

      const req = https.request(options, (res) => {
        let analysisText = '';
        let dataBuffer = '';
        // Captured for diagnosing empty responses: finishReason === 'MAX_TOKENS'
        // with a large thoughtsTokenCount confirms thinking ate the output budget.
        let finishReason = null;
        let usageMetadata = null;

        if (res.statusCode !== 200) {
          let errData = '';
          res.on('data', chunk => { errData += chunk; });
          res.on('end', () => reject(buildApiError('Gemini', res.statusCode, errData)));
          return;
        }

        res.on('data', (chunk) => {
          const rawChunk = chunk.toString('utf8');
          dataBuffer += rawChunk;
          
          // Debug: log raw chunks (truncated) for thinking model diagnosis
          if (rawChunk.includes('data:') && !rawChunk.includes('keep-alive')) {
            console.log('[Gemini SSE] Raw chunk (first 500 chars):', rawChunk.substring(0, 500));
          }
          
          let lines = dataBuffer.split('\n');
          dataBuffer = lines.pop(); // keep incomplete line

          for (let line of lines) {
            // Handle both 'data: ' (with space) and 'data:' (without space)
            if (line.startsWith('data:')) {
              const dataStr = line.startsWith('data: ') ? line.slice(6).trim() : line.slice(5).trim();
              if (!dataStr) continue;
              
              try {
                const dataObj = JSON.parse(dataStr);
                
                // Debug: log parsed structure
                console.log('[Gemini SSE] Parsed keys:', Object.keys(dataObj));
                
                // Handle error responses from the proxy (e.g. Vertex API errors)
                if (dataObj.error) {
                  const errorMsg = typeof dataObj.error === 'string' ? dataObj.error : JSON.stringify(dataObj.error);
                  console.log('[Gemini SSE] ERROR from proxy:', errorMsg);
                  analysisText += `Error: ${errorMsg}`;
                  if (onChunk) onChunk(`Error: ${errorMsg}`);
                } else if (dataObj.candidates && dataObj.candidates[0]) {
                  const candidate = dataObj.candidates[0];
                  if (candidate.finishReason) finishReason = candidate.finishReason;
                  if (dataObj.usageMetadata) usageMetadata = dataObj.usageMetadata;

                  // Debug: log candidate structure
                  console.log('[Gemini SSE] Candidate keys:', Object.keys(candidate));
                  if (candidate.content && candidate.content.parts) {
                    console.log('[Gemini SSE] Parts count:', candidate.content.parts.length, 
                      'Part keys:', candidate.content.parts.map(p => Object.keys(p)));
                  }
                  
                  if (candidate.content && candidate.content.parts) {
                    // Iterate all parts — thinking models return thought parts before the answer
                    for (const part of candidate.content.parts) {
                      // Skip internal thinking/thought parts, only extract the real answer
                      if (part.thought === true) {
                        console.log('[Gemini SSE] Skipping thought part, length:', (part.text || '').length);
                        continue;
                      }
                      if (part.text) {
                        analysisText += part.text;
                        if (onChunk) onChunk(part.text);
                      }
                    }
                  } else {
                    // Some chunks may have candidates but no content (e.g., finishReason only)
                    console.log('[Gemini SSE] Candidate without content:', JSON.stringify(candidate).substring(0, 300));
                  }
                } else {
                  // Unknown structure — log it
                  console.log('[Gemini SSE] Unhandled data structure:', JSON.stringify(dataObj).substring(0, 300));
                }
              } catch (e) {
                // Log parse errors with context
                console.log('[Gemini SSE] JSON parse error:', e.message, 'Data:', dataStr.substring(0, 200));
              }
            }
          }
        });

        res.on('end', () => {
          console.log('[Gemini SSE] Stream ended. Total analysisText length:', analysisText.length,
            '| finishReason:', finishReason, '| usage:', JSON.stringify(usageMetadata));
          if (analysisText.length === 0) {
            // No answer text at all — almost always a thinking model whose
            // thinking budget consumed the whole output limit. The finishReason
            // (MAX_TOKENS) + usage (large thoughtsTokenCount) confirm that.
            console.log('[Gemini SSE] WARNING: Empty response!',
              'finishReason:', finishReason, 'usage:', JSON.stringify(usageMetadata));
            const detail = finishReason === 'MAX_TOKENS'
              ? ' (hit the output-token limit while thinking — lower the thinking budget / raise maxOutputTokens on the backend)'
              : finishReason ? ` (finishReason: ${finishReason})` : '';
            reject(new Error(`The model returned an empty response${detail}. Please try again or switch models.`));
            return;
          }
          resolve({ success: true, analysis: analysisText });
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`));
      });

      // Thinking models need longer than the rest; how much longer is a
      // server-side setting so a slow new model does not need an app release.
      const timeoutMs = remoteConfig.getTimeoutMs(modelToUse, requestBody.mode);
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(`AI request timed out after ${timeoutMs / 1000} seconds. Please try again.`));
      });

      req.write(postData);
      req.end();
    });
  }

  // Get conversation history
  getConversationHistory() {
    return this.conversationHistory;
  }

}

module.exports = AIService;
