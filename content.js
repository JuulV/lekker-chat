/**
 * LekkerChat Extension
 * Synchronizes Twitch chat data with YouTube videos
 */

// Configuration constants
const CONSTANTS = {
    TWITCH_EMOTE_URL: 'https://static-cdn.jtvnw.net/emoticons/v1/{id}/1.0',
    TWITCH_BADGE_URL: 'https://static-cdn.jtvnw.net/badges/v1/{id}/1',
    UPDATE_INTERVAL: 100,
    URL_CHECK_INTERVAL: 1000,
    CHAT_CHECK_INTERVAL: 1000,
    VIDEO_CHECK_INTERVAL: 500,
    SKIP_THRESHOLD: 15,
    PREVIOUS_MESSAGES_COUNT: 25
};

// Global state
let chatData = null;
let imageData = null;
let ttvLink = null;
let videoInterval = null;
let chatInterval = null;
let messageList = null;
let shownMessages = new Set();
let config = null;
let video = null;
let lastSecond = -1;
let isActive = false;
let originalChatContent = null; // Store original YouTube chat
let isManualLinkMode = false; // Manual link mode flag
let pendingVideoId = null; // YouTube video ID waiting for manual link
let chatHeader = null; // Header element for chat
let isChatCollapsed = false; // Track chat collapse state

/**
 * Browser API abstraction for cross-browser compatibility
 */
const browserAPI = {
    getURL: (path) => {
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            return chrome.runtime.getURL(path);
        } else if (typeof browser !== 'undefined' && browser.runtime) {
            return browser.runtime.getURL(path);
        }
        throw new Error('Browser extension API not available');
    },
    storage: {
        local: {
            get: (keys) => {
                if (typeof chrome !== 'undefined' && chrome.storage) {
                    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
                } else if (typeof browser !== 'undefined' && browser.storage) {
                    return browser.storage.local.get(keys);
                }
                throw new Error('Storage API not available');
            },
            set: (items) => {
                if (typeof chrome !== 'undefined' && chrome.storage) {
                    return new Promise(resolve => chrome.storage.local.set(items, resolve));
                } else if (typeof browser !== 'undefined' && browser.storage) {
                    return browser.storage.local.set(items);
                }
                throw new Error('Storage API not available');
            }
        }
    }
};

/**
 * Replace text emotes with HTML image elements
 * @param {string} content - The message content
 * @returns {string} HTML string with emotes replaced
 */
function replaceEmotes(content) {
    if (!imageData?.emoticons) return content;

    try {
        return content.split(/\s+/).map(word => {
            const emoteId = imageData.emoticons[word];
            if (emoteId) {
                const emoteUrl = CONSTANTS.TWITCH_EMOTE_URL.replace('{id}', emoteId);
                const emoteImg = `<img src="${emoteUrl}" alt="${word}" class="chat-image chat-line__message--emote">`;
                return `<div class='chat-emote'><span><div class='chat-image__container'>${emoteImg}</div></span></div>`;
            } else {
                return `<span class="text-fragment" data-a-target="chat-message-text">${word}</span>`;
            }
        }).join(' ');
    } catch (error) {
        console.error('Error replacing emotes:', error);
        return content;
    }
}

/**
 * Create a chat message DOM element
 * @param {Object} msg - Message data from chat JSON
 * @returns {HTMLElement} List item containing the formatted message
 */
function createChatMessage(msg) {
    if (!msg || !chatData?.commenters?.[msg.commenter]) {
        console.warn('Invalid message data:', msg);
        return document.createElement("li");
    }

    const li = document.createElement("li");

    const vodMessage = li.appendChild(document.createElement("div"));
    vodMessage.className = "vod-message";

    const vodMessageDiv1 = vodMessage.appendChild(document.createElement("div"));
    const vodMessageDiv2 = vodMessageDiv1.appendChild(document.createElement("div"));
    vodMessageDiv2.className = "message-box";
    const vodMessageDiv3 = vodMessageDiv2.appendChild(document.createElement("div"));
    vodMessageDiv3.className = "message-box-inner";

    const author = chatData.commenters[msg.commenter];

    const badgesSpan = vodMessageDiv3.appendChild(document.createElement("span"));
    if (author.badges && Array.isArray(author.badges)) {
        author.badges.forEach(badge => {
            if (!imageData?.badges?.[badge._id]) {
                return;
            }

            const badgeDiv = badgesSpan.appendChild(document.createElement("div"));
            badgeDiv.className = "badge-box";

            const badgeA = badgeDiv.appendChild(document.createElement("a"));
            const badgeImg = badgeA.appendChild(document.createElement("img"));
            const badgeId = imageData.badges[badge._id]?.[parseInt(badge.version)];
            if (!badgeId) {
                console.warn(`Badge version ${badge.version} not found for badge ID ${badge._id}`);
                return;
            }
            const badgeUrl = CONSTANTS.TWITCH_BADGE_URL.replace('{id}', badgeId);
            badgeImg.setAttribute("src", badgeUrl);
            badgeImg.className = "chat-badge";
        });
    }

    const authorA = vodMessageDiv3.appendChild(document.createElement("a"));
    authorA.setAttribute("href", "https://twitch.tv/" + author.name);
    authorA.className = "chat-author-link";

    const authorSpan = authorA.appendChild(document.createElement("span"));
    authorSpan.innerHTML = `<span class='chat-author__display-name' style='color: ${author.color ?? "#fff"};'>${author.display_name}</span>`;

    const messageDiv = vodMessageDiv3.appendChild(document.createElement("div"));
    messageDiv.className = "video-chat__message";
    const colonSpan = messageDiv.appendChild(document.createElement("span"))
    colonSpan.textContent = ":";
    colonSpan.className = "colon";

    const messageSpan = messageDiv.appendChild(document.createElement("span"));
    messageSpan.innerHTML = replaceEmotes(msg.message);

    return li;
}

