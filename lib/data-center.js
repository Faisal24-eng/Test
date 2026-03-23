// ================================================
// NEXUS TRADING TERMINAL - DATA CENTER
// ================================================

/**
 * Data Center manages OHLCV and Order Book data for both markets
 * Handles rolling data updates and multi-timeframe aggregation
 */

import * as BinanceAPI from './binance-api.js';

class DataCenter {
    constructor() {
        this.markets = {
            1: {
                ohlcv: [],
                orderbook: null,
                config: null,
                lastOhlcvFetch: null,
                lastOrderbookFetch: null
            },
            2: {
                ohlcv: [],
                orderbook: null,
                config: null,
                lastOhlcvFetch: null,
                lastOrderbookFetch: null
            }
        };

        // No internal timers anymore - driven by Service Worker alarms
        this.listeners = [];

        // Rate limiting: minimum time between any API calls (ms)
        this.minRequestInterval = 200;
        this.lastRequestTime = 0;
    }

    /**
     * Add listener for data updates
     * @param {function} callback - Called on data update
     */
    addListener(callback) {
        this.listeners.push(callback);
    }

    /**
     * Remove listener
     * @param {function} callback
     */
    removeListener(callback) {
        this.listeners = this.listeners.filter(l => l !== callback);
    }

    /**
     * Notify all listeners
     * @param {string} type - Update type
     * @param {number} market - Market number
     * @param {any} data - Updated data
     */
    notify(type, market, data) {
        this.listeners.forEach(callback => {
            try {
                callback({ type, market, data, timestamp: Date.now() });
            } catch (error) {
                console.error('Listener error:', error);
            }
        });
    }

    /**
     * Configure market data sources
     * @param {object} config - Data center configuration
     */
    configure(config) {
        if (config.market1) {
            this.markets[1].config = config.market1;
        }
        if (config.market2) {
            this.markets[2].config = config.market2;
        }
    }

    /**
     * Start data fetching
     * (Legacy signature kept for compatibility, but now effectively a no-op or initial fetch)
     */
    async start() {
        // Just do one initial fetch
        await this.fetchOneRound();
    }

    /**
     * Stop data fetching
     */
    stop() {
        // No internal timers to clear
    }

    /**
     * Fetch one round of data for all configured markets
     * Called by Service Worker alarm
     */
    async fetchOneRound() {
        // Stagger requests to avoid rate limits
        // We fetch Market 1 then Market 2

        // Market 1
        if (this.markets[1].config) {
            await this.fetchOHLCV(1);
            await this.delay(300);
            await this.fetchOrderBook(1);
            await this.delay(300);
        }

        // Market 2
        if (this.markets[2].config) {
            await this.fetchOHLCV(2);
            await this.delay(300);
            await this.fetchOrderBook(2);
        }
    }

    /**
     * Delay helper
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Wait for rate limit
     */
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
            await this.delay(this.minRequestInterval - timeSinceLastRequest);
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * Fetch OHLCV data for a market with retry logic
     * @param {number} marketNum - Market number (1 or 2)
     * @param {number} retryCount - Current retry attempt
     */
    async fetchOHLCV(marketNum, retryCount = 0) {
        const market = this.markets[marketNum];
        const config = market.config?.ohlcv;

        if (!config) return;

        // Wait for rate limit
        await this.waitForRateLimit();

        // OPTIMIZATION: Only fetch full history on first load
        // Subsequent fetches only need a few recent candles for rolling updates
        const isFirstFetch = market.ohlcv.length === 0;
        const fetchQuantity = isFirstFetch ? config.quantity : 10;

        try {
            const data = await BinanceAPI.fetchOHLCV(
                config.symbol,
                config.interval,
                fetchQuantity,
                config.marketType
            );

            // Update rolling data
            this.updateRollingOHLCV(marketNum, data);
            market.lastOhlcvFetch = Date.now();

            this.notify('ohlcv', marketNum, market.ohlcv);
        } catch (error) {
            // Handle rate limiting with exponential backoff
            if (error.message && error.message.includes('429') && retryCount < 3) {
                const backoffMs = Math.pow(2, retryCount) * 1000;
                console.warn(`Rate limited on OHLCV market ${marketNum}, retrying in ${backoffMs}ms...`);
                await this.delay(backoffMs);
                return this.fetchOHLCV(marketNum, retryCount + 1);
            }
            console.error(`Error fetching OHLCV for market ${marketNum}:`, error);
            this.notify('error', marketNum, { type: 'ohlcv', error: error.message });
        }
    }

