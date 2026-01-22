// Bili2You Background Service Worker
// 处理API请求代理，避免CORS限制

// 重试机制 - 最多重试5次，指数退避
const MAX_RETRIES = 5;
const INITIAL_DELAY = 500; // 初始延迟500ms

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://www.bilibili.com',
                    ...options.headers
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return response;
        } catch (error) {
            lastError = error;
            console.log(`Bili2You: Attempt ${attempt}/${retries} failed - ${error.message}`);

            if (attempt < retries) {
                // 指数退避: 500ms, 1000ms, 2000ms, 4000ms
                const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

// 监听来自content script和popup的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'searchVideos') {
        searchBilibiliVideos(request.keyword)
            .then(sendResponse)
            .catch(error => sendResponse({ error: error.message }));
        return true; // 保持消息通道打开
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
        getDanmaku(request.cid)
            .then(sendResponse)
            .catch(error => sendResponse({ error: error.message }));
        return true;
    }

    if (request.action === 'loadDanmakuToTab') {
        // 向当前YouTube标签页发送弹幕数据
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: 'loadDanmaku',
                    danmaku: request.danmaku,
                    offset: request.offset || 0
                });
            }
        });
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'updateSettings') {
        // 向当前YouTube标签页发送设置更新
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

    // 自动加载弹幕 - 当content script检测到YouTube视频页面时
    if (request.action === 'pageInfoReady') {
        const tabId = sender.tab?.id;
        if (tabId && request.pageInfo) {
            tryAutoLoadDanmaku(tabId, request.pageInfo)
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

// 尝试自动加载弹幕
async function tryAutoLoadDanmaku(tabId, pageInfo) {
    const { channelName, videoTitle, videoId } = pageInfo;

    if (!channelName || !videoTitle) {
        console.log('Bili2You: Missing page info, skipping auto-load');
        return { success: false, reason: 'missing_info' };
    }

    console.log(`Bili2You: Checking auto-load for channel "${channelName}", video "${videoTitle}"`);

    // 从storage获取UP主映射
    const data = await chrome.storage.local.get(['uploaderMappings', 'settings']);
    const uploaderMappings = data.uploaderMappings || {};
    const settings = data.settings || {};

    // 检查是否有该频道的映射
    const uploader = uploaderMappings[channelName];
    if (!uploader) {
        console.log(`Bili2You: No mapping found for channel "${channelName}", skipping auto-load`);
        return { success: false, reason: 'no_mapping' };
    }

    console.log(`Bili2You: Found mapping to Bilibili UP "${uploader.name}", searching for video...`);

    // 搜索匹配视频
    const cleanedTitle = sanitizeSearchKeyword(videoTitle);
    const searchKeyword = `${uploader.name} ${cleanedTitle}`;

    const searchResult = await searchBilibiliVideos(searchKeyword);
    if (!searchResult.results || searchResult.results.length === 0) {
        console.log('Bili2You: No matching videos found');
        return { success: false, reason: 'no_match' };
    }

    // 查找最佳匹配
    let bestMatch = null;

    // 如果只有一个结果，直接使用
    if (searchResult.results.length === 1) {
        bestMatch = { video: searchResult.results[0], score: 1.0 };
        console.log('Bili2You: Only one result, using directly');
    } else {
        bestMatch = findBestMatch(videoTitle, searchResult.results);
    }

    if (!bestMatch) {
        console.log('Bili2You: No suitable match found above threshold');
        return { success: false, reason: 'low_score' };
    }

    console.log(`Bili2You: Best match "${bestMatch.video.title}" with score ${Math.round(bestMatch.score * 100)}%`);

    // 只有匹配度>=80%才自动加载
    if (bestMatch.score < 0.8) {
        console.log('Bili2You: Match score below 80%, skipping auto-load');
        return { success: false, reason: 'low_score', score: bestMatch.score };
    }

    // 获取视频信息以获取cid
    const videoInfo = await getVideoInfo(bestMatch.video.bvid);
    if (!videoInfo.cid) {
        console.log('Bili2You: Failed to get video cid');
        return { success: false, reason: 'no_cid' };
    }

    // 获取弹幕
    const danmakuData = await getDanmaku(videoInfo.cid);
    if (!danmakuData.danmaku || danmakuData.danmaku.length === 0) {
        console.log('Bili2You: No danmaku found');
        return { success: false, reason: 'no_danmaku' };
    }

    console.log(`Bili2You: Auto-loading ${danmakuData.danmaku.length} danmaku...`);

    // 发送弹幕到content script
    const offset = settings.offset || 0;
    await chrome.tabs.sendMessage(tabId, {
        action: 'loadDanmaku',
        danmaku: danmakuData.danmaku,
        offset: offset
    });

    console.log('Bili2You: Auto-load complete!');
    return {
        success: true,
        video: bestMatch.video.title,
        danmakuCount: danmakuData.danmaku.length,
        score: bestMatch.score
    };
}

// 查找最佳匹配视频
function findBestMatch(targetTitle, videos) {
    let bestScore = 0;
    let bestVideo = null;

    const cleanTarget = cleanTitle(targetTitle);

    for (const video of videos) {
        const cleanVideoTitle = cleanTitle(video.title);
        const score = calculateSimilarity(cleanTarget, cleanVideoTitle);

        if (score > bestScore) {
            bestScore = score;
            bestVideo = video;
        }
    }

    // 只返回分数高于阈值的结果
    if (bestScore >= 0.3) {
        return { video: bestVideo, score: bestScore };
    }

    return null;
}

// 清理标题
function cleanTitle(title) {
    return title
        .toLowerCase()
        .replace(/【.*?】/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/（.*?）/g, '')
        .replace(/\(.*?\)/g, '')
        .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, '')
        .trim();
}

// 清理搜索关键词
function sanitizeSearchKeyword(text) {
    return text
        .replace(/【.*?】/g, ' ')
        .replace(/\[.*?\]/g, ' ')
        .replace(/（.*?）/g, ' ')
        .replace(/\(.*?\)/g, ' ')
        .replace(/[!！?？。，、；：""''《》【】\[\]()（）@#$%^&*+=|\\/<>~`·]/g, ' ')
        .replace(/[-—_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 30);
}

// 计算相似度
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

// 字符级别相似度（适用于中文）
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

// ============ B站API函数 ============



// 搜索B站视频
async function searchBilibiliVideos(keyword) {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}`;

    const response = await fetchWithRetry(url);
    const data = await response.json();

    if (data.code !== 0) {
        throw new Error(data.message || '搜索失败');
    }

    // 提取关键信息
    const results = (data.data.result || []).map(video => ({
        bvid: video.bvid,
        aid: video.aid,
        title: video.title.replace(/<[^>]+>/g, ''), // 移除HTML标签（高亮）
        author: video.author,
        mid: video.mid, // UP主ID
        pic: video.pic.startsWith('//') ? 'https:' + video.pic : video.pic,
        duration: video.duration,
        play: video.play,
        danmaku: video.video_review
    }));

    return { results };
}

// 搜索B站UP主
async function searchBilibiliUploaders(keyword) {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(keyword)}`;

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.bilibili.com'
        }
    });

    const data = await response.json();

    if (data.code !== 0) {
        throw new Error(data.message || '搜索UP主失败');
    }

    // 提取UP主信息
    const results = (data.data.result || []).map(user => ({
        mid: user.mid,
        name: user.uname,
        face: user.upic.startsWith('//') ? 'https:' + user.upic : user.upic,
        fans: user.fans,
        videos: user.videos,
        sign: user.usign
    }));

    return { results };
}

// 获取视频信息（包括cid）
async function getVideoInfo(bvid) {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.bilibili.com'
        }
    });

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
        pages: data.data.pages // 分P信息
    };
}