// Variables already declared at top of file

/**
 * Display a chat message and handle auto-scrolling
 * @param {Object} comment - Comment data to display
 */
function showMessage(comment) {
    if (!comment || !messageList) {
        console.warn('Cannot show message - invalid comment or messageList not available');
        return;
    }

    const isAtBottom = messageList.scrollTop == null ? false :
        Math.abs(messageList.scrollTop + messageList.clientHeight - messageList.scrollHeight) < 5;

    shownMessages.add(comment);
    const messageElement = createChatMessage(comment);
    messageList.appendChild(messageElement);

    if (isAtBottom || config?.autoScroll !== false) {
        scrollToBottom();
    }
}

/**
 * Scroll the message list to the bottom
 */
function scrollToBottom() {
    if (messageList) {
        requestAnimationFrame(() => {
            messageList.scrollTop = messageList.scrollHeight;
        });
    }
}

/**
 * Check if the current video is a livestream
 * @returns {boolean} True if video is a livestream
 */
function isLivestream() {
    // Check if native YouTube chat exists (indicator of livestream)
    const nativeChatExists = document.querySelector("#chat") !== null;
    
    // Check for live badge
    const liveBadge = document.querySelector('.ytp-live-badge, .ytp-live');
    
    // Check video duration (live videos show "LIVE" instead of duration)
    const durationElement = document.querySelector('.ytp-time-duration');
    const isLiveDuration = durationElement && durationElement.textContent.trim() === '';
    
    return nativeChatExists || liveBadge !== null || isLiveDuration;
}

/**
 * Toggle chat collapse state
 */
function toggleChatCollapse() {
    isChatCollapsed = !isChatCollapsed;
    
    if (messageList) {
        const chatContainer = messageList.parentNode;
        
            const chatContainerr = document.querySelector('#chat-container');
        if (isChatCollapsed) {
            chatContainerr.classList.add('lekker-chat-collapsed');
            // Collapsing: measure current height, then transition to 0
            const currentHeight = messageList.scrollHeight;
            messageList.style.flex = 'none';
            messageList.style.height = currentHeight + 'px';
            messageList.style.transition = 'height 0.3s ease, opacity 0.3s ease';
            messageList.style.overflow = 'hidden';
            
            // Set chat container to fixed height
            if (chatContainer) {
                chatContainer.style.height = '50px';
                chatContainer.style.transition = 'height 0.3s ease';
            }
            
            // Force reflow
            messageList.offsetHeight;
            
            messageList.style.height = '0px';
            messageList.style.opacity = '0';
        } else {
            
            chatContainerr.classList.remove('lekker-chat-collapsed');
            // Expanding: transition from 0 to calculated height
            messageList.style.flex = 'none';
            messageList.style.height = '0px';
            messageList.style.opacity = '0';
            messageList.style.overflow = 'hidden';
            messageList.style.transition = 'height 0.3s ease, opacity 0.3s ease';
            
            // Restore chat container height
            if (chatContainer) {
                chatContainer.style.height = '100%';
                chatContainer.style.transition = 'height 0.3s ease';
            }
            
            // Force reflow
            messageList.offsetHeight;
            
            // Calculate a reasonable height (use parent container height minus header)
            const headerHeight = chatHeader ? chatHeader.offsetHeight : 0;
            const availableHeight = chatContainer.clientHeight - headerHeight;
            const targetHeight = Math.max(300, availableHeight); // At least 300px or available space
            
            messageList.style.height = targetHeight + 'px';
            messageList.style.opacity = '1';
            
            // After transition completes, set to flex for responsive behavior
            setTimeout(() => {
                if (!isChatCollapsed && messageList) {
                    messageList.style.flex = '1';
                    messageList.style.height = 'auto';
                    messageList.style.overflow = 'auto';
                    messageList.style.overflowX = 'hidden';
                }
            }, 300);
        }
    }
    
    if (chatHeader) {
        const toggleButton = chatHeader.querySelector('.lekker-chat-toggle');
        if (toggleButton) {
            toggleButton.textContent = isChatCollapsed ? '▼' : '▲';
            toggleButton.setAttribute('aria-label', isChatCollapsed ? 'Expand chat' : 'Collapse chat');
        }
    }
    
    console.log(`Chat ${isChatCollapsed ? 'collapsed' : 'expanded'}`);
}

