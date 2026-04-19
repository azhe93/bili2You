// Bili2You Popup Script - Auto-Match Feature

// 繁→简字符级转换：与 background 保持一致，用 tw→cn 覆盖最常见的繁体输入
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

document.addEventListener('DOMContentLoaded', async () => {
    // DOM Elements - Page Info
    const channelNameEl = document.getElementById('channelName');
    const videoTitleEl = document.getElementById('videoTitle');
    const pageInfoSection = document.getElementById('pageInfoSection');
    const notYouTube = document.getElementById('notYouTube');

    // DOM Elements - Uploader Mapping
    const uploaderSection = document.getElementById('uploaderSection');
    const mappedUploader = document.getElementById('mappedUploader');
    const mappedUploaderAvatar = document.getElementById('mappedUploaderAvatar');
    const mappedUploaderName = document.getElementById('mappedUploaderName');
    const changeUploader = document.getElementById('changeUploader');
    const uploaderSearch = document.getElementById('uploaderSearch');
    const uploaderSearchInput = document.getElementById('uploaderSearchInput');
    const uploaderSearchBtn = document.getElementById('uploaderSearchBtn');
    const uploaderResults = document.getElementById('uploaderResults');

    // DOM Elements - Video Match
    const videoMatchSection = document.getElementById('videoMatchSection');
    const matchStatus = document.getElementById('matchStatus');
    const matchedVideo = document.getElementById('matchedVideo');
    const matchedThumb = document.getElementById('matchedThumb');
    const matchedTitle = document.getElementById('matchedTitle');
    const matchedScore = document.getElementById('matchedScore');
    const matchedDanmaku = document.getElementById('matchedDanmaku');
    const changeVideo = document.getElementById('changeVideo');
    const videoSearch = document.getElementById('videoSearch');
    const videoSearchInput = document.getElementById('videoSearchInput');
    const videoSearchBtn = document.getElementById('videoSearchBtn');
    const videoResults = document.getElementById('videoResults');
    const loadDanmakuBtn = document.getElementById('loadDanmakuBtn');

    // DOM Elements - Status
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');

    // DOM Elements - Settings
    const toggleSettings = document.getElementById('toggleSettings');
    const settingsPanel = document.getElementById('settingsPanel');
    const offsetInput = document.getElementById('offsetInput');
    const offsetMinus = document.getElementById('offsetMinus');
    const offsetPlus = document.getElementById('offsetPlus');
    const fontSize = document.getElementById('fontSize');
    const fontSizeValue = document.getElementById('fontSizeValue');
    const opacity = document.getElementById('opacity');
    const opacityValue = document.getElementById('opacityValue');
    const speed = document.getElementById('speed');
    const speedValue = document.getElementById('speedValue');
    const screenHeight = document.getElementById('screenHeight');
    const screenHeightValue = document.getElementById('screenHeightValue');
    const density = document.getElementById('density');
    const showDanmaku = document.getElementById('showDanmaku');

    // State
    let currentPageInfo = null;
    let currentUploader = null;
    let currentMatchedVideo = null;
    let currentDanmaku = null;
    let uploaderMappings = {}; // channelName -> biliUploader

    // Initialize
    await loadSettings();
    await loadMappings();
    await loadCurrentState();
    await initPage();

    // Check if on YouTube
    async function initPage() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
                showNotYouTube();
                return;
            }

            // Get page info from content script
            showLoading('获取页面信息...');

            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' });

            if (response && response.channelName) {
                currentPageInfo = response;
                displayPageInfo(response);

                // 检查是否有保存的状态（当前视频已加载弹幕）
                if (window._savedVideoState && window._savedVideoState.videoId === response.videoId) {
                    const state = window._savedVideoState;
                    currentMatchedVideo = state.video;
                    currentDanmaku = { length: state.danmakuCount }; // 仅用于显示数量
                    currentUploader = uploaderMappings[response.channelName];
                    console.log('Bili2You: Restored saved state for video', response.videoId);
                }

                await checkUploaderMapping(response.channelName);
            } else {
                // Retry after a short delay
                setTimeout(async () => {
                    const retryResponse = await chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' });
                    if (retryResponse && retryResponse.channelName) {
                        currentPageInfo = retryResponse;
                        displayPageInfo(retryResponse);
                        await checkUploaderMapping(retryResponse.channelName);
                    }
                }, 1500);
            }

            hideLoading();
        } catch (error) {
            console.error('Init error:', error);
            hideLoading();
            showNotYouTube();
        }
    }

    function showNotYouTube() {
        pageInfoSection.classList.add('hidden');
        uploaderSection.classList.add('hidden');
        videoMatchSection.classList.add('hidden');
        notYouTube.classList.remove('hidden');
    }

    function displayPageInfo(info) {
        channelNameEl.textContent = info.channelName || '未知';
        videoTitleEl.textContent = info.videoTitle || '未知';
        videoTitleEl.title = info.videoTitle || '';

        pageInfoSection.classList.remove('hidden');
        uploaderSection.classList.remove('hidden');
        notYouTube.classList.add('hidden');

        // Pre-fill search inputs (清理特殊字符)
        uploaderSearchInput.value = info.channelName || '';
        videoSearchInput.value = sanitizeSearchKeyword(info.videoTitle || '');
    }

    // Check if we have a cached uploader mapping
    async function checkUploaderMapping(channelName) {
        // 如果当前视频已加载弹幕，直接显示已匹配的UP主和视频
        if (currentDanmaku && currentMatchedVideo && currentPageInfo) {
            displayMappedUploader(currentUploader || uploaderMappings[channelName]);
            displayMatchedVideo(currentMatchedVideo, 1);
            return;
        }

        if (uploaderMappings[channelName]) {
            currentUploader = uploaderMappings[channelName];
            displayMappedUploader(currentUploader);
            await autoMatchVideo();
        } else {
            // Show search for uploader
            mappedUploader.classList.add('hidden');
            uploaderSearch.classList.remove('hidden');

            // Auto-search for uploader
            await searchUploader(channelName);
        }
    }

    function displayMappedUploader(uploader) {
        mappedUploaderAvatar.src = uploader.face || '';
        mappedUploaderAvatar.onerror = () => {
            mappedUploaderAvatar.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect fill="%2300a1d6" width="32" height="32" rx="16"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="16">👤</text></svg>';
        };
        mappedUploaderName.textContent = uploader.name;
        mappedUploader.classList.remove('hidden');
        uploaderSearch.classList.add('hidden');
        uploaderResults.classList.add('hidden');
        videoMatchSection.classList.remove('hidden');
    }

    // Search for Bilibili uploader
    async function searchUploader(keyword) {
        if (!keyword) return;
        keyword = t2s(keyword);

        showLoading('搜索UP主...');

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'searchUploaders',
                keyword: keyword
            });

            if (response.error) {
                throw new Error(response.error);
            }

            displayUploaderResults(response.results);
        } catch (error) {
            console.error('Search uploader error:', error);
            uploaderResults.innerHTML = `<div class="error">搜索失败</div>`;
            uploaderResults.classList.remove('hidden');
        } finally {
            hideLoading();
        }
    }

    function displayUploaderResults(results) {
        uploaderResults.innerHTML = '';

        if (!results || results.length === 0) {
            uploaderResults.innerHTML = '<div class="no-results">未找到UP主</div>';
            uploaderResults.classList.remove('hidden');
            return;
        }

        results.slice(0, 5).forEach(uploader => {
            const item = document.createElement('div');
            item.className = 'uploader-item';
            item.innerHTML = `
                <img class="uploader-avatar" src="${uploader.face}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 28 28%22><rect fill=%22%2300a1d6%22 width=%2228%22 height=%2228%22 rx=%2214%22/></svg>'">
                <span class="name">${escapeHtml(uploader.name)}</span>
                <span class="fans">${formatNumber(uploader.fans)} 粉丝</span>
            `;

            item.addEventListener('click', () => selectUploader(uploader));
            uploaderResults.appendChild(item);
        });

        uploaderResults.classList.remove('hidden');
    }

    async function selectUploader(uploader) {
        currentUploader = uploader;

        // Save mapping
        if (currentPageInfo && currentPageInfo.channelName) {
            uploaderMappings[currentPageInfo.channelName] = uploader;
            await saveMappings();
        }

        displayMappedUploader(uploader);
        await autoMatchVideo();
    }

    // Auto-match video by title
    async function autoMatchVideo() {
        if (!currentUploader || !currentPageInfo) return;

        matchStatus.textContent = '匹配中...';
        matchStatus.className = 'match-status searching';
        videoMatchSection.classList.remove('hidden');
        matchedVideo.classList.add('hidden');
        loadDanmakuBtn.classList.add('hidden');

        showLoading('搜索匹配视频...');

        try {
            // 清理搜索关键词
            const cleanedTitle = sanitizeSearchKeyword(currentPageInfo.videoTitle);
            const searchKeyword = `${currentUploader.name} ${cleanedTitle}`;

            // Search for videos from this uploader
            const response = await chrome.runtime.sendMessage({
                action: 'searchVideos',
                keyword: searchKeyword
            });

            if (response.error) {
                throw new Error(response.error);
            }

            if (response.results && response.results.length > 0) {
                // Find best match by title similarity
                const bestMatch = findBestMatch(currentPageInfo.videoTitle, response.results);

                if (bestMatch) {
                    currentMatchedVideo = bestMatch.video;
                    displayMatchedVideo(bestMatch.video, bestMatch.score);

                    // 如果匹配度很高(>=80%)，也自动加载
                    if (bestMatch.score >= 0.8) {
                        hideLoading();
                        await loadDanmaku();
                        return;
                    }
                } else {
                    showVideoSearch();
                }
            } else {
                showVideoSearch();
            }
        } catch (error) {
            console.error('Auto-match error:', error);
            showVideoSearch();
        } finally {
            hideLoading();
        }
    }

    function findBestMatch(targetTitle, videos) {
        let bestScore = 0;
        let bestVideo = null;

        // Clean and normalize the target title
        const cleanTarget = cleanTitle(targetTitle);

        for (const video of videos) {
            const cleanVideoTitle = cleanTitle(video.title);
            const score = calculateSimilarity(cleanTarget, cleanVideoTitle);

            if (score > bestScore) {
                bestScore = score;
                bestVideo = video;
            }
        }

        // Only return if score is above threshold
        if (bestScore >= 0.3) {
            return { video: bestVideo, score: bestScore };
        }

        return null;
    }

    function cleanTitle(title) {
        // Remove common prefixes/suffixes and special characters
        return t2s(title)
            .toLowerCase()
            .replace(/【.*?】/g, '')
            .replace(/\[.*?\]/g, '')
            .replace(/（.*?）/g, '')
            .replace(/\(.*?\)/g, '')
            .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, '')
            .trim();
    }

    // 清理搜索关键词，移除特殊字符和标点
    function sanitizeSearchKeyword(text) {
        return t2s(text || '')
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

    function calculateSimilarity(str1, str2) {
        // Simple word overlap similarity
        const words1 = str1.split(/\s+/).filter(w => w.length > 1);
        const words2 = str2.split(/\s+/).filter(w => w.length > 1);

        if (words1.length === 0 || words2.length === 0) {
            // Use character-based similarity for Chinese
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
        // Character-based Jaccard similarity
        const chars1 = new Set(str1.split(''));
        const chars2 = new Set(str2.split(''));

        let intersection = 0;
        for (const char of chars1) {
            if (chars2.has(char)) intersection++;
        }

        const union = chars1.size + chars2.size - intersection;
        return union > 0 ? intersection / union : 0;
    }

    function displayMatchedVideo(video, score) {
        matchedThumb.src = video.pic;
        matchedThumb.onerror = () => {
            matchedThumb.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 50"><rect fill="%23333" width="80" height="50"/></svg>';
        };
        matchedTitle.textContent = video.title;
        matchedScore.textContent = `匹配度: ${Math.round(score * 100)}%`;
        matchedDanmaku.textContent = `💬 ${formatNumber(video.danmaku)}`;

        matchStatus.textContent = '已匹配';
        matchStatus.className = 'match-status found';

        matchedVideo.classList.remove('hidden');
        loadDanmakuBtn.classList.remove('hidden');
        videoSearch.classList.add('hidden');
        videoResults.classList.add('hidden');
    }

    function showVideoSearch() {
        matchStatus.textContent = '未匹配';
        matchStatus.className = 'match-status';
        matchedVideo.classList.add('hidden');
        videoSearch.classList.remove('hidden');
        loadDanmakuBtn.classList.add('hidden');
    }

    // Search videos manually
    async function searchVideos(keyword) {
        if (!keyword) return;

        showLoading('搜索视频...');

        // 清理搜索关键词
        const cleanedKeyword = sanitizeSearchKeyword(keyword);

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'searchVideos',
                keyword: cleanedKeyword
            });

            if (response.error) {
                throw new Error(response.error);
            }

            displayVideoResults(response.results);
        } catch (error) {
            console.error('Search videos error:', error);
            videoResults.innerHTML = `<div class="error">搜索失败</div>`;
            videoResults.classList.remove('hidden');
        } finally {
            hideLoading();
        }
    }

    function displayVideoResults(results) {
        videoResults.innerHTML = '';

        if (!results || results.length === 0) {
            videoResults.innerHTML = '<div class="no-results">未找到视频</div>';
            videoResults.classList.remove('hidden');
            return;
        }

        results.slice(0, 5).forEach(video => {
            const item = document.createElement('div');
            item.className = 'video-item';
            item.innerHTML = `
        <img class="video-thumb" src="${video.pic}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 40%22><rect fill=%22%23333%22 width=%2264%22 height=%2240%22/></svg>'">
        <div class="video-info">
          <div class="video-title">${escapeHtml(video.title)}</div>
          <div class="video-meta">💬 ${formatNumber(video.danmaku)}</div>
        </div>
      `;

            item.addEventListener('click', () => selectVideo(video));
            videoResults.appendChild(item);
        });

        videoResults.classList.remove('hidden');
    }

    function selectVideo(video) {
        currentMatchedVideo = video;
        displayMatchedVideo(video, 1);
    }

    // Load danmaku
    async function loadDanmaku() {
        if (!currentMatchedVideo) return;

        showLoading('加载弹幕...');

        try {
            // Get video info to get cid
            const videoInfo = await chrome.runtime.sendMessage({
                action: 'getVideoInfo',
                bvid: currentMatchedVideo.bvid
            });

            if (videoInfo.error) {
                throw new Error(videoInfo.error);
            }

            // Get danmaku
            const danmakuData = await chrome.runtime.sendMessage({
                action: 'getDanmaku',
                cid: videoInfo.cid,
                aid: videoInfo.aid,
                duration: videoInfo.duration
            });

            if (danmakuData.error) {
                throw new Error(danmakuData.error);
            }

            currentDanmaku = danmakuData.danmaku;

            // Send to content script
            await chrome.runtime.sendMessage({
                action: 'loadDanmakuToTab',
                danmaku: currentDanmaku,
                offset: parseFloat(offsetInput.value) || 0,
                videoId: currentPageInfo?.videoId
            });

            // Save current state
            await saveCurrentState();

        } catch (error) {
            console.error('Load danmaku error:', error);
            alert('加载弹幕失败: ' + error.message);
        } finally {
            hideLoading();
        }
    }

    // Event Listeners
    uploaderSearchBtn.addEventListener('click', () => searchUploader(uploaderSearchInput.value));
    uploaderSearchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchUploader(uploaderSearchInput.value);
    });

    changeUploader.addEventListener('click', () => {
        mappedUploader.classList.add('hidden');
        uploaderSearch.classList.remove('hidden');
        uploaderResults.classList.add('hidden');
        videoMatchSection.classList.add('hidden');
        currentUploader = null;
    });

    videoSearchBtn.addEventListener('click', () => searchVideos(videoSearchInput.value));
    videoSearchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchVideos(videoSearchInput.value);
    });

    changeVideo.addEventListener('click', () => {
        matchedVideo.classList.add('hidden');
        videoSearch.classList.remove('hidden');
        loadDanmakuBtn.classList.add('hidden');
        currentMatchedVideo = null;
    });

    loadDanmakuBtn.addEventListener('click', loadDanmaku);

    toggleSettings.addEventListener('click', () => {
        settingsPanel.classList.toggle('hidden');
        toggleSettings.classList.toggle('active');
    });

    // Offset controls
    offsetMinus.addEventListener('click', () => {
        offsetInput.value = parseFloat(offsetInput.value) - 1;
        updateOffset();
    });

    offsetPlus.addEventListener('click', () => {
        offsetInput.value = parseFloat(offsetInput.value) + 1;
        updateOffset();
    });

    offsetInput.addEventListener('change', updateOffset);

    // Settings controls
    fontSize.addEventListener('input', () => {
        fontSizeValue.textContent = `${fontSize.value}px`;
        updateSettings();
    });

    opacity.addEventListener('input', () => {
        opacityValue.textContent = `${Math.round(opacity.value * 100)}%`;
        updateSettings();
    });

    speed.addEventListener('input', () => {
        speedValue.textContent = `${speed.value}s`;
        updateSettings();
    });

    screenHeight.addEventListener('input', () => {
        screenHeightValue.textContent = `${screenHeight.value}%`;
        updateSettings();
    });

    density.addEventListener('change', updateSettings);
    showDanmaku.addEventListener('change', updateSettings);

    // Functions
    function showLoading(text) {
        loadingText.textContent = text || '加载中...';
        loading.classList.remove('hidden');
    }

    function hideLoading() {
        loading.classList.add('hidden');
    }

    async function updateOffset() {
        const offset = parseFloat(offsetInput.value) || 0;
        if (currentDanmaku) {
            await chrome.runtime.sendMessage({
                action: 'loadDanmakuToTab',
                danmaku: currentDanmaku,
                offset: offset,
                videoId: currentPageInfo?.videoId
            });
        }
        await saveSettings();
    }

    async function updateSettings() {
        const settings = {
            fontSize: parseInt(fontSize.value),
            opacity: parseFloat(opacity.value),
            speed: parseInt(speed.value),
            screenHeight: parseInt(screenHeight.value),
            density: parseFloat(density.value),
            show: showDanmaku.checked
        };

        await chrome.runtime.sendMessage({
            action: 'updateSettings',
            settings: settings
        });

        await saveSettings();
    }

    async function saveSettings() {
        const settings = {
            offset: parseFloat(offsetInput.value) || 0,
            fontSize: parseInt(fontSize.value),
            opacity: parseFloat(opacity.value),
            speed: parseInt(speed.value),
            screenHeight: parseInt(screenHeight.value),
            density: parseFloat(density.value),
            show: showDanmaku.checked
        };

        await chrome.storage.local.set({ settings });
    }

    async function loadSettings() {
        try {
            const data = await chrome.storage.local.get(['settings']);

            if (data.settings) {
                offsetInput.value = data.settings.offset || 0;
                fontSize.value = data.settings.fontSize || 24;
                fontSizeValue.textContent = `${fontSize.value}px`;
                opacity.value = data.settings.opacity || 0.8;
                opacityValue.textContent = `${Math.round(opacity.value * 100)}%`;
                speed.value = data.settings.speed || 10;
                speedValue.textContent = `${speed.value}s`;
                screenHeight.value = data.settings.screenHeight || 80;
                screenHeightValue.textContent = `${screenHeight.value}%`;
                density.value = data.settings.density || 0.5;
                showDanmaku.checked = data.settings.show !== false;
            }
        } catch (error) {
            console.error('Load settings error:', error);
        }
    }

    async function saveMappings() {
        await chrome.storage.local.set({ uploaderMappings });
    }

    async function loadMappings() {
        try {
            const data = await chrome.storage.local.get(['uploaderMappings']);
            if (data.uploaderMappings) {
                uploaderMappings = data.uploaderMappings;
            }
        } catch (error) {
            console.error('Load mappings error:', error);
        }
    }

    async function saveCurrentState() {
        if (currentMatchedVideo && currentDanmaku && currentPageInfo) {
            await chrome.storage.local.set({
                currentVideoState: {
                    videoId: currentPageInfo.videoId,
                    video: currentMatchedVideo,
                    danmakuCount: currentDanmaku.length,
                    timestamp: Date.now()
                }
            });
        }
    }

    async function loadCurrentState() {
        try {
            const data = await chrome.storage.local.get(['currentVideoState']);
            if (data.currentVideoState) {
                const state = data.currentVideoState;
                // 检查状态是否过期（1小时）
                if (Date.now() - state.timestamp < 3600000) {
                    // 暂存状态，等 initPage 确认视频ID匹配后使用
                    window._savedVideoState = state;
                }
            }
        } catch (error) {
            console.error('Load current state error:', error);
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatNumber(num) {
        if (num >= 10000) {
            return (num / 10000).toFixed(1) + '万';
        }
        return num ? num.toString() : '0';
    }
});
