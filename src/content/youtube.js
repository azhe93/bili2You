// Bili2You YouTube Content Script
// 在YouTube页面上显示B站弹幕，支持自动匹配

(function () {
    'use strict';

    // 配置
    let settings = {
        fontSize: 24,
        opacity: 0.8,
        speed: 10,
        density: 0.5,
        show: true
    };

    // 状态
    let danmakuList = [];
    let timeOffset = 0;
    let danmakuContainer = null;
    let videoElement = null;
    let isPlaying = false;
    let lastTime = 0;
    let danmakuIndex = 0;
    let activeDanmaku = [];
    let tracks = []; // 弹幕轨道
    let animationFrameId = null;
    let currentVideoId = null;

    // 初始化
    function init() {
        console.log('Bili2You: Content script loaded');

        // 监听来自popup/background的消息
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'loadDanmaku') {
                loadDanmaku(request.danmaku, request.offset);
                sendResponse({ success: true });
            }

            if (request.action === 'updateSettings') {
                updateSettings(request.settings);
                sendResponse({ success: true });
            }

            if (request.action === 'getPageInfo') {
                // 返回当前页面的YouTuber和视频信息
                const pageInfo = extractPageInfo();
                sendResponse(pageInfo);
            }

            if (request.action === 'clearDanmaku') {
                clearActiveDanmaku();
                danmakuList = [];
                sendResponse({ success: true });
            }

            return true;
        });

        // 观察DOM变化，等待视频播放器出现
        observeVideoPlayer();

        // 监听URL变化（YouTube SPA）
        observeUrlChange();

        // 从storage加载设置
        loadSettingsFromStorage();

        // 首次加载时尝试自动加载弹幕
        tryInitialAutoLoad();
    }

    // 首次加载时尝试自动加载弹幕
    function tryInitialAutoLoad() {
        const url = new URL(location.href);
        const videoId = url.searchParams.get('v');

        if (!videoId) {
            console.log('Bili2You: Not a video page, skipping auto-load');
            return;
        }

        currentVideoId = videoId;
        console.log('Bili2You: Video page detected, attempting auto-load...');

        // 延迟提取页面信息（等待页面完全加载）
        setTimeout(() => {
            const pageInfo = extractPageInfo();

            if (pageInfo.channelName && pageInfo.videoTitle) {
                console.log('Bili2You: Sending pageInfoReady for auto-load');
                chrome.runtime.sendMessage({
                    action: 'pageInfoReady',
                    pageInfo: pageInfo
                }).then(result => {
                    if (result && result.success) {
                        console.log(`Bili2You: Auto-loaded ${result.danmakuCount} danmaku for "${result.video}"`);
                    }
                }).catch(() => { });
            } else {
                // 如果信息不完整，再等一会儿重试
                setTimeout(() => {
                    const retryInfo = extractPageInfo();
                    if (retryInfo.channelName && retryInfo.videoTitle) {
                        console.log('Bili2You: Retry - Sending pageInfoReady for auto-load');
                        chrome.runtime.sendMessage({
                            action: 'pageInfoReady',
                            pageInfo: retryInfo
                        }).catch(() => { });
                    }
                }, 2000);
            }
        }, 2500);
    }


    // 提取页面信息
    function extractPageInfo() {
        const info = {
            channelName: '',
            channelUrl: '',
            videoTitle: '',
            videoId: ''
        };

        try {
            // 获取频道名称 - 多种选择器尝试
            const channelSelectors = [
                '#channel-name a',
                '#owner #channel-name yt-formatted-string a',
                'ytd-channel-name yt-formatted-string a',
                '#owner-name a',
                'ytd-video-owner-renderer #channel-name a'
            ];

            for (const selector of channelSelectors) {
                const el = document.querySelector(selector);
                if (el && el.textContent.trim()) {
                    info.channelName = el.textContent.trim();
                    info.channelUrl = el.href || '';
                    break;
                }
            }

            // 获取视频标题
            const titleSelectors = [
                'h1.ytd-video-primary-info-renderer yt-formatted-string',
                'h1.title yt-formatted-string',
                '#title h1 yt-formatted-string',
                'ytd-watch-metadata h1 yt-formatted-string'
            ];

            for (const selector of titleSelectors) {
                const el = document.querySelector(selector);
                if (el && el.textContent.trim()) {
                    info.videoTitle = el.textContent.trim();
                    break;
                }
            }

            // 获取视频ID
            const url = new URL(window.location.href);
            info.videoId = url.searchParams.get('v') || '';

        } catch (e) {
            console.error('Bili2You: Error extracting page info', e);
        }

        return info;
    }

    // 监听URL变化
    function observeUrlChange() {
        let lastUrl = location.href;

        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                console.log('Bili2You: URL changed, resetting...');

                // 清除现有弹幕
                clearActiveDanmaku();
                danmakuList = [];
                danmakuIndex = 0;

                // 检查新的视频ID
                const url = new URL(location.href);
                const newVideoId = url.searchParams.get('v');

                if (newVideoId && newVideoId !== currentVideoId) {
                    currentVideoId = newVideoId;

                    // 通知popup页面URL变化
                    chrome.runtime.sendMessage({
                        action: 'urlChanged',
                        videoId: newVideoId
                    }).catch(() => { });

                    // 延迟提取页面信息（等待页面加载）
                    setTimeout(() => {
                        const pageInfo = extractPageInfo();
                        chrome.runtime.sendMessage({
                            action: 'pageInfoReady',
                            pageInfo: pageInfo
                        }).catch(() => { });
                    }, 2000);
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // 从storage加载设置
    async function loadSettingsFromStorage() {
        try {
            const data = await chrome.storage.local.get(['settings']);
            if (data.settings) {
                settings = { ...settings, ...data.settings };
            }
        } catch (e) {
            console.error('Bili2You: Failed to load settings', e);
        }
    }

    // 观察视频播放器
    function observeVideoPlayer() {
        // 尝试立即获取视频元素
        checkVideoPlayer();

        // 使用MutationObserver监听DOM变化
        const observer = new MutationObserver(() => {
            if (!videoElement || !document.contains(videoElement)) {
                checkVideoPlayer();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 检查视频播放器
    function checkVideoPlayer() {
        const video = document.querySelector('video.html5-main-video');
        if (video && video !== videoElement) {
            console.log('Bili2You: Video player found');
            videoElement = video;
            setupVideoEvents();
            createDanmakuContainer();
        }
    }

    // 设置视频事件监听
    function setupVideoEvents() {
        videoElement.addEventListener('play', onPlay);
        videoElement.addEventListener('pause', onPause);
        videoElement.addEventListener('seeking', onSeeking);
        videoElement.addEventListener('seeked', onSeeked);
        videoElement.addEventListener('timeupdate', onTimeUpdate);

        // 检查当前状态
        if (!videoElement.paused) {
            onPlay();
        }
    }

    // 创建弹幕容器
    function createDanmakuContainer() {
        // 移除已存在的容器
        if (danmakuContainer) {
            danmakuContainer.remove();
        }

        // 找到视频容器
        const playerContainer = document.querySelector('#movie_player');
        if (!playerContainer) {
            console.log('Bili2You: Player container not found, retrying...');
            setTimeout(createDanmakuContainer, 1000);
            return;
        }

        // 创建弹幕容器
        danmakuContainer = document.createElement('div');
        danmakuContainer.id = 'bili2you-danmaku-container';
        danmakuContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: hidden;
      z-index: 30;
    `;

        playerContainer.appendChild(danmakuContainer);
        console.log('Bili2You: Danmaku container created');

        // 初始化轨道
        updateTracks();

        // 监听全屏变化
        document.addEventListener('fullscreenchange', onFullscreenChange);

        // 监听容器大小变化
        const resizeObserver = new ResizeObserver(updateTracks);
        resizeObserver.observe(playerContainer);
    }

    // 更新轨道
    function updateTracks() {
        if (!danmakuContainer) return;

        const height = danmakuContainer.offsetHeight;
        const trackHeight = settings.fontSize + 4;
        const trackCount = Math.floor((height * 0.8) / trackHeight); // 只使用上方80%的空间

        tracks = [];
        for (let i = 0; i < trackCount; i++) {
            tracks.push({
                y: i * trackHeight,
                endTime: 0
            });
        }
    }

    // 加载弹幕
    function loadDanmaku(list, offset = 0) {
        danmakuList = list || [];
        timeOffset = offset || 0;
        danmakuIndex = 0;

        // 清除现有弹幕
        clearActiveDanmaku();

        console.log(`Bili2You: Loaded ${danmakuList.length} danmaku, offset: ${timeOffset}s`);

        // 如果视频正在播放，根据当前时间调整弹幕索引
        if (videoElement && !videoElement.paused) {
            seekToTime(videoElement.currentTime);
        }
    }

    // 更新设置
    function updateSettings(newSettings) {
        settings = { ...settings, ...newSettings };
        updateTracks();

        // 更新现有弹幕的样式
        activeDanmaku.forEach(d => {
            if (d.element) {
                d.element.style.fontSize = `${settings.fontSize}px`;
                d.element.style.opacity = settings.opacity;
            }
        });

        // 显示/隐藏弹幕
        if (danmakuContainer) {
            danmakuContainer.style.display = settings.show ? 'block' : 'none';
        }
    }

    // 播放事件
    function onPlay() {
        console.log('Bili2You: Video playing');
        isPlaying = true;
        startRenderLoop();
    }

    // 暂停事件
    function onPause() {
        console.log('Bili2You: Video paused');
        isPlaying = false;
        stopRenderLoop();
    }

    // 开始跳转
    function onSeeking() {
        clearActiveDanmaku();
    }

    // 跳转完成
    function onSeeked() {
        if (videoElement) {
            seekToTime(videoElement.currentTime, true); // skipPast = true, 跳过已过期弹幕
        }
    }

    // 时间更新
    function onTimeUpdate() {
        if (!videoElement) return;
        lastTime = videoElement.currentTime;
    }

    // 跳转到指定时间
    function seekToTime(time, skipPast = false) {
        const adjustedTime = time + timeOffset;

        // 二分查找找到对应的弹幕索引
        let left = 0;
        let right = danmakuList.length - 1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (danmakuList[mid].time < adjustedTime) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        danmakuIndex = left;

        // 如果是跳转，跳过已过期的弹幕（只保留当前时间前0.5秒内的）
        if (skipPast) {
            while (danmakuIndex < danmakuList.length &&
                danmakuList[danmakuIndex].time < adjustedTime - 0.5) {
                danmakuIndex++;
            }
        }

        console.log(`Bili2You: Seeked to ${time}s, danmaku index: ${danmakuIndex}, skipPast: ${skipPast}`);
    }

    // 全屏变化
    function onFullscreenChange() {
        setTimeout(updateTracks, 100);
    }

    // 开始渲染循环
    function startRenderLoop() {
        if (animationFrameId) return;

        function render() {
            if (!isPlaying || !videoElement || !settings.show) {
                animationFrameId = requestAnimationFrame(render);
                return;
            }

            const currentTime = videoElement.currentTime + timeOffset;

            // 发射新弹幕
            const maxDanmakuPerFrame = 15; // 每帧最多发射15条弹幕，防止跳转时大量弹幕涌入
            let danmakuFiredThisFrame = 0;

            while (danmakuIndex < danmakuList.length) {
                const danmaku = danmakuList[danmakuIndex];

                if (danmaku.time > currentTime) {
                    break;
                }

                // 跳过过期超过2秒的弹幕（避免跳转后大量历史弹幕涌入）
                if (danmaku.time < currentTime - 2) {
                    danmakuIndex++;
                    continue;
                }

                // 每帧发射弹幕数量限制
                if (danmakuFiredThisFrame >= maxDanmakuPerFrame) {
                    break; // 剩余弹幕下一帧继续处理
                }

                // 根据密度随机过滤
                if (Math.random() < settings.density) {
                    fireDanmaku(danmaku);
                    danmakuFiredThisFrame++;
                }

                danmakuIndex++;
            }

            // 更新活动弹幕
            updateActiveDanmaku();

            animationFrameId = requestAnimationFrame(render);
        }

        animationFrameId = requestAnimationFrame(render);
    }

    // 停止渲染循环
    function stopRenderLoop() {
        // 不完全停止，只是暂停发射新弹幕
    }

    // 发射弹幕
    function fireDanmaku(danmaku) {
        if (!danmakuContainer || !settings.show) return;

        // 创建弹幕元素
        const element = document.createElement('div');
        element.className = 'bili2you-danmaku';
        element.textContent = danmaku.text;

        // 颜色转换
        const color = danmaku.color.toString(16).padStart(6, '0');

        // 基础样式
        element.style.cssText = `
      position: absolute;
      white-space: nowrap;
      font-size: ${settings.fontSize}px;
      font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
      font-weight: bold;
      color: #${color};
      text-shadow: 1px 1px 2px rgba(0,0,0,0.8), -1px -1px 2px rgba(0,0,0,0.8);
      opacity: ${settings.opacity};
      pointer-events: none;
      will-change: transform;
    `;

        danmakuContainer.appendChild(element);

        // 获取弹幕宽度
        const danmakuWidth = element.offsetWidth;
        const containerWidth = danmakuContainer.offsetWidth;

        // 根据模式设置位置和动画
        const mode = danmaku.mode;
        let trackIndex = -1;
        let startX, endX, y;
        const duration = settings.speed * 1000; // 转换为毫秒

        if (mode === 4) {
            // 底部弹幕
            y = danmakuContainer.offsetHeight - settings.fontSize - 20;
            startX = (containerWidth - danmakuWidth) / 2;
            endX = startX;
            trackIndex = -1;
        } else if (mode === 5) {
            // 顶部弹幕
            y = 20;
            startX = (containerWidth - danmakuWidth) / 2;
            endX = startX;
            trackIndex = -1;
        } else {
            // 滚动弹幕
            const now = Date.now();

            // 寻找可用轨道
            for (let i = 0; i < tracks.length; i++) {
                if (tracks[i].endTime < now) {
                    trackIndex = i;
                    break;
                }
            }

            // 如果没有可用轨道，随机选择一个
            if (trackIndex === -1) {
                trackIndex = Math.floor(Math.random() * tracks.length);
            }

            if (trackIndex >= 0 && trackIndex < tracks.length) {
                y = tracks[trackIndex].y;
                // 计算该弹幕离开屏幕右侧的时间
                const travelTime = (containerWidth / (containerWidth + danmakuWidth)) * duration;
                tracks[trackIndex].endTime = now + travelTime;
            } else {
                y = Math.random() * (danmakuContainer.offsetHeight * 0.7);
            }

            startX = containerWidth;
            endX = -danmakuWidth;
        }

        // 设置初始位置
        element.style.left = `${startX}px`;
        element.style.top = `${y}px`;

        // 记录活动弹幕
        const danmakuObj = {
            element,
            mode,
            startTime: Date.now(),
            duration: mode === 4 || mode === 5 ? 4000 : duration,
            startX,
            endX,
            y
        };

        activeDanmaku.push(danmakuObj);
    }

    // 更新活动弹幕
    function updateActiveDanmaku() {
        const now = Date.now();

        for (let i = activeDanmaku.length - 1; i >= 0; i--) {
            const d = activeDanmaku[i];
            const elapsed = now - d.startTime;
            const progress = elapsed / d.duration;

            if (progress >= 1) {
                // 弹幕结束
                d.element.remove();
                activeDanmaku.splice(i, 1);
                continue;
            }

            // 更新位置
            if (d.mode !== 4 && d.mode !== 5) {
                // 滚动弹幕
                const x = d.startX + (d.endX - d.startX) * progress;
                d.element.style.transform = `translateX(${x - d.startX}px)`;
            }
        }
    }

    // 清除所有活动弹幕
    function clearActiveDanmaku() {
        activeDanmaku.forEach(d => {
            if (d.element) {
                d.element.remove();
            }
        });
        activeDanmaku = [];

        // 重置轨道
        tracks.forEach(t => t.endTime = 0);
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
