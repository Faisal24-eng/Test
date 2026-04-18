/**
 * EventBus for Web App
 * Replaces chrome.runtime.sendMessage and onMessage
 */
class EventBus {
    constructor() {
        this.listeners = {};
    }

    addListener(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    removeListener(event, callback) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }

    emit(event, data) {
        if (!this.listeners[event]) return;
        this.listeners[event].forEach(cb => {
            try {
                cb(data);
            } catch (e) {
                console.error('Error in EventBus listener:', e);
            }
        });
    }

    /**
     * Replaces chrome.runtime.sendMessage that expects a response
     */
    async sendMessage(message, timeoutMs = 30000) {
        return new Promise((resolve) => {
            let timeout = null;
            if (timeoutMs > 0) {
                timeout = setTimeout(() => {
                    console.warn('[EventBus] sendMessage timeout for action:', message.action);
                    resolve({ success: false, error: 'timeout' });
                }, timeoutMs);
            }

            // Emulate background message handling
            this.emit('message', {
                message,
                sendResponse: (response) => {
                    if (timeout) clearTimeout(timeout);
                    resolve(response);
                }
            });
        });
    }

    /**
     * Add background listener
     */
    onMessage(callback) {
        this.addListener('message', ({ message, sendResponse }) => {
            callback(message, {}, sendResponse);
        });
    }

    /**
     * Broadcast to popup (UI)
     */
    broadcastToUI(message) {
        this.emit('broadcast', message);
    }

    /**
     * Listen to broadcast from background
     */
    onBroadcast(callback) {
        this.addListener('broadcast', callback);
    }
}

export const eventBus = new EventBus();
