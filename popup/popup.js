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
    const settingsSection = document.querySelector('.settings-section');
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
        let tab;
        try {
            [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !isSupportedYouTubeWatchUrl(tab.url)) {
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
                const hasLoadedState = window._savedVideoState && window._savedVideoState.videoId === response.videoId;
                if (hasLoadedState) {
                    const state = window._savedVideoState;
                    currentMatchedVideo = state.video;
                    currentDanmaku = null;
                    currentUploader = uploaderMappings[response.channelName];
                    console.log('Bili2You: Restored saved state for video', response.videoId);
                }

                await checkUploaderMapping(response.channelName, hasLoadedState);
            } else {
                // Retry after a short delay
                setTimeout(async () => {
                    try {
                        const retryResponse = await chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' });
                        if (retryResponse && retryResponse.channelName) {
                            currentPageInfo = retryResponse;
                            displayPageInfo(retryResponse);
                            const hasLoadedState = window._savedVideoState && window._savedVideoState.videoId === retryResponse.videoId;
                            if (hasLoadedState) {
                                const state = window._savedVideoState;
                                currentMatchedVideo = state.video;
                                currentDanmaku = null;
                                currentUploader = uploaderMappings[retryResponse.channelName];
                            }
                            await checkUploaderMapping(retryResponse.channelName, hasLoadedState);
                        } else {
                            showPageInfoUnavailable();
                        }
                    } catch (error) {
                        console.error('Retry page info error:', error);
                        showPageInfoUnavailable();
                    }
                }, 1500);
            }

            hideLoading();
        } catch (error) {
            console.error('Init error:', error);
            hideLoading();
            if (tab && isSupportedYouTubeWatchUrl(tab.url)) {
                showPageInfoUnavailable();
            } else {
                showNotYouTube();
            }
        }
    }

    function showNotYouTube() {
        pageInfoSection.classList.add('hidden');
        uploaderSection.classList.add('hidden');
        videoMatchSection.classList.add('hidden');
        settingsSection.classList.add('hidden');
        notYouTube.classList.remove('hidden');
    }

    function displayPageInfo(info) {
        channelNameEl.textContent = info.channelName || '未知';
        videoTitleEl.textContent = info.videoTitle || '未知';
        videoTitleEl.title = info.videoTitle || '';

        pageInfoSection.classList.remove('hidden');
        uploaderSection.classList.remove('hidden');
        settingsSection.classList.remove('hidden');
        notYouTube.classList.add('hidden');

        // Pre-fill search inputs (清理特殊字符)
        uploaderSearchInput.value = info.channelName || '';
        videoSearchInput.value = sanitizeSearchKeyword(info.videoTitle || '');
    }

    // Check if we have a cached uploader mapping
    async function checkUploaderMapping(channelName, skipAutoMatch = false) {
        // 如果当前视频已加载弹幕，直接显示已匹配的UP主和视频，不重新匹配
        if (skipAutoMatch && currentMatchedVideo) {
            if (currentUploader) {
                displayMappedUploader(currentUploader);
            }
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

    function fallbackAvatarDataUrl(size = 32) {
        return `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect fill="%2300a1d6" width="${size}" height="${size}" rx="${size / 2}"/></svg>`;
    }

    function fallbackThumbDataUrl(width = 80, height = 50) {
        return `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect fill="%23333" width="${width}" height="${height}"/></svg>`;
    }

    function setImageWithFallback(img, src, fallbackSrc) {
        img.onerror = () => {
            img.onerror = null;
            img.src = fallbackSrc;
        };
        img.src = src || fallbackSrc;
    }

    function getOffsetValue() {
        const value = parseFloat(offsetInput.value);
        return Number.isFinite(value) ? value : 0;
    }

    function isSupportedYouTubeWatchUrl(urlString) {
        try {
            const url = new URL(urlString);
            return url.protocol === 'https:' &&
                url.hostname === 'www.youtube.com' &&
                url.pathname === '/watch' &&
                url.searchParams.has('v');
        } catch (error) {
            return false;
        }
    }

    function showPageInfoUnavailable() {
        channelNameEl.textContent = '未检测到';
        videoTitleEl.textContent = '请刷新页面后重试';
        pageInfoSection.classList.remove('hidden');
        uploaderSection.classList.add('hidden');
        videoMatchSection.classList.add('hidden');
        settingsSection.classList.remove('hidden');
        notYouTube.classList.add('hidden');
    }

    function displayMappedUploader(uploader) {
        setImageWithFallback(mappedUploaderAvatar, uploader.face, fallbackAvatarDataUrl(32));
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
            const empty = document.createElement('div');
            empty.className = 'no-results';
            empty.textContent = '未找到UP主';
            uploaderResults.appendChild(empty);
            uploaderResults.classList.remove('hidden');
            return;
        }

        results.slice(0, 5).forEach(uploader => {
            const item = document.createElement('div');
            item.className = 'uploader-item';

            const avatar = document.createElement('img');
            avatar.className = 'uploader-avatar';
            setImageWithFallback(avatar, uploader.face, fallbackAvatarDataUrl(28));

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = uploader.name || '';

            const fans = document.createElement('span');
            fans.className = 'fans';
            fans.textContent = `${formatNumber(uploader.fans)} 粉丝`;

            item.append(avatar, name, fans);
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
        setImageWithFallback(matchedThumb, video.pic, fallbackThumbDataUrl(80, 50));
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
            const empty = document.createElement('div');
            empty.className = 'no-results';
            empty.textContent = '未找到视频';
            videoResults.appendChild(empty);
            videoResults.classList.remove('hidden');
            return;
        }

        results.slice(0, 5).forEach(video => {
            const item = document.createElement('div');
            item.className = 'video-item';

            const thumb = document.createElement('img');
            thumb.className = 'video-thumb';
            setImageWithFallback(thumb, video.pic, fallbackThumbDataUrl(64, 40));

            const info = document.createElement('div');
            info.className = 'video-info';

            const title = document.createElement('div');
            title.className = 'video-title';
            title.textContent = video.title || '';

            const meta = document.createElement('div');
            meta.className = 'video-meta';
            meta.textContent = `💬 ${formatNumber(video.danmaku)}`;

            info.append(title, meta);
            item.append(thumb, info);
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
                bvid: currentMatchedVideo.bvid,
                title: currentPageInfo?.videoTitle || ''
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
            if (!Array.isArray(danmakuData.danmaku) || danmakuData.danmaku.length === 0) {
                throw new Error('未获取到弹幕，可能是该分 P 无弹幕或 B 站接口返回为空');
            }

            currentDanmaku = danmakuData.danmaku;

            // Send to content script
            const loadResult = await chrome.runtime.sendMessage({
                action: 'loadDanmakuToTab',
                danmaku: currentDanmaku,
                offset: getOffsetValue(),
                videoId: currentPageInfo?.videoId
            });
            if (loadResult && loadResult.success === false) {
                throw new Error(loadResult.error || loadResult.reason || '弹幕未加载到当前页面');
            }

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
        offsetInput.value = getOffsetValue() - 1;
        updateOffset();
    });

    offsetPlus.addEventListener('click', () => {
        offsetInput.value = getOffsetValue() + 1;
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
        const offset = getOffsetValue();
        if (Array.isArray(currentDanmaku)) {
            const loadResult = await chrome.runtime.sendMessage({
                action: 'loadDanmakuToTab',
                danmaku: currentDanmaku,
                offset: offset,
                videoId: currentPageInfo?.videoId
            });
            if (loadResult && loadResult.success === false) {
                console.warn('Bili2You: Failed to update offset on page', loadResult.error || loadResult.reason);
            }
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
            offset: getOffsetValue(),
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
        if (currentMatchedVideo && Array.isArray(currentDanmaku) && currentPageInfo) {
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

    function formatNumber(num) {
        if (num >= 10000) {
            return (num / 10000).toFixed(1) + '万';
        }
        return num ? num.toString() : '0';
    }
});