/**
 * Create a header for the chat with collapse button
 * @param {HTMLElement} chatContainer - The chat container element
 */
function createChatHeader(chatContainer) {
    // Remove existing header if present
    if (chatHeader && chatHeader.parentNode) {
        chatHeader.remove();
    }
    
    chatHeader = document.createElement('div');
    chatHeader.className = 'lekker-chat-header';
    chatHeader.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background-color: #18181b;
        border-bottom: 1px solid #2d2d2d;
        color: #efeff1;
        font-family: 'Roobert', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif;
        font-size: 14px;
        font-weight: 600;
    `;
    
    const title = document.createElement('span');
    title.textContent = 'Lekker Chat';
    title.style.cssText = 'flex-grow: 1;';
    
    const toggleButton = document.createElement('button');
    toggleButton.className = 'lekker-chat-toggle';
    toggleButton.textContent = isChatCollapsed ? '▼' : '▲';
    toggleButton.setAttribute('aria-label', isChatCollapsed ? 'Expand chat' : 'Collapse chat');
    toggleButton.style.cssText = `
        background: none;
        border: none;
        color: #efeff1;
        cursor: pointer;
        font-size: 16px;
        padding: 4px 8px;
        transition: background-color 0.2s;
        border-radius: 4px;
    `;
    
    toggleButton.addEventListener('mouseenter', () => {
        toggleButton.style.backgroundColor = '#2d2d2d';
    });
    
    toggleButton.addEventListener('mouseleave', () => {
        toggleButton.style.backgroundColor = 'transparent';
    });
    
    toggleButton.addEventListener('click', toggleChatCollapse);
    
    chatHeader.appendChild(title);
    chatHeader.appendChild(toggleButton);
    
    // Insert header at the beginning of the chat container
    chatContainer.insertBefore(chatHeader, chatContainer.firstChild);
    
    return chatHeader;
}

/**
 * Inject the Twitch chat interface into the YouTube chat container
 * @param {HTMLElement} chatContainer - The YouTube chat container element
 */
function injectChat(chatContainer) {
    if (!chatContainer) {
        console.error('Cannot inject chat - chat container not found');
        return;
    }

    console.log('injectChat called with container:', chatContainer);

    try {
        // Only clear and inject if we haven't already
        if (!messageList || !messageList.parentNode) {
            // Save original content before destroying it
            originalChatContent = chatContainer.innerHTML;
            
            console.log('Creating new message list...');
            chatContainer.innerHTML = "";
            
            // Determine if chat should start collapsed (non-livestream videos)
            const isLive = isLivestream();
            isChatCollapsed = !isLive; // Collapsed by default for VODs, expanded for live
            console.log(`Video is ${isLive ? 'livestream' : 'VOD'}, chat ${isChatCollapsed ? 'collapsed' : 'expanded'} by default`);
            
            // Style the chat container to prevent extra space
            chatContainer.style.cssText = `
                display: flex;
                flex-direction: column;
                height: ${isChatCollapsed ? '50px' : '100%'};
                overflow: hidden;
                transition: height 0.3s ease;
            `;
            
            // Create header first
            createChatHeader(chatContainer);
            
            messageList = chatContainer.appendChild(document.createElement("ul"));
            messageList.className = "chat-message-list";
            
            // Apply initial collapse state
            if (isChatCollapsed) {
                messageList.style.height = '0px';
                messageList.style.opacity = '0';
                messageList.style.overflow = 'hidden';
                messageList.style.transition = 'height 0.3s ease, opacity 0.3s ease';
            } else {
                messageList.style.height = 'auto';
                messageList.style.flex = '1';
                messageList.style.transition = 'height 0.3s ease, opacity 0.3s ease';
            }
            
            // Add a class to indicate our chat is active
            const chatContainerParent = document.querySelector("#chat-container");
            if (chatContainerParent) {
                chatContainerParent.classList.add("lekker-chat-active");
                console.log('Added lekker-chat-active class to container');
            }
            
            console.log("Successfully injected Twitch chat interface!");
        } else {
            // Just clear existing messages
            messageList.innerHTML = "";
            console.log("Cleared existing Twitch chat interface");
        }
    } catch (error) {
        console.error('Error injecting chat:', error);
    }
}

/**
 * Wait for the YouTube chat container to be available
 * @returns {Promise<HTMLElement>} Promise that resolves with the chat container
 */
function waitForChatContainer() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 30; // 30 seconds timeout
        let containerCreated = false;

        const checkExist = setInterval(() => {
            attempts++;
            let chatContainer = document.querySelector("#chat");

            // If no native chat container exists (non-live videos), create one
            if (!chatContainer && !containerCreated) {
                console.log('No native YouTube chat found - creating custom chat container');
                chatContainer = createChatContainer();
                containerCreated = true;
                
                if (!chatContainer) {
                    console.error('Failed to create chat container');
                }
            }

            if (chatContainer) {
                clearInterval(checkExist);
                
                // Inject if we have chat data loaded
                if (chatData && chatData.comments && chatData.comments.length > 0) {
                    injectChat(chatContainer);
                    console.log('Chat injected successfully');
                } else {
                    console.log('Not injecting chat - no chat data available');
                }
                
                resolve(chatContainer);
            } else if (attempts >= maxAttempts) {
                clearInterval(checkExist);
                console.error('Chat container creation failed or timed out');
                reject(new Error('Chat container not found after 30 seconds'));
            }
        }, CONSTANTS.CHAT_CHECK_INTERVAL);
    });
}

/**
 * Create a custom chat container for videos without native YouTube chat
 */
function createChatContainer() {
    // Try multiple selectors for the secondary column (YouTube layout variations)
    const secondary = document.querySelector("#secondary") || 
                      document.querySelector("#secondary-inner") ||
                      document.querySelector("ytd-watch-flexy #secondary");
    
    if (!secondary) {
        console.error('Cannot find secondary column to inject chat');
        console.log('Attempting to find any secondary element...');
        
        // Try to find the main video container and insert next to it
        const primaryInner = document.querySelector("#primary-inner") || 
                            document.querySelector("#primary");
        
        if (primaryInner && primaryInner.parentElement) {
            console.log('Found primary container, will create secondary');
            const newSecondary = document.createElement('div');
            newSecondary.id = 'lekker-chat-secondary';
            newSecondary.style.cssText = `
                width: 400px;
                margin-left: 24px;
                flex-shrink: 0;
            `;
            primaryInner.parentElement.style.display = 'flex';
            primaryInner.parentElement.appendChild(newSecondary);
            return createChatInContainer(newSecondary);
        }
        
        return null;
    }

    return createChatInContainer(secondary);
}

/**
 * Create the actual chat elements in the given container
 */
function createChatInContainer(container) {
    // Check if we already created a chat container
    const existing = document.querySelector("#chat-container");
    if (existing) {
        const existingChat = existing.querySelector("#chat");
        if (existingChat) {
            console.log('Chat container already exists, reusing it');
            return existingChat;
        }
    }

    // Create chat container structure with same ID as YouTube's native chat
    const chatContainer = document.createElement('div');
    chatContainer.id = 'chat-container';
    chatContainer.className = 'lekker-chat-active';

    const chat = document.createElement('div');
    chat.id = 'chat';

    chatContainer.appendChild(chat);
    
    // Insert at the top of container
    container.insertBefore(chatContainer, container.firstChild);
    
    console.log('Created custom chat container successfully');
    return chat;
}

/**
 * Wait for the video element to be available
 * @returns {Promise<HTMLVideoElement>} Promise that resolves with the video element
 */
function getVideoElement() {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 60; // 30 seconds timeout

        const checkInterval = setInterval(() => {
            attempts++;
            const videoElement = document.querySelector('video');

            if (videoElement) {
                clearInterval(checkInterval);
                resolve(videoElement);
            } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                reject(new Error('Video element not found after 30 seconds'));
            }
        }, CONSTANTS.VIDEO_CHECK_INTERVAL);
    });
}

/**
 * Show previous messages when jumping to a specific time
 * @param {number} second - Current video time in seconds
 */
function showPreviousMessages(second) {
    if (!chatData?.comments) {
        console.warn('No chat data available for showing previous messages');
        return;
    }

    try {
        const firstIdx = [...chatData.comments].reverse().findIndex(comment =>
            (comment.content_offset_seconds + getTimeOffset()) < second
        );
        if (firstIdx !== -1) {
            const startIdx = Math.max(0, firstIdx - CONSTANTS.PREVIOUS_MESSAGES_COUNT);
            for (let i = startIdx; i < firstIdx; i++) {
                const comment = chatData.comments[i];
                if (comment && !shownMessages.has(comment)) {
                    showMessage(comment);
                }
            }
        }
    } catch (error) {
        console.error('Error showing previous messages:', error);
    }
}

/**
 * Show messages that were missed during time jumps
 * @param {number} from - Start time in seconds
 * @param {number} to - End time in seconds
 */
function showMissedMessages(from, to) {
    if (!chatData?.comments) {
        console.warn('No chat data available for showing missed messages');
        return;
    }

    try {
        for (let sec = from; sec <= to; sec++) {
            const missedComments = chatData.comments.filter(comment =>
                comment && (comment.content_offset_seconds + getTimeOffset()) === sec && !shownMessages.has(comment)
            );
            missedComments.forEach(comment => showMessage(comment));
        }
    } catch (error) {
        console.error('Error showing missed messages:', error);
    }
}

/**
 * Show messages for the current second with staggered timing
 * @param {number} currentSecond - Current video time in seconds
 */
function showCurrentSecondMessages(currentSecond) {
    if (!chatData?.comments) {
        return;
    }

    try {
        const commentsThisSecond = chatData.comments.filter(comment =>
            comment && (comment.content_offset_seconds + getTimeOffset()) === currentSecond && !shownMessages.has(comment)
        );
        const count = commentsThisSecond.length;

        if (count > 0) {
            commentsThisSecond.forEach((comment, idx) => {
                setTimeout(() => {
                    showMessage(comment);
                }, (idx * 1000) / count);
            });
        }
    } catch (error) {
        console.error('Error showing current second messages:', error);
    }
}

/**
 * Handle video ready state and start synchronization
 */
async function onVideoReady() {
    try {
        video = await getVideoElement();

        if (videoInterval) {
            clearInterval(videoInterval);
            shownMessages.clear();
            if (messageList) {
                messageList.innerHTML = "";
            }
        }

        videoInterval = setInterval(() => {
            if (!video || video.paused) return;

            const currentSecond = Math.floor(video.currentTime);
            if (currentSecond !== lastSecond) {
                // Large time jump - show previous messages for context
                if (Math.abs(currentSecond - lastSecond) > CONSTANTS.SKIP_THRESHOLD) {
                    shownMessages.clear();
                    if (messageList) {
                        messageList.innerHTML = "";
                    }
                    showPreviousMessages(currentSecond);
                }
                // Small time jump - show missed messages
                else if (Math.abs(currentSecond - lastSecond) > 1) {
                    const from = Math.min(lastSecond, currentSecond) + 1;
                    const to = Math.max(lastSecond, currentSecond);
                    showMissedMessages(from, to);
                }

                lastSecond = currentSecond;
                showCurrentSecondMessages(currentSecond);
            }
        }, CONSTANTS.UPDATE_INTERVAL);

        console.log('Video synchronization started');
    } catch (error) {
        console.error('Error setting up video synchronization:', error);
    }
}

/**
 * Initialize configuration system
 */
async function initConfig() {
    try {
        const settings = await browserAPI.storage.local.get({
            timeOffset: null,
            enableSync: true,
            autoScroll: true,
            environment: 'production'
        });

        config = settings;
        
        // If timeOffset is null/undefined, calculate smart default
        if (config.timeOffset == null) {
            config.timeOffset = calculateSmartDefaultOffset();
            console.log('No stored offset, using smart default:', config.timeOffset);
        }
        
        console.log('Configuration loaded:', config);
    } catch (error) {
        console.error('Failed to load configuration:', error);
        config = {
            timeOffset: 900,
            enableSync: true,
            autoScroll: true,
            environment: 'production'
        };
    }
}

/**
 * Calculate a smart default offset based on video duration and last chat message
 * @returns {number} Calculated offset in seconds
 */
function calculateSmartDefaultOffset() {
    // Fallback to 900 if we can't calculate
    let fallbackOffset = 900;
    
    try {
        // Get video duration
        const videoElement = document.querySelector('video');
        const videoDuration = videoElement?.duration;
        
        // Get last chat message timestamp
        const lastChatTimestamp = chatData?.comments?.length > 0 
            ? chatData.comments[chatData.comments.length - 1].content_offset_seconds 
            : null;
        
        if (videoDuration && lastChatTimestamp && videoDuration > 0 && lastChatTimestamp > 0) {
            // Calculate offset: video duration - last chat message time
            const calculatedOffset = Math.floor(videoDuration - lastChatTimestamp);
            
            // Sanity check: offset should be reasonable (between -3600 and 3600 seconds = 1 hour)
            if (calculatedOffset >= -3600 && calculatedOffset <= 3600) {
                console.log(`Smart offset calculated: ${calculatedOffset}s (Video: ${videoDuration}s, Last chat: ${lastChatTimestamp}s)`);
                return calculatedOffset;
            } else {
                console.log(`Calculated offset ${calculatedOffset}s seems unreasonable, using fallback`);
            }
        }
    } catch (error) {
        console.error('Error calculating smart default offset:', error);
    }
    
    console.log(`Using fallback offset: ${fallbackOffset}s`);
    return fallbackOffset;
}

/**
 * Get current time offset
 */
function getTimeOffset() {
    if (config?.timeOffset !== undefined) {
        return config.timeOffset;
    }
    
    // If no config offset, calculate smart default
    return calculateSmartDefaultOffset();
}

/**
 * Get chat data URL based on environment
 */
function getChatUrl(videoId) {
    const environment = config?.environment || 'production';

    if (environment === 'production') {
        return `https://lekkerspeuren.nl/chats/chat_${videoId}.json`;
    } else {
        // Local development
        return `http://127.0.0.1:3000/chat_${videoId}.json`;
    }
}

