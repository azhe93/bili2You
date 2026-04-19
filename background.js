// Bili2You Background Service Worker
// 处理B站 API 请求代理，绕过 CORS；负责 WBI 签名、分段弹幕、视频/UP主搜索

importScripts('lib/opencc-t2cn.js');

// 繁→简字符级转换：搜索关键字、弹幕文本、标题比较都统一到简体字面
// t2cn 包不含通用 'from: t'，'tw' 覆盖度最广且不做词组替换，保留用户原意
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

// ============ 常量 ============

const MAX_RETRIES = 5;
const INITIAL_DELAY = 500;

// 每个 tab 的加载版本号，用于取消过期的弹幕加载请求
const tabLoadVersion = {};

const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const BILI_HEADERS = {
    'User-Agent': BILI_UA,
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com'
};
const BILI_SEARCH_HEADERS = {
    'User-Agent': BILI_UA,
    'Referer': 'https://search.bilibili.com/',
    'Origin': 'https://www.bilibili.com'
};

// ============ WBI 签名 ============
// 参考: https://github.com/SocialSisterYi/bilibili-API-collect 的 wbi 签名规范

const mixinKeyEncTab = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52
];

const getMixinKey = (orig) =>
    mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);

// 纯 JS MD5（Web Crypto 不支持 MD5）
function md5(string) {
    function RotateLeft(lValue, iShiftBits) {
        return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
    }
    function AddUnsigned(lX, lY) {
        let lX4, lY4, lX8, lY8, lResult;
        lX8 = lX & 0x80000000;
        lY8 = lY & 0x80000000;
        lX4 = lX & 0x40000000;
        lY4 = lY & 0x40000000;
        lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
        if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
        if (lX4 | lY4) {
            if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
            return lResult ^ 0x40000000 ^ lX8 ^ lY8;
        }
        return lResult ^ lX8 ^ lY8;
    }
    const F = (x, y, z) => (x & y) | (~x & z);
    const G = (x, y, z) => (x & z) | (y & ~z);
    const H = (x, y, z) => x ^ y ^ z;
    const I = (x, y, z) => y ^ (x | ~z);
    const FF = (a, b, c, d, x, s, ac) => AddUnsigned(RotateLeft(AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac)), s), b);
    const GG = (a, b, c, d, x, s, ac) => AddUnsigned(RotateLeft(AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac)), s), b);
    const HH = (a, b, c, d, x, s, ac) => AddUnsigned(RotateLeft(AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac)), s), b);
    const II = (a, b, c, d, x, s, ac) => AddUnsigned(RotateLeft(AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac)), s), b);

    function ConvertToWordArray(s) {
        let lWordCount;
        const lMessageLength = s.length;
        const lNumberOfWords_temp1 = lMessageLength + 8;
        const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
        const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
        const lWordArray = Array(lNumberOfWords - 1);
        let lBytePosition = 0, lByteCount = 0;
        while (lByteCount < lMessageLength) {
            lWordCount = (lByteCount - (lByteCount % 4)) / 4;
            lBytePosition = (lByteCount % 4) * 8;
            lWordArray[lWordCount] = (lWordArray[lWordCount] || 0) | (s.charCodeAt(lByteCount) << lBytePosition);
            lByteCount++;
        }
        lWordCount = (lByteCount - (lByteCount % 4)) / 4;
        lBytePosition = (lByteCount % 4) * 8;
        lWordArray[lWordCount] = (lWordArray[lWordCount] || 0) | (0x80 << lBytePosition);
        lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
        lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
        return lWordArray;
    }

    function WordToHex(lValue) {
        let s = '';
        for (let lCount = 0; lCount <= 3; lCount++) {
            const lByte = (lValue >>> (lCount * 8)) & 255;
            const tmp = '0' + lByte.toString(16);
            s += tmp.substr(tmp.length - 2, 2);
        }
        return s;
    }

    function Utf8Encode(s) {
        s = s.replace(/\r\n/g, '\n');
        let out = '';
        for (let n = 0; n < s.length; n++) {
            const c = s.charCodeAt(n);
            if (c < 128) out += String.fromCharCode(c);
            else if (c < 2048) {
                out += String.fromCharCode((c >> 6) | 192);
                out += String.fromCharCode((c & 63) | 128);
            } else {
                out += String.fromCharCode((c >> 12) | 224);
                out += String.fromCharCode(((c >> 6) & 63) | 128);
                out += String.fromCharCode((c & 63) | 128);
            }
        }
        return out;
    }

    const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
    const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
    const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
    const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

    const x = ConvertToWordArray(Utf8Encode(string));
    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

    for (let k = 0; k < x.length; k += 16) {
        const AA = a, BB = b, CC = c, DD = d;
        a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478); d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756);
        c = FF(c, d, a, b, x[k + 2], S13, 0x242070db); b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
        a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf); d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a);
        c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613); b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
        a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8); d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af);
        c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1); b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
        a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122); d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193);
        c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e); b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
        a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562); d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340);
        c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51); b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa);
        a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d); d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
        c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681); b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
        a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6); d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6);
        c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87); b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
        a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905); d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8);
        c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9); b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
        a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942); d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681);
        c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122); b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
        a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44); d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9);
        c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60); b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
        a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6); d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa);
        c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085); b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
        a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039); d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5);
        c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8); b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665);
        a = II(a, b, c, d, x[k + 0], S41, 0xf4292244); d = II(d, a, b, c, x[k + 7], S42, 0x432aff97);
        c = II(c, d, a, b, x[k + 14], S43, 0xab9423a7); b = II(b, c, d, a, x[k + 5], S44, 0xfc93a039);
        a = II(a, b, c, d, x[k + 12], S41, 0x655b59c3); d = II(d, a, b, c, x[k + 3], S42, 0x8f0ccc92);
        c = II(c, d, a, b, x[k + 10], S43, 0xffeff47d); b = II(b, c, d, a, x[k + 1], S44, 0x85845dd1);
        a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f); d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0);
        c = II(c, d, a, b, x[k + 6], S43, 0xa3014314); b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
        a = II(a, b, c, d, x[k + 4], S41, 0xf7537e82); d = II(d, a, b, c, x[k + 11], S42, 0xbd3af235);
        c = II(c, d, a, b, x[k + 2], S43, 0x2ad7d2bb); b = II(b, c, d, a, x[k + 9], S44, 0xeb86d391);
        a = AddUnsigned(a, AA); b = AddUnsigned(b, BB);
        c = AddUnsigned(c, CC); d = AddUnsigned(d, DD);
    }
    return (WordToHex(a) + WordToHex(b) + WordToHex(c) + WordToHex(d)).toLowerCase();
}

