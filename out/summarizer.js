"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmSummary = llmSummary;
exports.extractiveSummary = extractiveSummary;
const MAX_INPUT_LENGTH = 2000;
async function llmSummary(messages, options) {
    const fullText = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n\n');
    const text = fullText.length > MAX_INPUT_LENGTH
        ? fullText.slice(0, MAX_INPUT_LENGTH) + '...'
        : fullText;
    if (text.trim().length < 100) {
        return null;
    }
    try {
        const { pipeline } = await Promise.resolve().then(() => __importStar(require('@huggingface/transformers')));
        const summarizer = await pipeline('summarization', 'Xenova/distilbart-cnn-6-6');
        const opts = {
            max_length: options?.maxLength ?? 130,
            min_length: options?.minLength ?? 30,
            do_sample: false,
        };
        const out = await summarizer(text, opts);
        const arr = Array.isArray(out) ? out : [out];
        const first = arr[0];
        const item = Array.isArray(first) ? first[0] : first;
        return item && typeof item === 'object' && 'summary_text' in item
            ? String(item.summary_text)
            : null;
    }
    catch {
        return null;
    }
}
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'were',
    'been', 'are', 'am', 'do', 'does', 'did', 'has', 'have', 'had', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'not', 'no', 'i', 'me', 'my',
    'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'his', 'her', 'its',
]);
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}
function splitSentences(text) {
    return text
        .replace(/\n+/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20);
}
function extractiveSummary(messages, maxSentences = 6) {
    const fullText = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => m.content)
        .join('\n');
    const allTokens = tokenize(fullText);
    const totalTerms = allTokens.length;
    if (totalTerms === 0) {
        return fullText.slice(0, 500);
    }
    const termFreq = new Map();
    for (const t of allTokens) {
        termFreq.set(t, (termFreq.get(t) || 0) + 1);
    }
    const docFreq = new Map();
    const sentences = [];
    const sentenceIndexByMessage = [];
    let idx = 0;
    for (const m of messages) {
        if (m.role === 'context') {
            continue;
        }
        const parts = splitSentences(m.content);
        for (const s of parts) {
            sentences.push(s);
            sentenceIndexByMessage.push(idx);
            idx++;
        }
    }
    if (sentences.length === 0) {
        return fullText.slice(0, 500);
    }
    for (const s of sentences) {
        const tokens = new Set(tokenize(s));
        for (const t of tokens) {
            docFreq.set(t, (docFreq.get(t) || 0) + 1);
        }
    }
    const n = sentences.length;
    const idf = (t) => {
        const df = docFreq.get(t) || 0;
        return Math.log((n + 1) / (df + 1)) + 1;
    };
    const scores = sentences.map((s, i) => {
        const tokens = tokenize(s);
        let score = 0;
        for (const t of tokens) {
            const tf = termFreq.get(t) || 0;
            score += (tf / totalTerms) * idf(t);
        }
        const positionBias = 1 + (1 - i / Math.max(n, 1)) * 0.3;
        return { index: i, score: score * positionBias };
    });
    scores.sort((a, b) => b.score - a.score);
    const topIndices = new Set(scores
        .slice(0, maxSentences)
        .map((x) => x.index));
    const byOriginalOrder = [];
    for (let i = 0; i < sentences.length; i++) {
        if (topIndices.has(i)) {
            byOriginalOrder.push(sentences[i]);
        }
    }
    return byOriginalOrder.join(' ');
}
//# sourceMappingURL=summarizer.js.map