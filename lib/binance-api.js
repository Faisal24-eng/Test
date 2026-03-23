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
 * @param {string} symbol - Trading pair
 * @param {string} interval - Kline interval
 * @param {number} startTime - Start timestamp in ms
 * @param {number} endTime - End timestamp in ms
 * @param {string} marketType - 'spot' or 'perpetual'
 * @param {function} onProgress - Progress callback (current, total)
 * @returns {Promise<Array>} - All OHLCV data in range
 */
async function fetchHistoricalOHLCV(symbol, interval, startTime, endTime, marketType = 'perpetual', onProgress = null) {
    const allData = [];
    const chunkSize = 1000;
    const delayMs = 100; // Delay between requests to avoid rate limiting

    // Calculate interval in milliseconds
    const intervalMs = getIntervalMs(interval);
    const totalCandles = Math.ceil((endTime - startTime) / intervalMs);
    const totalChunks = Math.ceil(totalCandles / chunkSize);

    let currentStart = startTime;
    let chunkIndex = 0;

    while (currentStart < endTime) {
        const chunkEnd = Math.min(currentStart + (chunkSize * intervalMs), endTime);

        try {
            const chunk = await fetchOHLCV(symbol, interval, chunkSize, marketType, currentStart, chunkEnd);
            allData.push(...chunk);

            if (onProgress) {
                onProgress(chunkIndex + 1, totalChunks);
            }

            // Move start time forward
            if (chunk.length > 0) {
                currentStart = chunk[chunk.length - 1].timestamp + intervalMs;
            } else {
                currentStart = chunkEnd;
            }

            chunkIndex++;

            // Delay between requests
            if (currentStart < endTime) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        } catch (error) {
            console.error(`Error fetching chunk ${chunkIndex}:`, error);
            // Wait longer on error
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // Remove duplicates and sort
    const uniqueData = removeDuplicates(allData);
    return uniqueData.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Convert interval string to milliseconds
 * @param {string} interval - Interval string (e.g., '1m', '5m', '1h')
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

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        fetchOHLCV,
        fetchOrderBook,
        fetchHistoricalOHLCV,
        getIntervalMs,
        toCSV,
        getCommonPairs,
        getIntervals
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
    getIntervals
};