// WBI 参数签名
function encWbi(params, img_key, sub_key) {
    const mixin_key = getMixinKey(img_key + sub_key);
    const curr_time = Math.round(Date.now() / 1000);
    const chr_filter = /[!'()*]/g;

    const safe = {};
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
            safe[k] = String(v).replace(chr_filter, '');
        }
    }
    safe.wts = curr_time;

    const query = Object.keys(safe).sort()
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(safe[k])}`)
        .join('&');

    return query + '&w_rid=' + md5(query + mixin_key);
}

// WBI key 缓存（30 分钟）
let wbiKeysCache = { keys: null, time: 0 };
const WBI_CACHE_TTL = 30 * 60 * 1000;

async function getWbiKeys() {
    if (wbiKeysCache.keys && Date.now() - wbiKeysCache.time < WBI_CACHE_TTL) {
        return wbiKeysCache.keys;
    }
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: BILI_HEADERS
    });
    const data = await response.json();
    if (!data.data || !data.data.wbi_img) {
        throw new Error('无法获取 WBI Keys');
    }
    const { img_url, sub_url } = data.data.wbi_img;
    const img_key = img_url.slice(img_url.lastIndexOf('/') + 1, img_url.lastIndexOf('.'));
    const sub_key = sub_url.slice(sub_url.lastIndexOf('/') + 1, sub_url.lastIndexOf('.'));
    const keys = { img_key, sub_key };
    wbiKeysCache = { keys, time: Date.now() };
    return keys;
}

// ============ Protobuf 最小化解析（DmSegMobileReply） ============
// 协议: https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/danmaku/danmaku_proto.md
// DanmakuElem 字段：1=id, 2=progress(ms), 3=mode, 4=fontsize, 5=color, 7=content

function parseDanmakuProto(buffer) {
    const view = new Uint8Array(buffer);
    let pos = 0;
    const decoder = new TextDecoder('utf-8');
    const result = [];

    function readVarint() {
        let val = 0, shift = 0, byte;
        do {
            byte = view[pos++];
            // 使用乘幂避免 JS 位运算 32 位溢出；52 位内对弹幕字段足够
            val += (byte & 0x7f) * Math.pow(2, shift);
            shift += 7;
            if (shift >= 64) break;
        } while (byte & 0x80);
        return val;
    }

    function skipField(wireType) {
        if (wireType === 0) readVarint();
        else if (wireType === 1) pos += 8;
        else if (wireType === 2) {
            // 注意：不能写成 `pos += readVarint()` —— 左侧 pos 会先被求值，
            // readVarint 内对 pos 的推进会被覆盖，导致偏移。
            const len = readVarint();
            pos += len;
        }
        else if (wireType === 5) pos += 4;
        else throw new Error(`未知 wire type: ${wireType}`);
    }

    function parseElem(endPos) {
        const d = { progress: 0, mode: 1, fontsize: 25, color: 0xffffff, content: '' };
        while (pos < endPos) {
            const tag = readVarint();
            const field = tag >>> 3;
            const wire = tag & 7;
            if (wire === 0) {
                const v = readVarint();
                if (field === 2) d.progress = v;
                else if (field === 3) d.mode = v;
                else if (field === 4) d.fontsize = v;
                else if (field === 5) d.color = v;
            } else if (wire === 2) {
                const len = readVarint();
                if (field === 7) {
                    d.content = decoder.decode(view.subarray(pos, pos + len));
                }
                pos += len;
            } else {
                skipField(wire);
            }
        }
        return d.content ? d : null;
    }

    while (pos < view.length) {
        const tag = readVarint();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (field === 1 && wire === 2) {
            const len = readVarint();
            const end = pos + len;
            const elem = parseElem(end);
            pos = end;
            if (elem) result.push(elem);
        } else {
            skipField(wire);
        }
    }

    return result;
}

// ============ 通用工具 ============

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: { ...BILI_HEADERS, ...(options.headers || {}) }
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response;
        } catch (error) {
            lastError = error;
            console.log(`Bili2You: Attempt ${attempt}/${retries} failed - ${error.message}`);
            if (attempt < retries) {
                const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}

// 清理搜索关键词：去除【】、#tag、标点，收敛空白
function cleanSearchKeyword(text) {
    if (!text) return '';
    return t2s(text)
        .replace(/【[^】]*】/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/（[^）]*）/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/#[^\s#]+/g, ' ')
        .replace(/[!！?？。，、；：""''《》@$%^&*+=|\\/<>~`·]/g, ' ')
        .replace(/[-—_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 40);
}