    /**
     * Update rolling OHLCV data
     * @param {number} marketNum - Market number
     * @param {Array} newData - New OHLCV data
     */
    updateRollingOHLCV(marketNum, newData) {
        const market = this.markets[marketNum];
        const maxSize = market.config.ohlcv.quantity || 500;

        if (market.ohlcv.length === 0) {
            // First fetch - store all data
            market.ohlcv = newData;
        } else {
            // Update: merge new data with existing
            const existingTimestamps = new Set(market.ohlcv.map(c => c.timestamp));
            const newCandles = newData.filter(c => !existingTimestamps.has(c.timestamp));

            // Update last candle if it exists in both (real-time updates)
            if (newData.length > 0 && market.ohlcv.length > 0) {
                const lastNewCandle = newData[newData.length - 1];
                const lastExistingIdx = market.ohlcv.findIndex(c => c.timestamp === lastNewCandle.timestamp);

                if (lastExistingIdx !== -1) {
                    market.ohlcv[lastExistingIdx] = lastNewCandle;
                }
            }

            // Add new candles
            market.ohlcv.push(...newCandles);

            // Sort by timestamp
            market.ohlcv.sort((a, b) => a.timestamp - b.timestamp);

            // Trim to max size
            if (market.ohlcv.length > maxSize) {
                market.ohlcv = market.ohlcv.slice(-maxSize);
            }
        }
    }

    /**
     * Fetch Order Book for a market with retry logic
     * @param {number} marketNum - Market number (1 or 2)
     * @param {number} retryCount - Current retry attempt
     */
    async fetchOrderBook(marketNum, retryCount = 0) {
        const market = this.markets[marketNum];
        const config = market.config?.orderbook;

        if (!config) return;

        // Wait for rate limit
        await this.waitForRateLimit();

        try {
            const data = await BinanceAPI.fetchOrderBook(
                config.symbol,
                config.depth,
                config.marketType,
                config.aggregation || 0  // Pass aggregation level
            );

            // Replace order book (new data replaces old)
            market.orderbook = data;
            market.lastOrderbookFetch = Date.now();

            this.notify('orderbook', marketNum, market.orderbook);
        } catch (error) {
            // Handle rate limiting with exponential backoff
            if (error.message && error.message.includes('429') && retryCount < 3) {
                const backoffMs = Math.pow(2, retryCount) * 1000;
                console.warn(`Rate limited on Order Book market ${marketNum}, retrying in ${backoffMs}ms...`);
                await this.delay(backoffMs);
                return this.fetchOrderBook(marketNum, retryCount + 1);
            }
            console.error(`Error fetching Order Book for market ${marketNum}:`, error);
            this.notify('error', marketNum, { type: 'orderbook', error: error.message });
        }
    }

    /**
     * Get OHLCV data for a market
     * @param {number} marketNum - Market number
     * @returns {Array}
     */
    getOHLCV(marketNum) {
        return this.markets[marketNum].ohlcv;
    }

    /**
     * Get Order Book for a market
     * @param {number} marketNum - Market number
     * @returns {object|null}
     */
    getOrderBook(marketNum) {
        return this.markets[marketNum].orderbook;
    }