// 获取弹幕数据
async function getDanmaku(cid) {
    const url = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`;

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.bilibili.com'
        }
    });

    // 弹幕数据是经过deflate压缩的，需要解压
    const buffer = await response.arrayBuffer();
    const text = await decompressData(buffer);

    // 解析XML
    const danmakuList = parseDanmakuXML(text);

    return { danmaku: danmakuList };
}

// 解压deflate数据
async function decompressData(buffer) {
    try {
        // 尝试使用DecompressionStream
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(new Uint8Array(buffer));
        writer.close();

        const reader = ds.readable.getReader();
        const chunks = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }

        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return new TextDecoder('utf-8').decode(result);
    } catch (e) {
        // 如果解压失败，尝试直接解析（可能是未压缩的XML）
        return new TextDecoder('utf-8').decode(buffer);
    }
}

// 解析弹幕XML (使用正则表达式，因为Service Worker不支持DOMParser)
function parseDanmakuXML(xmlString) {
    const danmakuList = [];

    // 匹配 <d p="...">内容</d> 格式
    const regex = /<d\s+p="([^"]+)"[^>]*>([^<]*)<\/d>/g;
    let match;

    while ((match = regex.exec(xmlString)) !== null) {
        const p = match[1];
        const text = match[2];

        if (!p || !text) continue;

        const parts = p.split(',');
        // p属性格式: 时间,模式,字号,颜色,发送时间,弹幕池,用户ID,弹幕ID
        const danmaku = {
            time: parseFloat(parts[0]),      // 出现时间（秒）
            mode: parseInt(parts[1]),         // 模式: 1-3滚动, 4底部, 5顶部
            size: parseInt(parts[2]),         // 字号
            color: parseInt(parts[3]),        // 颜色（十进制）
            text: decodeXMLEntities(text)     // 弹幕内容（解码HTML实体）
        };

        danmakuList.push(danmaku);
    }

    // 按时间排序
    danmakuList.sort((a, b) => a.time - b.time);

    return danmakuList;
}

// 解码XML实体
function decodeXMLEntities(text) {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
        .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

console.log('Bili2You background service worker loaded');