// 取标题最佳部分（竖线/空格切分后选最长非纯英数段）
function getBestTitlePart(title) {
    if (!title) return '';
    const parts = title.split(/[｜|]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) return title;
    const nonAscii = parts.filter(p => !/^[\x00-\x7F]*$/.test(p));
    const pool = nonAscii.length ? nonAscii : parts;
    return pool.reduce((longest, cur) => cur.length > longest.length ? cur : longest);
}

// ============ 消息处理 ============

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'searchVideos') {
        searchBilibiliVideos(request.keyword)
            .then(sendResponse)
            .catch(error => sendResponse({ error: error.message }));
        return true;
    }

    if (request.action === 'searchUploaders') {
        searchBilibiliUploaders(request.keyword)
            .then(sendResponse)
            .catch(error => sendResponse({ error: error.message }));
        return true;
    }

    if (request.action === 'getVideoInfo') {
        getVideoInfo(request.bvid)
            .then(sendResponse)
            .catch(error => sendResponse({ error: error.message }));
        return true;
    }

    if (request.action === 'getDanmaku') {
        getDanmaku(request.cid, request.aid, request.duration)
            .then(sendResponse)
            .catch(error => sendResponse({ error: error.message }));
        return true;
    }

    if (request.action === 'loadDanmakuToTab') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: 'loadDanmaku',
                    danmaku: request.danmaku,
                    offset: request.offset || 0,
                    videoId: request.videoId
                });
            }
        });
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'updateSettings') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: 'updateSettings',
                    settings: request.settings
                });
            }
        });
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'cancelAutoLoad') {
        const tabId = sender.tab?.id;
        if (tabId) {
            tabLoadVersion[tabId] = (tabLoadVersion[tabId] || 0) + 1;
            console.log(`Bili2You: Cancelled in-flight auto-load for tab ${tabId}, new version ${tabLoadVersion[tabId]}`);
        }
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'pageInfoReady') {
        const tabId = sender.tab?.id;
        if (tabId && request.pageInfo) {
            tabLoadVersion[tabId] = (tabLoadVersion[tabId] || 0) + 1;
            const myVersion = tabLoadVersion[tabId];

            tryAutoLoadDanmaku(tabId, request.pageInfo, myVersion)
                .then(result => sendResponse(result))
                .catch(error => {
                    console.log('Bili2You: Auto-load failed -', error.message);
                    sendResponse({ success: false, error: error.message });
                });
        } else {
            sendResponse({ success: false, error: 'Invalid request' });
        }
        return true;
    }
});