    /**
     * Get resampled OHLCV data for higher timeframes
     * @param {number} marketNum - Market number
     * @param {number} timeframeMinutes - Target timeframe in minutes
     * @returns {Array}
     */
    getResampledOHLCV(marketNum, timeframeMinutes) {
        const data = this.markets[marketNum].ohlcv;
        if (!data || data.length === 0) return [];

        const tfMs = timeframeMinutes * 60 * 1000;
        const resampled = [];
        let currentBar = null;

        for (const candle of data) {
            const barStart = Math.floor(candle.timestamp / tfMs) * tfMs;

            if (!currentBar || currentBar.timestamp !== barStart) {
                if (currentBar) {
                    resampled.push(currentBar);
                }
                currentBar = {
                    timestamp: barStart,
                    open: candle.open,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                    volume: candle.volume
                };
            } else {
                currentBar.high = Math.max(currentBar.high, candle.high);
                currentBar.low = Math.min(currentBar.low, candle.low);
                currentBar.close = candle.close;
                currentBar.volume += candle.volume;
            }
        }

        if (currentBar) {
            resampled.push(currentBar);
        }

        return resampled;
    }

    /**
     * Get latest candle
     * @param {number} marketNum - Market number
     * @returns {object|null}
     */
    getLatestCandle(marketNum) {
        const ohlcv = this.markets[marketNum].ohlcv;
        return ohlcv.length > 0 ? ohlcv[ohlcv.length - 1] : null;
    }

    /**
     * Get current state for storage
     * @returns {object}
     */
    getState() {
        return {
            market1: {
                ohlcv: this.markets[1].ohlcv,
                orderbook: this.markets[1].orderbook,
                lastOhlcvFetch: this.markets[1].lastOhlcvFetch,
                lastOrderbookFetch: this.markets[1].lastOrderbookFetch
            },
            market2: {
                ohlcv: this.markets[2].ohlcv,
                orderbook: this.markets[2].orderbook,
                lastOhlcvFetch: this.markets[2].lastOhlcvFetch,
                lastOrderbookFetch: this.markets[2].lastOrderbookFetch
            },
            // Note: isRunning is managed by Service Worker state now
        };
    }

    /**
     * Restore state from storage
     * @param {object} state
     */
    restoreState(state) {
        if (state.market1) {
            this.markets[1].ohlcv = Array.isArray(state.market1.ohlcv) ? state.market1.ohlcv : [];
            this.markets[1].orderbook = state.market1.orderbook || null;
            this.markets[1].lastOhlcvFetch = state.market1.lastOhlcvFetch;
            this.markets[1].lastOrderbookFetch = state.market1.lastOrderbookFetch;
        }
        if (state.market2) {
            this.markets[2].ohlcv = Array.isArray(state.market2.ohlcv) ? state.market2.ohlcv : [];
            this.markets[2].orderbook = state.market2.orderbook || null;
            this.markets[2].lastOhlcvFetch = state.market2.lastOhlcvFetch;
            this.markets[2].lastOrderbookFetch = state.market2.lastOrderbookFetch;
        }
    }

    /**
     * Get minimal state for storage (reduced OHLCV for recovery)
     * @param {number} maxCandles - Maximum candles to persist (default 50)
     * @returns {object}
     */
    getMinimalState(maxCandles = 50) {
        const trimOHLCV = (arr) => arr.slice(-maxCandles);
        return {
            market1: {
                ohlcv: trimOHLCV(this.markets[1].ohlcv),
                orderbook: this.markets[1].orderbook,
                lastOhlcvFetch: this.markets[1].lastOhlcvFetch,
                lastOrderbookFetch: this.markets[1].lastOrderbookFetch
            },
            market2: {
                ohlcv: trimOHLCV(this.markets[2].ohlcv),
                orderbook: this.markets[2].orderbook,
                lastOhlcvFetch: this.markets[2].lastOhlcvFetch,
                lastOrderbookFetch: this.markets[2].lastOrderbookFetch
            }
        };
    }

    /**
     * Get lightweight state for frequent saves (excludes OHLCV)
     * OHLCV data will be re-fetched on service worker restart
     * @returns {object}
     */
    getLightweightState() {
        return {
            market1: {
                lastOhlcvFetch: this.markets[1].lastOhlcvFetch,
                lastOrderbookFetch: this.markets[1].lastOrderbookFetch
            },
            market2: {
                lastOhlcvFetch: this.markets[2].lastOhlcvFetch,
                lastOrderbookFetch: this.markets[2].lastOrderbookFetch
            }
        };
    }
}

// Singleton instance
const dataCenter = new DataCenter();

export default dataCenter;
export { DataCenter };
