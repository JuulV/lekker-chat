/**
 * Background service worker for LekkerChat
 * Handles CORS-restricted fetches
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchChatData') {
        // Fetch chat data from lekkerspeuren.nl (bypasses CORS in background)
        fetch(request.url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                return response.json();
            })
            .then(data => {
                sendResponse({ success: true, data: data });
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message });
            });
        
        // Return true to indicate we'll send response asynchronously
        return true;
    }
});

console.log('LekkerChat background service worker loaded');
