// ================================================
// NEXUS TRADING TERMINAL - BINANCE API CLIENT
// ================================================

/**
 * Binance API client for fetching OHLCV and Order Book data
 */

const BINANCE_SPOT_BASE = 'https://api.binance.com';
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';

/**
 * Fetch OHLCV data from Binance
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {string} interval - Kline interval (e.g., '1m', '5m', '1h')
 * @param {number} limit - Number of candles (max 1500)
 * @param {string} marketType - 'spot' or 'perpetual'
 * @param {number} startTime - Optional start time in ms
 * @param {number} endTime - Optional end time in ms
 * @returns {Promise<Array>} - Array of OHLCV data
 */
async function fetchOHLCV(symbol, interval = '1m', limit = 500, marketType = 'perpetual', startTime = null, endTime = null) {
    try {
        let url;

        if (marketType === 'perpetual') {
            // Futures/Perpetual endpoint
            url = `${BINANCE_FUTURES_BASE}/fapi/v1/continuousKlines?pair=${symbol}&contractType=PERPETUAL&interval=${interval}&limit=${limit}`;
        } else {
            // Spot endpoint
            url = `${BINANCE_SPOT_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        }

        if (startTime) url += `&startTime=${startTime}`;
        if (endTime) url += `&endTime=${endTime}`;

        const response = await fetch(url);

        if (!response.ok) {
            // Detailed error logging
            const text = await response.text();
            console.error(`Binance API Error (${response.status}): ${text} [URL: ${url}]`);
            throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
            console.error('Binance API returned invalid data format:', data);
            throw new Error('Invalid data format from Binance API');
        }

        // Transform to standard OHLCV format
        return data.map(candle => ({
            timestamp: candle[0],
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5]),
            closeTime: candle[6],
            quoteVolume: parseFloat(candle[7]),
            trades: candle[8],
            takerBuyBase: parseFloat(candle[9]),
            takerBuyQuote: parseFloat(candle[10])
        }));
    } catch (error) {
        console.error('Error fetching OHLCV:', error);
        throw error;
    }
}

/**
 * Fetch Order Book data from Binance
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {number} limit - Depth limit (5, 10, 20, 50, 100, 500, 1000)
 * @param {string} marketType - 'spot' or 'perpetual'
 * @param {number} aggregation - Price aggregation level (0 = none, 0.1, 1, 10, 100, etc.)
 * @returns {Promise<object>} - Order book data with bids and asks
 */
async function fetchOrderBook(symbol, limit = 100, marketType = 'perpetual', aggregation = 0) {
    try {
        let url;

        if (marketType === 'perpetual') {
            url = `${BINANCE_FUTURES_BASE}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`;
        } else {
            url = `${BINANCE_SPOT_BASE}/api/v3/depth?symbol=${symbol}&limit=${limit}`;
        }

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        // Parse raw data
        let bids = data.bids.map(([price, quantity]) => ({
            price: parseFloat(price),
            quantity: parseFloat(quantity)
        }));
        let asks = data.asks.map(([price, quantity]) => ({
            price: parseFloat(price),
            quantity: parseFloat(quantity)
        }));

        // Apply aggregation if specified
        if (aggregation > 0) {
            bids = aggregateOrderBookSide(bids, aggregation, 'bid');
            asks = aggregateOrderBookSide(asks, aggregation, 'ask');
        }

        // Transform to structured format
        return {
            lastUpdateId: data.lastUpdateId,
            timestamp: Date.now(),
            aggregation: aggregation,
            bids: bids,
            asks: asks,
            // Calculate totals
            totalBidVolume: bids.reduce((sum, b) => sum + b.quantity, 0),
            totalAskVolume: asks.reduce((sum, a) => sum + a.quantity, 0)
        };
    } catch (error) {
        console.error('Error fetching Order Book:', error);
        throw error;
    }
}

/**
 * Aggregate order book side by price level
 * @param {Array} orders - Array of {price, quantity} objects
 * @param {number} aggregation - Price aggregation level
 * @param {string} side - 'bid' or 'ask'
 * @returns {Array} - Aggregated orders
 */
function aggregateOrderBookSide(orders, aggregation, side) {
    const aggregated = new Map();

    for (const order of orders) {
        // Round price to aggregation level
        // For bids: round down, for asks: round up
        let roundedPrice;
        if (side === 'bid') {
            roundedPrice = Math.floor(order.price / aggregation) * aggregation;
        } else {
            roundedPrice = Math.ceil(order.price / aggregation) * aggregation;
        }

        // Accumulate quantity at this price level
        if (aggregated.has(roundedPrice)) {
            aggregated.set(roundedPrice, aggregated.get(roundedPrice) + order.quantity);
        } else {
            aggregated.set(roundedPrice, order.quantity);
        }
    }

    // Convert back to array and sort
    const result = Array.from(aggregated.entries()).map(([price, quantity]) => ({
        price,
        quantity
    }));

    // Sort: bids descending (highest first), asks ascending (lowest first)
    if (side === 'bid') {
        result.sort((a, b) => b.price - a.price);
    } else {
        result.sort((a, b) => a.price - b.price);
    }

    return result;
}

/**
 * Fetch historical OHLCV data in chunks for backtesting
 * Fetch historical data for a symbol
 */
async function fetchHistoricalOHLCV(symbol, interval, startTime, endTime, marketType = 'perpetual', onProgress = null) {
    let allKlines = [];
    let currentStart = startTime;
    const intervalMs = getIntervalMs(interval);
    const limit = 1000; // Binance max per request

    console.log(`[Binance] Fetching History: ${symbol} ${interval} from ${new Date(startTime).toLocaleString()} to ${new Date(endTime).toLocaleString()}`);

    while (currentStart < endTime) {
        const klines = await fetchOHLCV(symbol, interval, limit, marketType, currentStart, endTime);
        if (!klines || klines.length === 0) break;

        allKlines = allKlines.concat(klines);
        
        // Next chunk starts after the last candle received
        const lastCandleTime = klines[klines.length - 1].timestamp;
        if (lastCandleTime <= currentStart) break; // Avoid infinite loop
        currentStart = lastCandleTime + intervalMs;

        if (onProgress) {
            const totalRange = endTime - startTime;
            const currentProgress = ((currentStart - startTime) / totalRange) * 100;
            onProgress(allKlines.length, Math.ceil(totalRange / intervalMs));
        }

        // Small delay to respect rate limits
        await new Promise(r => setTimeout(r, 100));
    }

    return allKlines;
}

/**
 * Convert interval string to milliseconds
 * @param {string} interval - Interval string (e.g., '1m', '5m', '1h')
 * @returns {number} - Interval in milliseconds
 */
function getIntervalMs(interval) {
    if (!interval || typeof interval !== 'string') return 60000;
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
 * Remove duplicate candles by timestamp
 * @param {Array} data - OHLCV data array
 * @returns {Array} - Deduplicated array
 */
function removeDuplicates(data) {
    const seen = new Set();
    return data.filter(candle => {
        if (seen.has(candle.timestamp)) {
            return false;
        }
        seen.add(candle.timestamp);
        return true;
    });
}

/**
 * Convert OHLCV data to CSV format
 * @param {Array} data - OHLCV data array
 * @returns {string} - CSV string
 */
function toCSV(data) {
    const headers = 'timestamp,open,high,low,close,volume,closeTime,quoteVolume,trades\n';
    const rows = data.map(d =>
        `${d.timestamp},${d.open},${d.high},${d.low},${d.close},${d.volume},${d.closeTime},${d.quoteVolume},${d.trades}`
    ).join('\n');

    return headers + rows;
}

/**
 * Get available trading pairs (common perpetuals)
 * @returns {Array<string>}
 */
function getCommonPairs() {
    return [
        'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
        'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT',
        'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'ETCUSDT', 'XLMUSDT',
        'FILUSDT', 'TRXUSDT', 'NEARUSDT', 'ALGOUSDT', 'VETUSDT'
    ];
}

/**
 * Get available intervals
 * @returns {Array<object>}
 */
function getIntervals() {
    return [
        { value: '1s', label: '1 Second' },
        { value: '1m', label: '1 Minute' },
        { value: '3m', label: '3 Minutes' },
        { value: '5m', label: '5 Minutes' },
        { value: '15m', label: '15 Minutes' },
        { value: '30m', label: '30 Minutes' },
        { value: '1h', label: '1 Hour' },
        { value: '2h', label: '2 Hours' },
        { value: '4h', label: '4 Hours' },
        { value: '1d', label: '1 Day' }
    ];
}

/**
 * Binance WebSocket Manager
 * Handles real-time kline and depth streams with auto-reconnect
 */
class BinanceWebSocketClient {
    constructor() {
        this.socket = null;
        this.url = '';
        this.pingInterval = null;
        this.reconnectTimer = null;
        this.isReconnecting = false;
        
        // Callbacks
        this.onKline = null;
        this.onDepth = null;
        this.onError = null;
    }

    /**
     * Check if socket is open
     */
    get isConnected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    /**
     * Connect to multiplexed streams
     * @param {string} symbol - Trading pair (e.g., 'btcusdt')
     * @param {string} interval - Kline interval (e.g., '1m')
     * @param {string} marketType - 'spot' or 'perpetual'
     */
    connect(symbol, interval = '1m', marketType = 'perpetual') {
        this.disconnect();

        const s = symbol.toLowerCase();
        // Streams: klines and 20-level order book (100ms updates)
        const streams = `${s}@kline_${interval}/${s}@depth20@100ms`;

        if (marketType === 'perpetual') {
            this.url = `wss://fstream.binance.com/stream?streams=${streams}`;
        } else {
            this.url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
        }

        console.log(`[Binance WS] Connecting to ${this.url}`);
        this.initSocket();
    }

    initSocket() {
        try {
            this.socket = new WebSocket(this.url);

            this.socket.onopen = () => {
                console.log('[Binance WS] Connected');
                this.isReconnecting = false;
                if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            };

            this.socket.onmessage = (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    if (!payload.data) return;

                    const stream = payload.stream;
                    const data = payload.data;

                    if (stream.includes('@kline') && this.onKline) {
                        this.onKline(this._formatKline(data.k));
                    } else if (stream.includes('@depth') && this.onDepth) {
                        this.onDepth(this._formatDepth(data));
                    }
                } catch (e) {
                    console.error('[Binance WS] Message parsing error:', e);
                }
            };

            this.socket.onclose = () => {
                console.log('[Binance WS] Connection closed');
                this.triggerReconnect();
            };

            this.socket.onerror = (error) => {
                console.error('[Binance WS] Error:', error);
                if (this.onError) this.onError(error);
            };

        } catch (error) {
            console.error('[Binance WS] Initialization error:', error);
            this.triggerReconnect();
        }
    }

    triggerReconnect() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        console.log('[Binance WS] Attempting reconnect in 3s...');
        this.reconnectTimer = setTimeout(() => {
            if (this.url) this.initSocket();
        }, 3000);
    }

    disconnect() {
        if (this.socket) {
            this.url = ''; // Prevent auto-reconnect
            this.socket.close();
            this.socket = null;
        }
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    }

    _formatKline(k) {
        return {
            timestamp: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            closeTime: k.T,
            quoteVolume: parseFloat(k.q),
            trades: k.n,
            isClosed: k.x
        };
    }

    _formatDepth(data) {
        return {
            lastUpdateId: data.u || data.lastUpdateId,
            timestamp: data.E || Date.now(),
            bids: data.b.map(b => ({ price: parseFloat(b[0]), quantity: parseFloat(b[1]) })),
            asks: data.a.map(a => ({ price: parseFloat(a[0]), quantity: parseFloat(a[1]) }))
        };
    }
}

// Singleton WS Manager
const wsClient = new BinanceWebSocketClient();

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        fetchOHLCV,
        fetchOrderBook,
        fetchHistoricalOHLCV,
        getIntervalMs,
        toCSV,
        getCommonPairs,
        getIntervals,
        wsClient,
        BinanceWebSocketClient
    };
}

// Export for ES modules
export {
    fetchOHLCV,
    fetchOrderBook,
    fetchHistoricalOHLCV,
    getIntervalMs,
    toCSV,
    getCommonPairs,
    getIntervals,
    wsClient,
    BinanceWebSocketClient
};