/**
 * Check if the current video is a Lekker Spelen video
 */
function isLekkerSpelen() {
    // First check if we have chat data for this video (from yt-ttv.json or manual link)
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get("v");

    if (videoId && ttvLink && ttvLink[videoId]) {
        return true; // We have chat data for this video (either mapped or manually linked)
    }

    // Check channel name for Lekker Spelen (more reliable than title)
    const channelElement = document.querySelector('#channel-name a, .ytd-channel-name a, ytd-video-owner-renderer a');
    const channelName = channelElement ? channelElement.textContent.toLowerCase().trim() : '';

    const lekkerIndicators = [
        'lekker spelen',
        'lekker-spelen',
        'lekkerspelen'
    ];

    // Only check channel name, not title (title can have false positives)
    const isLekkerChannel = lekkerIndicators.some(indicator =>
        channelName.includes(indicator)
    );

    return isLekkerChannel;
}

/**
 * Handle messages from popup and other parts of extension
 */
function handleMessage(request, sender, sendResponse) {
    console.log('Received message:', request);

    switch (request.action) {
        case 'updateSettings':
            const oldOffset = config?.timeOffset;
            config = { ...config, ...request.settings };
            console.log('Settings updated:', config);

            // If offset changed and chat is active, refresh the chat display
            if (oldOffset !== config.timeOffset && isActive && video) {
                refreshChatWithNewOffset();
            }

            sendResponse({ success: true });
            break;

        case 'resetChat':
            cleanup();
            if (config?.enableSync) {
                setTimeout(init, 100);
            }
            sendResponse({ success: true });
            break;

        case 'getStatus':
            const lekkerSpelen = isLekkerSpelen();
            sendResponse({
                status: isActive,
                message: isActive ? 'Chat gesynchroniseerd' : 
                        (isManualLinkMode ? 'Wacht op Twitch VOD link' :
                        (lekkerSpelen ? 'Chat niet gesynchroniseerd' : 'Geen Lekker Spelen video')),
                isLekkerSpelen: lekkerSpelen,
                isManualLinkMode: isManualLinkMode,
                pendingVideoId: pendingVideoId,
                config: config
            });
            break;

        case 'linkTwitchVOD':
            const youtubeVideoId = request.youtubeVideoId || pendingVideoId;
            const twitchVodId = request.twitchVodId;
            
            if (!youtubeVideoId) {
                sendResponse({ success: false, error: 'No YouTube video ID provided' });
                break;
            }
            
            if (!twitchVodId) {
                sendResponse({ success: false, error: 'No Twitch VOD ID provided' });
                break;
            }
            
            // Temporarily add to mapping
            if (!ttvLink) ttvLink = {};
            ttvLink[youtubeVideoId] = twitchVodId;
            
            // Save to local storage for future visits
            (async () => {
                try {
                    const stored = await browserAPI.storage.local.get({ manualLinks: {} });
                    const manualLinks = stored.manualLinks || {};
                    manualLinks[youtubeVideoId] = twitchVodId;
                    await browserAPI.storage.local.set({ manualLinks: manualLinks });
                    console.log('Saved manual link to storage:', youtubeVideoId, '->', twitchVodId);
                    
                    // Reset mode flags if they were set
                    if (isManualLinkMode && pendingVideoId === youtubeVideoId) {
                        isManualLinkMode = false;
                        pendingVideoId = null;
                    }
                    
                    // Reinitialize with the new mapping
                    await init();
                    sendResponse({ success: true, message: 'Chat linked successfully', videoId: youtubeVideoId });
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
            })();
            
            return true; // Async response

        case 'removeManualLink':
            const videoIdToRemove = request.youtubeVideoId;
            
            if (!videoIdToRemove) {
                sendResponse({ success: false, error: 'No YouTube video ID provided' });
                break;
            }
            
            // Remove from storage
            (async () => {
                try {
                    const stored = await browserAPI.storage.local.get({ manualLinks: {} });
                    const manualLinks = stored.manualLinks || {};
                    
                    if (manualLinks[videoIdToRemove]) {
                        delete manualLinks[videoIdToRemove];
                        await browserAPI.storage.local.set({ manualLinks: manualLinks });
                        console.log('Removed manual link from storage:', videoIdToRemove);
                        
                        // Remove from current mapping
                        if (ttvLink && ttvLink[videoIdToRemove]) {
                            delete ttvLink[videoIdToRemove];
                        }
                        
                        // Clean up and restore YouTube chat
                        cleanup();
                        
                        sendResponse({ success: true, message: 'Manual link removed successfully' });
                    } else {
                        sendResponse({ success: false, error: 'No manual link found for this video' });
                    }
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
            })();
            
            return true; // Async response

        case 'getCurrentTime':
            if (video) {
                sendResponse({ currentTime: video.currentTime });
            } else {
                sendResponse({ error: 'No video element found' });
            }
            break;

        case 'checkLekkerSpelen':
            sendResponse({ isLekkerSpelen: isLekkerSpelen() });
            break;

        default:
            sendResponse({ error: 'Unknown action' });
    }

    // Return true to indicate that the response is sent asynchronously
    return true;
}

/**
 * Refresh chat display when offset changes
 */
function refreshChatWithNewOffset() {
    if (!video || !chatData || !messageList) return;

    console.log('Refreshing chat with new offset:', getTimeOffset());

    // Clear current messages
    shownMessages.clear();
    messageList.innerHTML = "";

    // Reset last second to force recalculation
    lastSecond = -1;

    // Show appropriate messages for current video time
    const currentSecond = Math.floor(video.currentTime);
    showPreviousMessages(currentSecond);
}

/**
 * Load offset data from GitHub and apply to config
 */
async function loadAndApplyOffsetData(videoId) {
    try {
        console.log('Loading offset data from GitHub for video:', videoId);

        const response = await fetch('https://raw.githubusercontent.com/hbo-nerds/lekker-chat/master/data/timedata.json', {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (response.ok) {
            const offsetData = await response.json();
            console.log('Successfully loaded offset data from GitHub');

            if (offsetData && offsetData[videoId]) {
                const suggestedOffset = offsetData[videoId];
                console.log('Found suggested offset for this video:', suggestedOffset, 'seconds');

                // Update config with suggested offset
                if (!config) {
                    await initConfig();
                }
                config.timeOffset = suggestedOffset;

                // Also save to storage so popup shows the correct value
                await browserAPI.storage.local.set({ timeOffset: suggestedOffset });

                console.log('Applied suggested offset:', suggestedOffset);
            } else {
                console.log('No offset data found for this video');
            }
        } else {
            console.log('GitHub offset data returned status:', response.status);
        }
    } catch (error) {
        console.log('Could not load offset data from GitHub:', error.message);
    }
}

/**
 * Initialize the extension and start chat synchronization
 */
const init = async () => {
    try {
        console.log('Initializing Twitch chat sync...');

        // Initialize config first if not already done
        if (!config) {
            await initConfig();
        }

        // Load YouTube to Twitch video mapping first
        if (!ttvLink) {
            const ttvLinkResponse = await fetch(browserAPI.getURL("data/yt-ttv.json"));
            if (!ttvLinkResponse.ok) {
                throw new Error('Failed to load video mapping data');
            }
            ttvLink = await ttvLinkResponse.json();
        }

        // Check for manual links in storage
        const stored = await browserAPI.storage.local.get({ manualLinks: {} });
        if (stored.manualLinks) {
            // Merge manual links into ttvLink
            ttvLink = { ...ttvLink, ...stored.manualLinks };
            console.log('Loaded manual links from storage');
        }

        // Get current YouTube video ID
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get("v");

        // Check if it's a Lekker Spelen video (now ttvLink is loaded)
        const lekkerSpelen = isLekkerSpelen();
        console.log('Is Lekker Spelen video:', lekkerSpelen);

        if (!lekkerSpelen) {
            console.log('Not a Lekker Spelen video - keeping original YouTube chat');
            isActive = false;
            return;
        }

        if (!videoId || !ttvLink[videoId]) {
            console.log(`No Twitch chat data available for video ID: ${videoId || 'none'}`);
            
            // Enable manual link mode
            isManualLinkMode = true;
            pendingVideoId = videoId;
            isActive = false;
            
            // Don't cleanup - leave YouTube chat intact
            console.log('Manual link mode enabled - waiting for user to link Twitch VOD');
            return;
        }

        console.log(`Found mapping for video ${videoId} -> Twitch ${ttvLink[videoId]}`);

        // Load offset data from GitHub and apply if found
        await loadAndApplyOffsetData(videoId);

        // Load image/emote data if not already loaded
        if (!imageData) {
            const imageResponse = await fetch(browserAPI.getURL("data/image_ids.json"));
            if (!imageResponse.ok) {
                throw new Error('Failed to load image data');
            }
            imageData = await imageResponse.json();
        }

        // Load chat data via background script (to bypass CORS)
        const chatUrl = getChatUrl(ttvLink[videoId]);
        console.log('Fetching chat data from:', chatUrl);
        
        const chatResponse = await chrome.runtime.sendMessage({
            action: 'fetchChatData',
            url: chatUrl
        });
        
        if (!chatResponse.success) {
            throw new Error(`Failed to load chat data from ${chatUrl}: ${chatResponse.error}`);
        }
        
        chatData = chatResponse.data;

        console.log(`Loaded chat data with ${chatData.comments?.length || 0} messages`);

        // Only proceed with injection if we have valid chat data
        if (!chatData || !chatData.comments || chatData.comments.length === 0) {
            console.log('No valid chat data to display');
            isActive = false;
            return;
        }

        // Initialize UI and video sync - chat will only inject if conditions are met
        console.log('About to wait for chat container...');
        await waitForChatContainer();
        console.log('Chat container ready, setting up video sync...');
        await onVideoReady();

        isActive = true;
        console.log('Twitch chat sync initialized successfully');
    } catch (error) {
        console.error('Failed to initialize Twitch chat sync:', error);
        console.error('Error stack:', error.stack);
        isActive = false;
    }
};

/**
 * Clean up intervals and reset state
 */
/**
 * Clean up intervals and reset state
 */
function cleanup() {
    console.log('Cleaning up extension state...');
    
    if (shownMessages) {
        shownMessages.clear();
    }

    // Remove the active class
    const chatContainerParent = document.querySelector("#chat-container");
    if (chatContainerParent) {
        chatContainerParent.classList.remove("lekker-chat-active");
    }

    // Restore original YouTube chat if we saved it
    if (messageList && messageList.parentNode) {
        const chatContainer = messageList.parentNode;
        try {
            if (originalChatContent) {
                chatContainer.innerHTML = originalChatContent;
                console.log('Restored original YouTube chat');
                originalChatContent = null;
            } else {
                messageList.remove();
                console.log('Removed injected message list');
            }
        } catch (e) {
            console.error('Error restoring chat:', e);
        }
        messageList = null;
    }
    
    // Clean up chat header
    if (chatHeader && chatHeader.parentNode) {
        chatHeader.remove();
        chatHeader = null;
    }
    
    // Reset collapse state
    isChatCollapsed = false;

    if (videoInterval) {
        clearInterval(videoInterval);
        videoInterval = null;
    }

    lastSecond = -1;
    video = null;
    isActive = false;
    chatData = null;
    
    // Don't reset manual link mode during cleanup
    // It should persist until a link is provided or page changes
}

// Set up message listener
if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener(handleMessage);
} else if (typeof browser !== 'undefined' && browser.runtime) {
    browser.runtime.onMessage.addListener(handleMessage);
}

// Handle fullscreen changes
document.addEventListener('fullscreenchange', () => {
    console.log('Fullscreen state changed');
    if (!document.fullscreenElement) {
        // Exited fullscreen - scroll to bottom after a short delay
        setTimeout(() => {
            if (messageList && isActive) {
                console.log('Scrolling to bottom after exiting fullscreen');
                scrollToBottom();
            }
        }, 500);
    }
});

// Also handle webkit fullscreen (Safari)
document.addEventListener('webkitfullscreenchange', () => {
    console.log('Webkit fullscreen state changed');
    if (!document.webkitFullscreenElement) {
        setTimeout(() => {
            if (messageList && isActive) {
                console.log('Scrolling to bottom after exiting webkit fullscreen');
                scrollToBottom();
            }
        }, 500);
    }
});

// Initialize the extension
(async () => {
    await initConfig();

    if (config?.enableSync !== false) {
        await init();
    }
})();

// Monitor URL changes for YouTube navigation
// Monitor URL changes for YouTube navigation
let lastUrl = location.href;
setInterval(async () => {
    if (location.href !== lastUrl) {
        console.log('URL changed, reinitializing...');
        const wasActive = isActive;
        lastUrl = location.href;
        
        // Only cleanup if we were previously active
        if (wasActive) {
            cleanup();
        }

        if (config?.enableSync !== false) {
            await init();
        }
    }
}, CONSTANTS.URL_CHECK_INTERVAL);