// ============ 自动加载弹幕逻辑 ============

async function tryAutoLoadDanmaku(tabId, pageInfo, version) {
    const { channelName, videoTitle, videoId } = pageInfo;

    function isStale() {
        return tabLoadVersion[tabId] !== version;
    }

    if (!channelName || !videoTitle) {
        return { success: false, reason: 'missing_info' };
    }

    console.log(`Bili2You: 自动加载 channel="${channelName}", video="${videoTitle}" (v${version})`);

    const data = await chrome.storage.local.get(['uploaderMappings', 'settings']);
    if (isStale()) return { success: false, reason: 'stale' };

    const uploaderMappings = data.uploaderMappings || {};
    const settings = data.settings || {};

    const uploader = uploaderMappings[channelName];
    if (!uploader) {
        console.log(`Bili2You: 频道 "${channelName}" 未映射`);
        return { success: false, reason: 'no_mapping' };
    }

    console.log(`Bili2You: 映射到 UP "${uploader.name}" (mid=${uploader.mid})`);

    // 优先从 UP 主空间搜索；失败则降级为全站搜索
    const titleForSearch = getBestTitlePart(videoTitle);
    let searchResult = { results: [] };
    try {
        if (uploader.mid) {
            searchResult = await searchBilibiliVideosByUploader(uploader.mid, titleForSearch);
        }
        if (!searchResult.results || searchResult.results.length === 0) {
            console.log('Bili2You: 空间搜索无结果，降级为全站搜索');
            searchResult = await searchBilibiliVideos(`${uploader.name} ${titleForSearch}`);
        }
    } catch (e) {
        console.warn('Bili2You: 搜索失败，尝试全站搜索', e.message);
        searchResult = await searchBilibiliVideos(`${uploader.name} ${titleForSearch}`);
    }

    if (isStale()) return { success: false, reason: 'stale' };

    if (!searchResult.results || searchResult.results.length === 0) {
        return { success: false, reason: 'no_match' };
    }

    let bestMatch;
    if (searchResult.results.length === 1) {
        bestMatch = { video: searchResult.results[0], score: 1.0 };
    } else {
        bestMatch = findBestMatch(videoTitle, searchResult.results);
    }

    if (!bestMatch) {
        return { success: false, reason: 'low_score' };
    }

    console.log(`Bili2You: 最佳匹配 "${bestMatch.video.title}" 匹配度 ${Math.round(bestMatch.score * 100)}%`);

    if (bestMatch.score < 0.8) {
        return { success: false, reason: 'low_score', score: bestMatch.score };
    }

    const videoInfo = await getVideoInfo(bestMatch.video.bvid);
    if (isStale()) return { success: false, reason: 'stale' };

    if (!videoInfo.cid) {
        return { success: false, reason: 'no_cid' };
    }

    const danmakuData = await getDanmaku(videoInfo.cid, videoInfo.aid, videoInfo.duration);
    if (isStale()) return { success: false, reason: 'stale' };

    if (!danmakuData.danmaku || danmakuData.danmaku.length === 0) {
        return { success: false, reason: 'no_danmaku' };
    }

    console.log(`Bili2You: 自动加载 ${danmakuData.danmaku.length} 条弹幕`);

    const offset = settings.offset || 0;
    await chrome.tabs.sendMessage(tabId, {
        action: 'loadDanmaku',
        danmaku: danmakuData.danmaku,
        offset: offset,
        videoId: videoId
    });

    return {
        success: true,
        video: bestMatch.video.title,
        danmakuCount: danmakuData.danmaku.length,
        score: bestMatch.score
    };
}

