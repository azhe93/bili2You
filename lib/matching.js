// Bili2You - 标题清洗与相似度工具
// background.js（service worker，通过 importScripts）与 popup.js（通过 <script src>）共用
// 依赖：调用方需要提供一个繁→简转换函数 t2s（OpenCC.Converter({from:'tw', to:'cn'})）

(function (global) {
    'use strict';

    function createMatching(t2s) {
        if (typeof t2s !== 'function') {
            throw new Error('createMatching requires a t2s(traditional->simplified) function');
        }

        // 清理标题用于相似度比对：去括号内容、tag、非中文/数字/字母字符
        function cleanTitle(title) {
            if (!title) return '';
            return t2s(String(title))
                .toLowerCase()
                .replace(/【[^】]*】/g, '')
                .replace(/\[[^\]]*\]/g, '')
                .replace(/（[^）]*）/g, '')
                .replace(/\([^)]*\)/g, '')
                .replace(/#[^\s#]+/g, '')
                .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        // 清理搜索关键词：保留信息量，删掉标点符号
        function cleanSearchKeyword(text, maxLen) {
            if (!text) return '';
            const limit = typeof maxLen === 'number' ? maxLen : 40;
            return t2s(String(text))
                .replace(/【[^】]*】/g, ' ')
                .replace(/\[[^\]]*\]/g, ' ')
                .replace(/（[^）]*）/g, ' ')
                .replace(/\([^)]*\)/g, ' ')
                .replace(/#[^\s#]+/g, ' ')
                .replace(/[!！?？。，、；：""''《》@$%^&*+=|\\/<>~`·]/g, ' ')
                .replace(/[-—_]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, limit);
        }

        // 取标题最有信息量的片段：切分后选最长非纯 ASCII 段
        // 分隔符扩展到常见频道名后缀分隔符：| ｜ / ／ · ・ - —
        function getBestTitlePart(title) {
            if (!title) return '';
            const parts = String(title).split(/[｜|／/·・\-—]+/).map(s => s.trim()).filter(Boolean);
            if (parts.length <= 1) return title;
            const nonAscii = parts.filter(p => !/^[\x00-\x7F]*$/.test(p));
            const pool = nonAscii.length ? nonAscii : parts;
            return pool.reduce((longest, cur) => cur.length > longest.length ? cur : longest);
        }

        // 字符 n-gram（默认 2-gram）Jaccard 相似度
        // - 短串（长度<2）退化为字符集合 Jaccard
        // - 相比原来的字符集合，二元 shingle 能显著降低中文假阳性
        function characterSimilarity(str1, str2) {
            const s1 = String(str1 || '');
            const s2 = String(str2 || '');
            if (!s1 || !s2) return 0;

            function bigrams(s) {
                const set = new Set();
                if (s.length < 2) {
                    for (const ch of s) set.add(ch);
                    return set;
                }
                for (let i = 0; i < s.length - 1; i++) {
                    set.add(s.slice(i, i + 2));
                }
                return set;
            }

            const a = bigrams(s1);
            const b = bigrams(s2);
            if (a.size === 0 || b.size === 0) return 0;

            let inter = 0;
            for (const g of a) if (b.has(g)) inter++;
            const union = a.size + b.size - inter;
            return union > 0 ? inter / union : 0;
        }

        // 词重叠或字符 shingle：适应中英文混合标题
        function calculateSimilarity(str1, str2) {
            const s1 = String(str1 || '');
            const s2 = String(str2 || '');
            const words1 = s1.split(/\s+/).filter(w => w.length > 1);
            const words2 = s2.split(/\s+/).filter(w => w.length > 1);

            if (words1.length === 0 || words2.length === 0) {
                return characterSimilarity(s1, s2);
            }

            const set1 = new Set(words1);
            const set2 = new Set(words2);

            let matches = 0;
            for (const word of set1) {
                if (set2.has(word)) matches++;
            }

            const wordScore = matches / Math.max(set1.size, set2.size);
            // 结合字符 shingle：两者取较大值，避免"分词后完全不重合但字符高度相似"被误判 0
            const charScore = characterSimilarity(s1, s2);
            return Math.max(wordScore, charScore);
        }

        // 在候选视频中挑最佳匹配；单一候选也一样走相似度，不再直接判满分
        function findBestMatch(targetTitle, videos, minScore) {
            const threshold = typeof minScore === 'number' ? minScore : 0.3;
            if (!Array.isArray(videos) || videos.length === 0) return null;

            const cleanTarget = cleanTitle(targetTitle);
            let bestScore = 0;
            let bestVideo = null;

            for (const video of videos) {
                const score = calculateSimilarity(cleanTarget, cleanTitle(video.title));
                if (score > bestScore) {
                    bestScore = score;
                    bestVideo = video;
                }
            }

            if (bestScore >= threshold && bestVideo) {
                return { video: bestVideo, score: bestScore };
            }
            return null;
        }

        return {
            cleanTitle,
            cleanSearchKeyword,
            getBestTitlePart,
            characterSimilarity,
            calculateSimilarity,
            findBestMatch
        };
    }

    global.Bili2YouMatchingFactory = createMatching;
})(typeof self !== 'undefined' ? self : this);
