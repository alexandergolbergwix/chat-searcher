"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BM25Index = void 0;
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'were',
    'been', 'are', 'am', 'do', 'does', 'did', 'has', 'have', 'had', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'not', 'no',
    'if', 'then', 'else', 'when', 'up', 'out', 'so', 'than', 'too', 'very',
    'just', 'about', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
    'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'his', 'her',
    'its', 'what', 'which', 'who', 'how', 'all', 'each', 'every', 'both',
    'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
    'here', 'there', 'also', 'into', 'over', 'after', 'before', 'between',
    'through', 'during', 'above', 'below', 'any', 'because', 'while'
]);
class BM25Index {
    constructor(k1 = 1.5, b = 0.75) {
        this.documents = [];
        this.documentFrequency = new Map();
        this.averageDocLength = 0;
        this.totalDocuments = 0;
        this.k1 = k1;
        this.b = b;
    }
    tokenize(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(token => token.length > 1 && !STOP_WORDS.has(token));
    }
    addDocuments(docs) {
        for (const doc of docs) {
            const tokens = this.tokenize(doc.text);
            const termFrequencies = new Map();
            for (const token of tokens) {
                termFrequencies.set(token, (termFrequencies.get(token) || 0) + 1);
            }
            this.documents.push({
                id: doc.id,
                tokens,
                termFrequencies,
                metadata: doc.metadata,
            });
            const uniqueTokens = new Set(tokens);
            for (const token of uniqueTokens) {
                this.documentFrequency.set(token, (this.documentFrequency.get(token) || 0) + 1);
            }
        }
        this.totalDocuments = this.documents.length;
        if (this.totalDocuments > 0) {
            this.averageDocLength =
                this.documents.reduce((sum, d) => sum + d.tokens.length, 0) /
                    this.totalDocuments;
        }
    }
    search(query, topK = 30) {
        if (this.totalDocuments === 0) {
            return [];
        }
        const queryTokens = this.tokenize(query);
        if (queryTokens.length === 0) {
            return [];
        }
        const scores = [];
        for (const doc of this.documents) {
            let score = 0;
            for (const queryToken of queryTokens) {
                const tf = doc.termFrequencies.get(queryToken) || 0;
                if (tf === 0) {
                    continue;
                }
                const df = this.documentFrequency.get(queryToken) || 0;
                const idf = Math.log((this.totalDocuments - df + 0.5) / (df + 0.5) + 1);
                const docLength = doc.tokens.length;
                const tfNormalized = (tf * (this.k1 + 1)) /
                    (tf +
                        this.k1 *
                            (1 - this.b + this.b * (docLength / this.averageDocLength)));
                score += idf * tfNormalized;
            }
            if (score > 0) {
                scores.push({
                    id: doc.id,
                    score,
                    metadata: doc.metadata,
                });
            }
        }
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topK);
    }
    get size() {
        return this.totalDocuments;
    }
    clear() {
        this.documents = [];
        this.documentFrequency.clear();
        this.averageDocLength = 0;
        this.totalDocuments = 0;
    }
}
exports.BM25Index = BM25Index;
//# sourceMappingURL=bm25.js.map