function findBestMatch(targetTitle, videos) {
    let bestScore = 0;
    let bestVideo = null;
    const cleanTarget = cleanTitle(targetTitle);

    for (const video of videos) {
        const score = calculateSimilarity(cleanTarget, cleanTitle(video.title));
        if (score > bestScore) {
            bestScore = score;
            bestVideo = video;
        }
    }

    if (bestScore >= 0.3) return { video: bestVideo, score: bestScore };
    return null;
}

function cleanTitle(title) {
    return t2s(title)
        .toLowerCase()
        .replace(/【[^】]*】/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/（[^）]*）/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/#[^\s#]+/g, '')
        .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, '')
        .trim();
}

function calculateSimilarity(str1, str2) {
    const words1 = str1.split(/\s+/).filter(w => w.length > 1);
    const words2 = str2.split(/\s+/).filter(w => w.length > 1);

    if (words1.length === 0 || words2.length === 0) {
        return characterSimilarity(str1, str2);
    }

    const set1 = new Set(words1);
    const set2 = new Set(words2);

    let matches = 0;
    for (const word of set1) {
        if (set2.has(word)) matches++;
    }

    return matches / Math.max(set1.size, set2.size);
}

function characterSimilarity(str1, str2) {
    const chars1 = new Set(str1.split(''));
    const chars2 = new Set(str2.split(''));
    let intersection = 0;
    for (const char of chars1) {
        if (chars2.has(char)) intersection++;
    }
    const union = chars1.size + chars2.size - intersection;
    return union > 0 ? intersection / union : 0;
}

// ============ B站 API ============

// 全站视频搜索（WBI 签名）
async function searchBilibiliVideos(keyword) {
    const cleaned = cleanSearchKeyword(keyword);
    const wbi = await getWbiKeys();
    const params = {
        search_type: 'video',
        keyword: cleaned,
        page: 1,
        order: '',
        duration: '',
        tids: '',
        web_location: 1430654
    };
    const query = encWbi(params, wbi.img_key, wbi.sub_key);
    const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`;

    const response = await fetchWithRetry(url, { headers: BILI_SEARCH_HEADERS });
    const data = await response.json();

    if (data.code !== 0) {
        throw new Error(data.message || '搜索失败');
    }

    const results = (data.data.result || []).slice(0, 20).map(video => ({
        bvid: video.bvid,
        aid: video.aid,
        title: (video.title || '').replace(/<[^>]+>/g, ''),
        author: video.author,
        mid: video.mid,
        pic: video.pic && video.pic.startsWith('//') ? 'https:' + video.pic : (video.pic || ''),
        duration: video.duration,
        play: video.play,
        danmaku: video.video_review
    }));

    return { results };
}

// 空间搜索：在指定 UP 的投稿中按关键词搜（WBI 签名）
async function searchBilibiliVideosByUploader(mid, keyword) {
    const cleaned = cleanSearchKeyword(keyword);
    const wbi = await getWbiKeys();
    const params = {
        mid: mid,
        ps: 30,
        tid: 0,
        pn: 1,
        keyword: cleaned,
        order: 'pubdate',
        web_location: 1550101
    };
    const query = encWbi(params, wbi.img_key, wbi.sub_key);
    const url = `https://api.bilibili.com/x/space/wbi/arc/search?${query}`;

    const response = await fetchWithRetry(url, { headers: BILI_HEADERS });
    const data = await response.json();

    if (data.code !== 0) {
        throw new Error(data.message || '空间搜索失败');
    }

    const list = (data.data && data.data.list && data.data.list.vlist) || [];
    const results = list.map(v => ({
        bvid: v.bvid,
        aid: v.aid,
        title: v.title || '',
        author: v.author,
        mid: v.mid,
        pic: v.pic && v.pic.startsWith('//') ? 'https:' + v.pic : (v.pic || ''),
        duration: v.length,
        play: v.play,
        danmaku: v.video_review,
        created: v.created
    }));

    return { results };
}

