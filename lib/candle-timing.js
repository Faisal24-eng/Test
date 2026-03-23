// ================================================
// NEXUS TRADING TERMINAL - CANDLE TIMING UTILITIES
// ================================================

/**
 * Candle timing utilities for synchronizing data fetches
 * with candle close times for accurate real-time data
 */

/**
 * Convert interval string to milliseconds
 * @param {string} interval - Interval string (e.g., '1m', '3m', '5m', '1h')
 * @returns {number} - Interval in milliseconds
 */
function getIntervalMs(interval) {
    const units = {
        's': 1000,
        'm': 60 * 1000,
        'h': 60 * 60 * 1000,
        'd': 24 * 60 * 60 * 1000,
        'w': 7 * 24 * 60 * 60 * 1000,
        'M': 30 * 24 * 60 * 60 * 1000
    };

    const match = interval.match(/^(\d+)([smhdwM])$/);
    if (!match) return 60000; // Default 1 minute

    const value = parseInt(match[1]);
    const unit = match[2];

    return value * (units[unit] || 60000);
}

/**
 * Get the timestamp of the next candle close
 * @param {string} interval - Candle interval (e.g., '1m', '3m')
 * @param {number} currentTime - Current timestamp in ms (default: Date.now())
 * @returns {number} - Timestamp of next candle close in ms
 */
function getNextCandleCloseTime(interval, currentTime = Date.now()) {
    const intervalMs = getIntervalMs(interval);
    
    // Candles are aligned to epoch time
    // Current candle started at: floor(currentTime / intervalMs) * intervalMs
    // Next candle close = current candle start + intervalMs
    const currentCandleStart = Math.floor(currentTime / intervalMs) * intervalMs;
    const nextCandleClose = currentCandleStart + intervalMs;
    
    return nextCandleClose;
}

/**
 * Get milliseconds until the next candle close
 * @param {string} interval - Candle interval (e.g., '1m', '3m')
 * @param {number} currentTime - Current timestamp in ms (default: Date.now())
 * @returns {number} - Milliseconds until next candle close
 */
function getMsUntilCandleClose(interval, currentTime = Date.now()) {
    const nextClose = getNextCandleCloseTime(interval, currentTime);
    return nextClose - currentTime;
}

/**
 * Get the shortest interval from market configurations
 * @param {object} config - Data center configuration with market1 and market2
 * @returns {string} - Shortest interval string
 */
function getShortestInterval(config) {
    const intervals = [];
    
    if (config?.market1?.ohlcv?.interval) {
        intervals.push(config.market1.ohlcv.interval);
    }
    if (config?.market2?.ohlcv?.interval) {
        intervals.push(config.market2.ohlcv.interval);
    }
    
    if (intervals.length === 0) {
        return '1m'; // Default
    }
    
    // Find shortest
    let shortestMs = Infinity;
    let shortestInterval = '1m';
    
    for (const interval of intervals) {
        const ms = getIntervalMs(interval);
        if (ms < shortestMs) {
            shortestMs = ms;
            shortestInterval = interval;
        }
    }
    
    return shortestInterval;
}

/**
 * Calculate fetch schedule times relative to candle close
 * @param {string} interval - Candle interval
 * @param {number} currentTime - Current timestamp in ms
 * @param {object} options - Timing options
 * @returns {object} - Schedule with preCloseMs, postCloseMs, nextCloseTime
 */
function calculateFetchSchedule(interval, currentTime = Date.now(), options = {}) {
    const {
        preCloseOffset = 500,   // Fetch 500ms before close
        postCloseOffset = 1000  // Fetch 1000ms after close
    } = options;
    
    const nextClose = getNextCandleCloseTime(interval, currentTime);
    const msUntilClose = nextClose - currentTime;
    
    return {
        nextCloseTime: nextClose,
        msUntilClose: msUntilClose,
        // Time until pre-close fetch (null if too late)
        preCloseFetchIn: msUntilClose > preCloseOffset ? msUntilClose - preCloseOffset : null,
        // Time until post-close fetch
        postCloseFetchIn: msUntilClose + postCloseOffset,
        // For logging
        preCloseOffset,
        postCloseOffset
    };
}

// Export for ES modules
export {
    getIntervalMs,
    getNextCandleCloseTime,
    getMsUntilCandleClose,
    getShortestInterval,
    calculateFetchSchedule
};