// 搜索 UP 主（WBI 签名）
async function searchBilibiliUploaders(keyword) {
    const wbi = await getWbiKeys();
    const params = {
        search_type: 'bili_user',
        keyword: t2s(keyword || ''),
        page: 1,
        order: '',
        order_sort: '',
        user_type: '',
        web_location: 1430654
    };
    const query = encWbi(params, wbi.img_key, wbi.sub_key);
    const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`;

    const response = await fetchWithRetry(url, { headers: BILI_SEARCH_HEADERS });
    const data = await response.json();

    if (data.code !== 0) {
        throw new Error(data.message || '搜索UP主失败');
    }

    const results = (data.data.result || []).slice(0, 10).map(user => ({
        mid: user.mid,
        name: user.uname,
        face: user.upic && user.upic.startsWith('//') ? 'https:' + user.upic : (user.upic || ''),
        fans: user.fans,
        videos: user.videos,
        sign: user.usign
    }));

    return { results };
}

// 获取视频信息（aid/cid/duration）
async function getVideoInfo(bvid) {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const response = await fetch(url, { headers: BILI_HEADERS });
    const data = await response.json();

    if (data.code !== 0) {
        throw new Error(data.message || '获取视频信息失败');
    }

    return {
        bvid: data.data.bvid,
        aid: data.data.aid,
        cid: data.data.cid,
        title: data.data.title,
        duration: data.data.duration,
        pages: data.data.pages
    };
}

// 获取弹幕（分段 protobuf，WBI 签名；旧的 list.so XML 已限流/停用）
async function getDanmaku(cid, aid, duration) {
    if (!cid) throw new Error('缺少 cid');

    const wbi = await getWbiKeys();
    const segDurationSec = 360; // 每段 6 分钟
    const segmentCount = Math.max(1, Math.ceil((Number(duration) || segDurationSec) / segDurationSec));

    const all = [];
    for (let i = 1; i <= segmentCount; i++) {
        try {
            const params = {
                type: 1,
                oid: cid,
                segment_index: i,
                pid: aid,
                web_location: 1315873
            };
            const query = encWbi(params, wbi.img_key, wbi.sub_key);
            const url = `https://api.bilibili.com/x/v2/dm/wbi/web/seg.so?${query}`;
            const response = await fetch(url, { headers: BILI_HEADERS });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const buffer = await response.arrayBuffer();
            // 空段会返回 0 字节，直接跳过
            if (buffer.byteLength === 0) continue;
            const elems = parseDanmakuProto(buffer);
            all.push(...elems);
            if (i < segmentCount) {
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (e) {
            console.warn(`Bili2You: 第 ${i} 段弹幕获取失败`, e.message);
        }
    }

    const danmaku = all
        .filter(d => d.content && typeof d.progress === 'number')
        .map(d => ({
            time: d.progress / 1000,
            mode: d.mode || 1,
            size: d.fontsize || 25,
            color: d.color || 0xffffff,
            text: d.content
        }))
        .sort((a, b) => a.time - b.time);

    return { danmaku };
}

console.log('Bili2You background service worker loaded');
